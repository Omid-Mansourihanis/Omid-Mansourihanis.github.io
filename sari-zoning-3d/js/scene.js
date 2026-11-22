import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { rectArea, sbVal } from './geometry.js?v=20261121';
import { LANG, T, fmt } from './i18n.js?v=20261121';

const fa = fmt;

const COLORS = {
  ground: 0xecebe6,
  lot: 0x9fd39a,
  lotEdge: 0x2f3b2f,
  setback: 0xe85d5d,
  envelope: 0x5b8def,
  street: 0x45474b,
  streetLine: 0xf5f5f5,
  neighbor: 0xdedcd5,
  neighborEdge: 0xb9b6ad,
  edge: 0x1f2328,
};

export class Viewer {
  constructor(container) {
    this.container = container;
    this.labels = [];
    this.disposables = [];

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    // direction: ltr is required; in an RTL page, labels would otherwise start from the right edge and land off screen
    Object.assign(this.labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none', direction: 'ltr' });
    container.appendChild(this.labelRenderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf3f2ee);
    this.scene.fog = new THREE.Fog(0xf3f2ee, 250, 600);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 500;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b4a6, 1.5));
    // Sun from the south, the way it is at Sari's latitude
    this.sun = new THREE.DirectionalLight(0xffffff, 1.9);
    this.sun.position.set(-40, 90, 70);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(400, 80, 0xd6d3ca, 0xe3e1da);
    grid.position.y = -0.01;
    this.scene.add(grid);

    // Screen-space compass: stays visible and turns with the camera
    this.compass = document.createElement('div');
    this.compass.className = 'compass3d';
    this.compass.innerHTML = `<div class="needle"><b>N</b><i></i></div><span>${T.north}</span>`;
    container.appendChild(this.compass);
    this._v1 = new THREE.Vector3(); this._v2 = new THREE.Vector3();

    this.dyn = new THREE.Group();
    this.scene.add(this.dyn);

    this._resize = this._resize.bind(this);
    new ResizeObserver(this._resize).observe(container);
    this._resize();

    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
      this._updateCompass();
      requestAnimationFrame(loop);
    };
    loop();
  }

  _updateCompass() {
    const t = this.controls.target;
    this._v1.copy(t).project(this.camera);
    this._v2.set(t.x, t.y, t.z - 10).project(this.camera); // north = -z
    const dx = this._v2.x - this._v1.x, dy = this._v2.y - this._v1.y;
    const ang = Math.atan2(dx * this.camera.aspect, dy) * 180 / Math.PI;
    this.compass.firstChild.style.transform = `rotate(${ang}deg)`;
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ---------- helpers ---------- */
  _track(o) { this.disposables.push(o); return o; }

  _clear() {
    for (const l of this.labels) { l.element.remove(); l.parent && l.parent.remove(l); }
    this.labels = [];
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.dyn.clear();
  }

  _label(text, x, y, z, cls = '') {
    const el = document.createElement('div');
    el.className = 'lbl ' + cls;
    el.textContent = text;
    const obj = new CSS2DObject(el);
    obj.position.set(x, y, z);
    this.dyn.add(obj);
    this.labels.push(obj);
    return obj;
  }

  _flat(rect, y, color, opacity = 1) {
    const w = rect.xMax - rect.xMin, d = rect.zMax - rect.zMin;
    if (w <= 0 || d <= 0) return null;
    const g = this._track(new THREE.PlaneGeometry(w, d));
    const m = this._track(new THREE.MeshStandardMaterial({
      color, roughness: 1, transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -Math.round(y * 400) - 1,
    }));
    const mesh = new THREE.Mesh(g, m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((rect.xMin + rect.xMax) / 2, y, (rect.zMin + rect.zMax) / 2);
    mesh.receiveShadow = true;
    this.dyn.add(mesh);
    return mesh;
  }

  _outline(rect, y, color, dashed = false, width = 1) {
    const pts = [
      [rect.xMin, rect.zMin], [rect.xMax, rect.zMin], [rect.xMax, rect.zMax], [rect.xMin, rect.zMax], [rect.xMin, rect.zMin],
    ].map(([x, z]) => new THREE.Vector3(x, y, z));
    const g = this._track(new THREE.BufferGeometry().setFromPoints(pts));
    const m = this._track(dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 0.8, gapSize: 0.5, linewidth: width })
      : new THREE.LineBasicMaterial({ color, linewidth: width }));
    const line = new THREE.Line(g, m);
    if (dashed) line.computeLineDistances();
    this.dyn.add(line);
    return line;
  }

  _box(rect, y0, h, material, edgeColor = COLORS.edge, edgeOpacity = 0.85) {
    const w = rect.xMax - rect.xMin, d = rect.zMax - rect.zMin;
    if (w <= 0 || d <= 0 || h <= 0) return null;
    const g = this._track(new THREE.BoxGeometry(w, h, d));
    const mesh = new THREE.Mesh(g, material);
    mesh.position.set((rect.xMin + rect.xMax) / 2, y0 + h / 2, (rect.zMin + rect.zMax) / 2);
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = true;
    this.dyn.add(mesh);
    const eg = this._track(new THREE.EdgesGeometry(g));
    const em = this._track(new THREE.LineBasicMaterial({ color: edgeColor, transparent: edgeOpacity < 1, opacity: edgeOpacity }));
    const edges = new THREE.LineSegments(eg, em);
    edges.position.copy(mesh.position);
    this.dyn.add(edges);
    return mesh;
  }

  /* ---------- main draw ---------- */
  update(layout, opts) {
    this._clear();
    const { lot, street, parts } = layout;
    const zoneColor = new THREE.Color(opts.zoneColor || '#f4c542');

    // Neighboring lots on both sides, along the street
    if (opts.showNeighbors) {
      const along = street.along;
      const w = along === 'x' ? lot.xMax - lot.xMin : lot.zMax - lot.zMin;
      for (const s of [-1, 1]) {
        const r = along === 'x'
          ? { xMin: lot.xMin + s * w, xMax: lot.xMax + s * w, zMin: lot.zMin, zMax: lot.zMax }
          : { xMin: lot.xMin, xMax: lot.xMax, zMin: lot.zMin + s * w, zMax: lot.zMax + s * w };
        this._flat(r, 0.005, COLORS.neighbor);
        this._outline(r, 0.03, COLORS.neighborEdge);
      }
    }

    // Street
    this._flat(street, 0.004, COLORS.street);
    const mid = street.along === 'x'
      ? { xMin: street.xMin, xMax: street.xMax, zMin: (street.zMin + street.zMax) / 2 - 0.08, zMax: (street.zMin + street.zMax) / 2 + 0.08 }
      : { xMin: (street.xMin + street.xMax) / 2 - 0.08, xMax: (street.xMin + street.xMax) / 2 + 0.08, zMin: street.zMin, zMax: street.zMax };
    const cl = this._flat(mid, 0.012, COLORS.streetLine);
    if (cl) cl.material.opacity = 0.9;
    const sc = { x: (street.xMin + street.xMax) / 2, z: (street.zMin + street.zMax) / 2 };
    // Street label to the west / south of the lot, the side the default camera (south-west) looks at, so the building doesn't cover it
    const roadOff = street.along === 'x' ? { x: -(lot.xMax - lot.xMin) / 2 - 10, z: 0 } : { x: 0, z: (lot.zMax - lot.zMin) / 2 + 10 };
    this._label(T.lRoad(fa(opts.roadWidth)), sc.x + roadOff.x, 0.3, sc.z + roadOff.z, 'road');

    // Lot (open space) and its boundary
    this._flat(lot, 0.01, COLORS.lot);
    this._outline(lot, 0.05, COLORS.lotEdge);

    // Setbacks of the ground floor (first part)
    const p0 = parts[0];
    if (opts.showSetbacks && p0) {
      const sb = p0.setbacks;
      const strips = {
        N: { xMin: lot.xMin, xMax: lot.xMax, zMin: lot.zMin, zMax: lot.zMin + sbVal(sb.N) },
        S: { xMin: lot.xMin, xMax: lot.xMax, zMin: lot.zMax - sbVal(sb.S), zMax: lot.zMax },
        W: { xMin: lot.xMin, xMax: lot.xMin + sbVal(sb.W), zMin: lot.zMin, zMax: lot.zMax },
        E: { xMin: lot.xMax - sbVal(sb.E), xMax: lot.xMax, zMin: lot.zMin, zMax: lot.zMax },
      };
      for (const [k, r] of Object.entries(strips)) {
        const v = sbVal(sb[k]);
        if (v > 0) {
          this._flat(r, 0.02, COLORS.setback, 0.45);
          this._label(T.lSetback(fa(v)), (r.xMin + r.xMax) / 2, 0.4, (r.zMin + r.zMax) / 2, 'red');
        }
      }
      if (sb[street.side] === null) {
        const qx = (lot.xMax - lot.xMin) / 4, qz = (lot.zMax - lot.zMin) / 4;
        const e = { N: [qx, lot.zMin], S: [qx, lot.zMax], W: [lot.xMin, qz], E: [lot.xMax, qz] }[street.side];
        this._label(T.lNoSetback, e[0], 0.5, e[1], 'red');
      }
    }

    // Dimensions of the lot
    const fr = lot.frontage, dp = lot.depth;
    if (street.along === 'x') {
      const zEdge = street.side === 'S' ? lot.zMax : lot.zMin;
      this._label(T.lFront(fa(fr)), -(lot.xMax - lot.xMin) / 4, 0.3, zEdge + (street.side === 'S' ? 1.6 : -1.6), 'dark');
      this._label(T.lDepth(fa(dp)), lot.xMin - 1.5, 0.3, 0, 'dark');
    } else {
      const xEdge = street.side === 'E' ? lot.xMax : lot.xMin;
      this._label(T.lFront(fa(fr)), xEdge + (street.side === 'E' ? 1.6 : -1.6), 0.3, -(lot.zMax - lot.zMin) / 4, 'dark');
      this._label(T.lDepth(fa(dp)), 0, 0.3, lot.zMax + 1.5, 'dark');
    }

    // Envelope and building mass
    const h = opts.floorH;
    parts.forEach((part, idx) => {
      if (opts.showEnvelope) {
        const envMat = this._track(new THREE.MeshBasicMaterial({ color: COLORS.envelope, transparent: true, opacity: 0.07, depthWrite: false }));
        this._box(part.envelope, part.baseY, part.height, envMat, COLORS.envelope, 0.6);
      }
      if (!part.foot) return;
      const col = zoneColor.clone().offsetHSL(0, 0, idx === 0 ? 0 : -0.08);
      const mat = this._track(new THREE.MeshStandardMaterial({ color: col, roughness: 0.75, metalness: 0.02 }));
      for (let i = 0; i < part.full; i++) this._box(part.foot, part.baseY + i * h, h, mat);
      if (part.fracRect) {
        const fm = this._track(new THREE.MeshStandardMaterial({ color: col.clone().offsetHSL(0, -0.2, 0.15), roughness: 0.8, transparent: true, opacity: 0.85 }));
        const y = part.baseY + part.full * h;
        this._box(part.fracRect, y, h, fm);
        const c = part.fracRect;
        this._label(T.lFrac(fa(part.frac, 2)), (c.xMin + c.xMax) / 2, y + h + 0.6, (c.zMin + c.zMax) / 2, '');
      }
      // Height and floor-count label
      const f = part.foot;
      const top = part.baseY + part.height;
      const pname = LANG === 'en' && part.name_en ? part.name_en : part.name;
      const name = parts.length > 1 ? `${pname}: ` : '';
      this._label(T.lFloors(name, fa(part.floors), fa(part.height)),
        f.xMax + 0.5, top + 0.8, (f.zMin + f.zMax) / 2, 'big');
    });

    // Shadow area that fits the scene
    const R = Math.max(lot.xMax - lot.xMin, lot.zMax - lot.zMin) + layout.totalHeight + 20;
    const cam = this.sun.shadow.camera;
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R; cam.near = 1; cam.far = 400;
    cam.updateProjectionMatrix();

    this._lastBounds = { lot, street, H: layout.totalHeight };
  }

  fit() {
    if (!this._lastBounds) return;
    const { lot, H } = this._lastBounds;
    const span = Math.max(lot.xMax - lot.xMin, lot.zMax - lot.zMin, 20);
    const radius = Math.hypot(span * 1.4, H) / 2 + 6;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    const target = new THREE.Vector3(0, H * 0.35, 0);
    const dir = new THREE.Vector3(-0.75, 0.75, 1).normalize(); // seen from the south-west
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    this.controls.update();
  }

  setLabelsVisible(v) { this.container.classList.toggle('hide-labels', !v); }

  screenshot(filename = 'sari-zoning.png') {
    this.renderer.render(this.scene, this.camera);
    const a = document.createElement('a');
    a.href = this.renderer.domElement.toDataURL('image/png');
    a.download = filename;
    a.click();
  }
}
