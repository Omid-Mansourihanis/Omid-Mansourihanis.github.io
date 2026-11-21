// Shared by osm3d.html and google3d.html: palettes, data loading, legend, tooltip.
(function () {
  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

  // Ordinal palettes (A = free flow ... F = breakdown).
  const PALETTES = {
    // ColorBrewer RdYlGn-6: the green-to-red convention of traffic maps; matches the paper's Good/Medium/Poor colours.
    hcm: { name: 'Green → red (traffic convention)', A: '#1A9850', B: '#91CF60', C: '#D9EF8B', D: '#FEE08B', E: '#FC8D59', F: '#D73027' },
    // ColorBrewer RdYlBu-6: blue-to-red, readable with red-green colour-vision deficiency.
    cvd: { name: 'Blue → red (colour-blind safe)', A: '#4575B4', B: '#91BFDB', C: '#E0F3F8', D: '#FEE090', E: '#FC8D59', F: '#D73027' },
  };
  const CLASS3 = { Good: '#4CAF50', Medium: '#FFC107', Poor: '#E53935' };   // same as Figure 4 of the paper
  const NODATA = '#9E9E9E';
  const SPR_BREAKS = [25, 40, 55, 70, 85];   // Equation 1: F <=25 < E <=40 < D <=55 < C <=70 < B <=85 < A

  const MODES = {
    los6: 'LOS grade A–F (from SPR, Eq. 1)',
    los3: 'LOS 3 classes (Good / Medium / Poor)',
    ci:   'Congestion Index 1–6 (TomTom)',
    spr:  'Speed Performance Ratio, continuous (%)',
  };

  const class3Of = (l) => (l === 'A' || l === 'B') ? 'Good' : (l === 'C' || l === 'D') ? 'Medium' : (l === 'E' || l === 'F') ? 'Poor' : null;

  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function lerpHex(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return A.map((v, i) => Math.round(v + (B[i] - v) * t)); }

  // Colour of one feature as [r,g,b] (used by deck.gl). MapLibre uses the equivalent expressions below.
  function colorRgb(p, mode, pal) {
    const P = PALETTES[pal];
    if (p.x !== 0) return hexToRgb(NODATA);
    if (mode === 'los6') return hexToRgb(P[p.l] || NODATA);
    if (mode === 'los3') return hexToRgb(CLASS3[class3Of(p.l)] || NODATA);
    if (mode === 'ci') return hexToRgb(P[LETTERS[p.c - 1]] || NODATA);
    if (mode === 'spr') {
      if (p.s == null) return hexToRgb(NODATA);
      const stops = [25, 40, 55, 70, 85, 100], cols = ['F', 'E', 'D', 'C', 'B', 'A'].map((k) => P[k]);
      const s = Math.max(25, Math.min(100, p.s));
      for (let i = 0; i < stops.length - 1; i++) if (s <= stops[i + 1]) return lerpHex(cols[i], cols[i + 1], (s - stops[i]) / (stops[i + 1] - stops[i]));
      return hexToRgb(cols[5]);
    }
    return hexToRgb(NODATA);
  }

  // MapLibre style expression for the same colours.
  function colorExpression(mode, pal) {
    const P = PALETTES[pal];
    const L = ['coalesce', ['get', 'l'], 'NA'];
    let e;
    if (mode === 'los6') e = ['match', L, ...LETTERS.flatMap((k) => [k, P[k]]), NODATA];
    else if (mode === 'los3') e = ['match', L, ['A', 'B'], CLASS3.Good, ['C', 'D'], CLASS3.Medium, ['E', 'F'], CLASS3.Poor, NODATA];
    else if (mode === 'ci') e = ['match', ['coalesce', ['get', 'c'], 0], ...LETTERS.flatMap((k, i) => [i + 1, P[k]]), NODATA];
    else e = ['interpolate', ['linear'], ['coalesce', ['get', 's'], 0], 25, P.F, 40, P.E, 55, P.D, 70, P.C, 85, P.B, 100, P.A];
    return ['case', ['==', ['get', 'x'], 0], e, NODATA];
  }

  // Which LOS letters are visible (legend click toggles). 'NA' = blocks without probe data.
  function filterExpression(active) {
    return ['in', ['coalesce', ['get', 'l'], 'NA'], ['literal', [...active]]];
  }
  const isVisible = (p, active) => active.has(p.x === 0 ? p.l : 'NA');

  // Fetch a gzipped GeoJSON file and decompress it in the browser (works on any static host).
  async function loadCity(slug, cities) {
    const url = window.LOS_CONFIG.dataDir + cities[slug].file;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    let stream = res.body;
    const enc = res.headers.get('content-encoding') || '';
    if (!enc.includes('gzip')) stream = stream.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  async function loadCities() {
    const r = await fetch(window.LOS_CONFIG.dataDir + 'cities.json');
    return r.json();
  }

  function tooltipHtml(p, cityLabel) {
    const head = `<b>${cityLabel || ''}</b> · block ${p.g}`;
    if (p.x !== 0) {
      return `${head}<br><span style="color:#666">No LOS: ${p.x === 1 ? 'no probe observations' : 'missing outcome'} —
              missing data, not congestion</span>`;
    }
    const c3 = class3Of(p.l);
    return `${head}<br>LOS <b>${p.l}</b> (${c3})<br>Congestion Index <b>${p.c ?? '–'}</b> / 6<br>
            Speed Performance Ratio <b>${p.s ?? '–'}%</b>${p.s > 100 ? ' <span style="color:#666">(above free-flow reference)</span>' : ''}<br>Street length ${p.m ?? '–'} m`;
  }

  // Legend: one row per class with counts; clicking a row toggles it on the map.
  function renderLegend(el, mode, pal, city, active, onToggle) {
    const P = PALETTES[pal], cnt = city ? city.los_counts : {};
    let rows = [];
    if (mode === 'los6') rows = LETTERS.map((k) => ({ key: [k], color: P[k], label: `LOS ${k}`, n: cnt[k] || 0 }));
    else if (mode === 'los3') rows = [['Good', ['A', 'B']], ['Medium', ['C', 'D']], ['Poor', ['E', 'F']]]
      .map(([lab, ks]) => ({ key: ks, color: CLASS3[lab], label: `${lab} (${ks.join('–')})`, n: ks.reduce((s, k) => s + (cnt[k] || 0), 0) }));
    else if (mode === 'ci') rows = LETTERS.map((k, i) => ({ key: null, color: P[k], label: `CI ${i + 1}${i === 0 ? ' (least)' : i === 5 ? ' (most congested)' : ''}` }));
    else rows = [['> 85%', 'A'], ['70–85%', 'B'], ['55–70%', 'C'], ['40–55%', 'D'], ['25–40%', 'E'], ['≤ 25%', 'F']]
      .map(([lab, k]) => ({ key: null, color: P[k], label: `SPR ${lab}` }));
    rows.push({ key: ['NA'], color: NODATA, label: 'No probe data (not congestion)', n: city ? city.no_data : 0 });

    el.innerHTML = `<div class="lg-title">${MODES[mode]}</div>` + rows.map((r, i) => {
      const on = !r.key || r.key.every((k) => active.has(k));
      return `<div class="lg-row ${r.key ? 'clickable' : ''} ${on ? '' : 'off'}" data-i="${i}">
        <span class="sw" style="background:${r.color}"></span>${r.label}${r.n != null ? `<span class="n">${r.n.toLocaleString()}</span>` : ''}</div>`;
    }).join('') + (mode === 'los6' || mode === 'los3' ? '<div class="lg-hint">Click a row to hide/show it</div>' : '');
    el.querySelectorAll('.lg-row.clickable').forEach((d) => d.addEventListener('click', () => onToggle(rows[+d.dataset.i].key)));
  }

  function toggleKeys(active, keys) {
    const allOn = keys.every((k) => active.has(k));
    keys.forEach((k) => (allOn ? active.delete(k) : active.add(k)));
  }

  // Read/write ?city=…&mode=…&pal=… so a view can be shared by link.
  function urlState(defaults) {
    const q = new URLSearchParams(location.search), s = { ...defaults };
    for (const k of Object.keys(defaults)) if (q.get(k)) s[k] = q.get(k);
    return s;
  }
  function saveUrlState(s) {
    const q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(s)) q.set(k, v);
    history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
  }

  window.LOS = { LETTERS, PALETTES, CLASS3, NODATA, SPR_BREAKS, MODES, class3Of, hexToRgb, colorRgb, colorExpression,
    filterExpression, isVisible, loadCity, loadCities, tooltipHtml, renderLegend, toggleKeys, urlState, saveUrlState };
})();
