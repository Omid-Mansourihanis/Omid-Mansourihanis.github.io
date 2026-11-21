import { Viewer } from './scene.js';
import { computeLayout, defaultFrontage, frontageBounds, STREET_SIDE } from './geometry.js';

const DATA_URL = 'data/zoning-sari-alt-A.json';
const $ = (id) => document.getElementById(id);
const fa = (n, d = 1) => Number(n).toLocaleString('fa-IR', { maximumFractionDigits: d });
const sbText = (v) => (v == null ? 'ندارد' : `${fa(v)} م`);
const SIDE_FA = { N: 'شمال', S: 'جنوب', E: 'شرق', W: 'غرب' };

let DB;            // data
let viewer;
const S = {        // app state
  zone: null, sub: null, code: null, ai: 0, ri: 0, orient: 'north',
  area: null, ratio: 2, roadW: null, floorH: 3.2, anchor: 'auto',
  env: true, sb: true, nb: true, lbl: true,
};

/* ---------- data access ---------- */
const zoneOf = () => DB.zones.find((z) => z.id === S.zone);
const subOf = () => zoneOf().subzones.find((s) => s.id === S.sub);
const areaOf = () => subOf().areaClasses[S.ai];
const roadOf = () => areaOf().roads[S.ri];

const areaBounds = (ac) => ({ min: ac.min, max: ac.max != null ? ac.max - 1 : Math.max(ac.min * 2, ac.min + 500) });
const roadBounds = (rd) => ({ min: rd.min, max: rd.max != null ? (rd.max === rd.min ? rd.min : rd.max - 0.5) : rd.min + 20 });

/* ---------- URL hash ---------- */
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const num = (k) => (h.has(k) && !isNaN(+h.get(k)) ? +h.get(k) : null);
  return {
    zone: h.get('z'), sub: h.get('s'), code: h.get('c'), ai: num('a'), ri: num('r'), orient: h.get('o'),
    area: num('area'), ratio: num('ratio'), roadW: num('rw'), floorH: num('fh'), anchor: h.get('an'),
  };
}
function writeHash() {
  const h = new URLSearchParams({
    z: S.zone, s: S.sub, c: S.code, a: S.ai, r: S.ri, o: S.orient,
    area: Math.round(S.area), ratio: S.ratio.toFixed(3), rw: S.roadW, fh: S.floorH, an: S.anchor,
  });
  history.replaceState(null, '', '#' + h.toString());
}

/* ---------- state normalization (cascade) ---------- */
function normalize() {
  if (!DB.zones.some((z) => z.id === S.zone)) S.zone = DB.zones[0].id;
  const z = zoneOf();
  if (!z.subzones.some((s) => s.id === S.sub)) S.sub = z.subzones[0].id;
  const sub = subOf();
  if (!sub.codes.includes(S.code)) S.code = sub.codes[0];
  if (!(S.ai >= 0 && S.ai < sub.areaClasses.length)) S.ai = 0;
  const ac = areaOf();
  if (!(S.ri >= 0 && S.ri < ac.roads.length)) S.ri = 0;
  if (!STREET_SIDE[S.orient]) S.orient = 'north';
  const ab = areaBounds(ac);
  if (!(S.area >= ab.min && S.area <= ab.max)) S.area = ab.min;
  const rb = roadBounds(roadOf());
  if (!(S.roadW >= rb.min && S.roadW <= rb.max)) S.roadW = rb.min;
  S.ratio = Number.isFinite(S.ratio) && S.ratio > 0 ? Math.min(4, Math.max(0.5, S.ratio)) : 2;
  if (!(S.floorH >= 2.6 && S.floorH <= 6)) S.floorH = 3.2;
  if (!['auto', 'rear', 'street'].includes(S.anchor)) S.anchor = 'auto';
}

/* ---------- UI builders ---------- */
function chip(label, pressed, onClick, swatch) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  if (swatch) {
    const i = document.createElement('i');
    i.className = 'sw'; i.style.background = swatch;
    b.appendChild(i);
  }
  b.appendChild(document.createTextNode(label));
  b.addEventListener('click', onClick);
  return b;
}

function renderControls() {
  // 1. Zone
  const zc = $('zoneChips'); zc.replaceChildren();
  DB.zones.forEach((z) => zc.appendChild(chip(z.name, z.id === S.zone, () => {
    S.zone = z.id; S.sub = null; S.code = null; S.ai = 0; S.ri = 0; S.area = null; S.roadW = null;
    refresh(true);
  }, z.color)));

  // 2. Subzone: one option per code, grouped by rule group
  const sel = $('subzoneSelect'); sel.replaceChildren();
  zoneOf().subzones.forEach((s) => {
    const og = document.createElement('optgroup');
    og.label = s.name;
    s.codes.forEach((c) => {
      const o = document.createElement('option');
      o.value = `${s.id}|${c}`; o.textContent = `${c} — ${s.name}`;
      if (s.id === S.sub && c === S.code) o.selected = true;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  $('subzoneName').textContent = subOf().name;

  // 3. Area class
  const ac = $('areaChips'); ac.replaceChildren();
  subOf().areaClasses.forEach((a, i) => ac.appendChild(chip(`${a.label} م²`, i === S.ai, () => {
    S.ai = i; S.area = null;
    const prev = roadOf()?.label;
    const idx = subOf().areaClasses[i].roads.findIndex((r) => r.label === prev);
    S.ri = idx >= 0 ? idx : 0; S.roadW = null;
    refresh(true);
  })));
  $('subdivisionNote').textContent = subOf().subdivisionNote || '';

  // 4. Street width
  const rc = $('roadChips'); rc.replaceChildren();
  areaOf().roads.forEach((r, i) => rc.appendChild(chip(r.label, i === S.ri, () => {
    S.ri = i; S.roadW = null; refresh(false);
  })));

  // 5. Orientation
  document.querySelectorAll('#orientPad button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.o === S.orient ? 'true' : 'false'));

  // 6. Exact dimensions
  const ab = areaBounds(areaOf());
  Object.assign($('areaRange'), { min: ab.min, max: ab.max, value: S.area });
  $('areaVal').textContent = fa(S.area, 0);
  const fb = frontageBounds(S.area);
  const front = defaultFrontage(S.area, S.ratio);
  Object.assign($('frontRange'), { min: fb.min.toFixed(1), max: fb.max.toFixed(1), value: front.toFixed(1) });
  $('frontVal').textContent = fa(front);
  $('depthVal').textContent = fa(S.area / front);
  const rb = roadBounds(roadOf());
  Object.assign($('roadRange'), { min: rb.min, max: rb.max, value: S.roadW, disabled: rb.min === rb.max });
  $('roadVal').textContent = fa(S.roadW);
  $('floorH').value = S.floorH;
  $('anchorSelect').value = S.anchor;
}

/* ---------- results panel ---------- */
function renderResults(layout) {
  const sub = subOf(), ac = areaOf(), rd = roadOf();
  const prevRoad = ac.roads[S.ri - 1];
  const multi = layout.parts.length > 1;
  const p0 = layout.parts[0];
  const top = layout.parts[layout.parts.length - 1];

  const kpi = (v, t) => `<div class="kpi"><b>${v}</b><span>${t}</span></div>`;
  let html = `<h3><span class="code">${S.code}</span> — ${sub.name}</h3>`;
  html += `<div class="kpis">
    ${kpi(multi ? layout.parts.map((p) => fa(p.coverage) + '٪').join(' / ') : fa(p0.coverage) + '٪', 'حداکثر سطح اشغال')}
    ${kpi(multi ? layout.parts.map((p) => fa(p.floors)).join(' + ') : fa(p0.floors), 'حداکثر طبقات')}
    ${kpi(multi ? layout.parts.map((p) => fa(p.far) + '٪').join(' + ') : fa(p0.far) + '٪', 'حداکثر تراکم')}
  </div>`;

  html += '<table><tbody>';
  const row = (k, v) => { html += `<tr><td>${k}</td><td>${v}</td></tr>`; };
  row('رده مساحت (نصاب تفکیک)', `${ac.label} مترمربع`);
  row('رده عرض معبر', rd.label);
  row('موقعیت قطعه', DB.orientations[S.orient]);
  row('مساحت و ابعاد قطعه', `${fa(S.area, 0)} م² (بَر ${fa(layout.lot.frontage)} × عمق ${fa(layout.lot.depth)})`);

  layout.parts.forEach((p) => {
    if (multi) html += `<tr><td colspan="2" class="part-title">${p.name}</td></tr>`;
    row('سطح اشغال مجاز در این قطعه', `${fa(p.allowedArea, 0)} م²`);
    row('زیربنای کل مجاز (تراکم × مساحت)', `<b>${fa(p.gfaTable, 0)} م²</b>`);
    const startA = ac.min, endA = ac.max;
    const farX = p.floors * p.coverage / 100; // exact FAR, as in the table's floor-area columns
    row('زیربنای کل در ابتدای / انتهای بازه', `${fa(startA * farX, 0)} / ${endA ? fa(endA * farX, 0) : '—'} م²`);
    row('سطح اشغال در ابتدای / انتهای بازه', `${fa(startA * p.coverage / 100, 0)} / ${endA ? fa(endA * p.coverage / 100, 0) : '—'} م²`);
    const sb = p.setbacks;
    row('عقب‌نشینی از شمال / جنوب', `${sbText(sb.N)} / ${sbText(sb.S)}`);
    row('عقب‌نشینی از شرق / غرب', `${sbText(sb.E)} / ${sbText(sb.W)}`);
    row('ارتفاع تقریبی', `${fa(p.height)} م (${fa(Math.ceil(p.floors))} تراز × ${fa(S.floorH)} م)`);
  });
  row('ارتفاع کل تقریبی', `<b>${fa(layout.totalHeight)} م</b>`);
  row('محل استقرار توده', `چسبیده به ضلع ${SIDE_FA[layout.side]}`);

  if (prevRoad && !multi) {
    const pp = prevRoad.parts[0], cp = rd.parts[0];
    const sg = (v, u = '') => `${v > 0 ? '+' : ''}${fa(v, 2)}${u}`;
    row('تفاضل با رده معبر قبلی', `<span class="delta">تراکم ${sg(cp.far - pp.far, '٪')} · طبقات ${sg(cp.floors - pp.floors)} · سطح اشغال ${sg(cp.coverage - pp.coverage, '٪')}</span>`);
  }
  html += '</tbody></table>';

  // Notes
  const notes = [];
  layout.parts.forEach((p) => {
    if (p.limited) notes.push(`<div class="note">با این ابعاد، عقب‌نشینی‌ها اجازه نمی‌دهند کل سطح اشغال مجاز${multi ? ` (${p.name})` : ''} استفاده شود؛ سطح اشغال قابل‌ساخت ≈ ${fa(p.effCoverage)}٪ است. بَر یا عمق قطعه را تغییر دهید.</div>`);
  });
  if (layout.parts.some((p) => p.frac > 0)) notes.push('<div class="note info">تعداد طبقات اعشاری در جدول برابر «تراکم ÷ سطح اشغال» است. کسر طبقه به‌صورت بخشی از تراز آخر (کم‌رنگ‌تر) نمایش داده شده است.</div>');
  if (multi) notes.push('<div class="note info">در M6 فرض شده است که طبقات «بنای اصلی» روی پودیوم قرار می‌گیرند و عقب‌نشینی‌های بنای اصلی جداگانه اعمال می‌شود. اگر منظور جدول این است که طبقات بنای اصلی شامل پودیوم است، این فرض را در کد اصلاح کنید.</div>');
  if (sub.minNewSubdivision && S.area < sub.minNewSubdivision) notes.push(`<div class="note info">مساحت این قطعه از حداقل نصاب تفکیک جدید (${fa(sub.minNewSubdivision)} م²) کمتر است؛ این حالت فقط برای قطعات تفکیک‌شدهٔ موجود معنا دارد.</div>`);
  html += notes.join('');
  $('results').innerHTML = html;
}

/* ---------- main refresh ---------- */
function refresh(refit) {
  normalize();
  renderControls();
  const frontage = defaultFrontage(S.area, S.ratio);
  const layout = computeLayout({
    area: S.area, frontage, orientation: S.orient, roadWidth: S.roadW,
    floorH: S.floorH, anchor: S.anchor, parts: roadOf().parts,
  });
  viewer.update(layout, {
    zoneColor: zoneOf().color, roadWidth: S.roadW, floorH: S.floorH,
    showEnvelope: S.env, showSetbacks: S.sb, showNeighbors: S.nb,
  });
  viewer.setLabelsVisible(S.lbl);
  if (refit) viewer.fit();
  renderResults(layout);
  writeHash();
}

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------- events ---------- */
function bindEvents() {
  $('subzoneSelect').addEventListener('change', (e) => {
    const [sid, code] = e.target.value.split('|');
    const changed = sid !== S.sub;
    S.sub = sid; S.code = code;
    if (changed) { S.ai = 0; S.ri = 0; S.area = null; S.roadW = null; }
    refresh(changed);
  });
  document.querySelectorAll('#orientPad button').forEach((b) => b.addEventListener('click', () => { S.orient = b.dataset.o; refresh(true); }));
  $('areaRange').addEventListener('input', (e) => { S.area = +e.target.value; refresh(false); });
  $('frontRange').addEventListener('input', (e) => { const f = +e.target.value; S.ratio = (S.area / f) / f; refresh(false); });
  $('roadRange').addEventListener('input', (e) => { S.roadW = +e.target.value; refresh(false); });
  $('floorH').addEventListener('change', (e) => { S.floorH = +e.target.value; refresh(false); });
  $('anchorSelect').addEventListener('change', (e) => { S.anchor = e.target.value; refresh(false); });
  const tg = { tgEnvelope: 'env', tgSetback: 'sb', tgNeighbors: 'nb', tgLabels: 'lbl' };
  for (const [id, key] of Object.entries(tg)) $(id).addEventListener('change', (e) => { S[key] = e.target.checked; refresh(false); });
  $('btnShare').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('لینک کپی شد'); }
    catch { prompt('این لینک را کپی کنید:', location.href); }
  });
  $('btnShot').addEventListener('click', () => viewer.screenshot(`sari-${S.code}-${Math.round(S.area)}m2.png`));
  $('btnFit').addEventListener('click', () => viewer.fit());
  $('togglePanel').addEventListener('click', () => {
    const p = $('panel'); const c = p.classList.toggle('collapsed');
    $('togglePanel').setAttribute('aria-expanded', String(!c));
  });
}

/* ---------- boot ---------- */
async function boot() {
  try {
    DB = await (await fetch(DATA_URL)).json();
  } catch (e) {
    $('results').innerHTML = '<div class="note">فایل داده بارگذاری نشد. صفحه را از طریق یک وب‌سرور (مثلاً GitHub Pages) باز کنید، نه با دوبار کلیک روی فایل.</div>';
    throw e;
  }
  Object.assign(S, Object.fromEntries(Object.entries(readHash()).filter(([, v]) => v != null)));
  viewer = new Viewer($('viewport'));
  bindEvents();
  refresh(true);
  window.__app = { S, DB, refresh }; // for debugging and tests
}
boot();
