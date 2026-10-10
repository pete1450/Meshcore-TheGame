/* MeshCore signal-map game — FPV edition.
 * Walk the terrain (WASD + mouse), drop repeaters (E), preview signal (Q),
 * grow the minimap (M, animated) and click it to set a waypoint.
 */
'use strict';

const W = {
  seed: 20261010,
  world: null, buildings: [], people: [], treeGrid: null,
  covAcc: null,                 // union of all repeater sweeps
  repeaters: [],
  player: { x: 512, z: 512, yaw: 0, pitch: 0, eyeY: 60 },
  antH: 10,
  waypoint: null,
  preview: null,                // {cov, alpha, t} handheld scan preview
  revealing: null,              // active sweep-reveal animation
  floodQueue: [],               // pending simulated mesh messages
  flooding: false,
  keys: {},
};

const IS_TOUCH = 'ontouchstart' in window;

let renderer, scene, camera;
let terrainMesh, covTex, covCanvas, covCtx, covImg;
let prevTex, prevCanvas, prevCtx;
let worldGroup, personMeshes = [], repeaterGroups = [];
let sweepLine, sweepRing, waypointMesh;
let mmCanvas, mmCtx, mmBase;
let helpEl, mapEl;

/* ================= boot ================= */
function init() {
  const canvas = document.getElementById('c');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc3cfd4);
  scene.fog = new THREE.Fog(0xc3cfd4, 260, 1900);

  // gradient sky dome (fog-exempt)
  {
    const skyGeo = new THREE.SphereGeometry(3000, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, fog: false, depthWrite: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP;
        void main(){
          float h = normalize(vP).y;
          vec3 top = vec3(0.16,0.34,0.56);
          vec3 hor = vec3(0.77,0.81,0.83);
          vec3 gnd = vec3(0.42,0.44,0.44);
          vec3 c = h >= 0.0 ? mix(hor, top, smoothstep(0.0,0.55,h)) : mix(hor, gnd, smoothstep(0.0,-0.2,h));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.renderOrder = -10;
    scene.add(sky);
    W.sky = sky;
  }

  camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.3, 4000);
  camera.rotation.order = 'YXZ';

  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x2c3a24, 0.95));
  const sun = new THREE.DirectionalLight(0xfff1d6, 0.9);
  sun.position.set(400, 800, 250);
  scene.add(sun);

  covCanvas = document.createElement('canvas');
  covCanvas.width = covCanvas.height = SIG.GRID;
  covCtx = covCanvas.getContext('2d');
  covImg = covCtx.createImageData(SIG.GRID, SIG.GRID);
  covTex = new THREE.CanvasTexture(covCanvas);
  covTex.magFilter = THREE.LinearFilter; covTex.minFilter = THREE.LinearFilter;

  prevCanvas = document.createElement('canvas');
  prevCanvas.width = prevCanvas.height = SIG.GRID;
  prevCtx = prevCanvas.getContext('2d');
  prevTex = new THREE.CanvasTexture(prevCanvas);
  prevTex.magFilter = THREE.LinearFilter; prevTex.minFilter = THREE.LinearFilter;

  mmCanvas = document.getElementById('mm');
  mmCtx = mmCanvas.getContext('2d');

  helpEl = document.getElementById('help');
  mapEl = document.getElementById('minimap');
  if (IS_TOUCH) document.body.classList.add('touch');

  buildWorld(W.seed);
  wireUI();
  wireInput();
  addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(tick);
}
function onResize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}

/* ================= world ================= */
function disposeGroup(g) {
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
  });
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function buildWorld(seed) {
  W.seed = seed;
  if (worldGroup) { scene.remove(worldGroup); disposeGroup(worldGroup); }
  worldGroup = new THREE.Group();
  scene.add(worldGroup);
  personMeshes = []; repeaterGroups = [];
  W.repeaters = [];
  W.covAcc = new Float32Array(SIG.GRID * SIG.GRID);
  W.preview = null; W.revealing = null; W.waypoint = null;
  W.floodQueue = []; W.flooding = false;
  if (waypointMesh) { waypointMesh.visible = false; }
  paintCoverage(covCtx, W.covAcc);
  prevCtx.clearRect(0, 0, SIG.GRID, SIG.GRID); prevTex.needsUpdate = true;
  setStat('scan', '—');

  const world = generateMap(seed);
  W.world = world;
  const { SIZE, GRID } = SIG, H = world.heights;

  // terrain + topo shader (hypsometric + contours + coverage + preview)
  // Render mesh is subdivided finer than the logic grid for smooth walking.
  const RG = 384;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, RG, RG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let iy = 0; iy <= RG; iy++)
    for (let ix = 0; ix <= RG; ix++)
      pos.setXYZ(iy * (RG + 1) + ix, ix / RG * SIZE, sampleH(H, GRID, SIZE, ix / RG * SIZE, iy / RG * SIZE), iy / RG * SIZE);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCov = { value: covTex };
    sh.uniforms.uPrev = { value: prevTex };
    sh.uniforms.uPrevA = { value: 0 };
    mat.userData.sh = sh;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vH;\nvarying vec2 vUvC;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = position.y;\nvUvC = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vH;\nvarying vec2 vUvC;\nuniform sampler2D uCov;\nuniform sampler2D uPrev;\nuniform float uPrevA;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 hc = mix(vec3(0.16,0.36,0.15), vec3(0.45,0.40,0.23), smoothstep(120.0, 260.0, vH));
        hc = mix(hc, vec3(0.58,0.57,0.60), smoothstep(260.0, 390.0, vH));
        hc = mix(hc, vec3(0.90,0.92,0.94), smoothstep(420.0, 470.0, vH));
        float f50 = abs(fract(vH/50.0+0.5)-0.5)*50.0;
        float f250 = abs(fract(vH/250.0+0.5)-0.5)*250.0;
        hc = mix(hc, vec3(0.15,0.12,0.09), clamp((1.0-smoothstep(0.0,4.5,f50))*0.30 + (1.0-smoothstep(0.0,8.0,f250))*0.32, 0.0, 0.55));
        float pv = texture2D(uPrev, vUvC).r * uPrevA;
        hc = mix(hc, vec3(1.0,0.55,0.12), clamp(pv*1.8, 0.0, 0.75));
        float cov = texture2D(uCov, vUvC).r;
        hc = mix(hc, vec3(1.0,0.10,0.10), clamp(cov*1.6, 0.0, 0.80));
        diffuseColor.rgb = hc;`);
  };
  terrainMesh = new THREE.Mesh(geo, mat);
  worldGroup.add(terrainMesh);

  // road ribbon
  {
    const vp = [], idx = [];
    let i = 0;
    for (let x = 8; x <= SIZE - 8; x += 16, i++) {
      const zc = world.roadZ(x);
      for (const s of [-3.6, 3.6]) {
        const z = zc + s;
        vp.push(x, sampleH(H, GRID, SIZE, x, z) + 0.5, z);
      }
      if (i > 0) { const b = i * 2; idx.push(b - 2, b - 1, b, b - 1, b + 1, b); }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(vp, 3));
    rg.setIndex(idx); rg.computeVertexNormals();
    worldGroup.add(new THREE.Mesh(rg, new THREE.MeshLambertMaterial({ color: 0x2e2c28, polygonOffset: true, polygonOffsetFactor: -2 })));
  }

  // buildings
  W.buildings = placeBuildings(world, 16);
  {
    const byType = { house: [], barn: [], store: [] };
    W.buildings.forEach(b => byType[b.type].push(b));
    const colors = { house: 0xb08968, barn: 0x8f3b2f, store: 0x9aa0a8 };
    const dummy = new THREE.Object3D();
    for (const t of Object.keys(byType)) {
      const list = byType[t];
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: colors[t] }), list.length);
      list.forEach((b, i) => {
        dummy.position.set(b.x, sampleH(H, GRID, SIZE, b.x, b.z) + b.hgt / 2, b.z);
        dummy.rotation.set(0, b.rot, 0);
        dummy.scale.set(b.w, b.hgt, b.d);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      im.instanceMatrix.needsUpdate = true;
      worldGroup.add(im);
    }
  }

  // forest: jittered grid placement (scales to the big map), fills tree-count grid.
  // Trunks + canopies, up to 3x taller than before, sizes skewed toward large.
  const treeGrid = new Uint8Array(SIG.TREE_GRID * SIG.TREE_GRID);
  {
    const spots = [], rng = world.rng;
    const step = 17, jitter = 7;
    for (let gz = 0; gz * step < SIZE; gz++) {
      for (let gx = 0; gx * step < SIZE; gx++) {
        const x = gx * step + (rng() * 2 - 1) * jitter;
        const z = gz * step + (rng() * 2 - 1) * jitter;
        if (x < 16 || x > SIZE - 16 || z < 16 || z > SIZE - 16) continue;
        if (rng() < world.forestDensity(x, z) * 1.6) {
          // height 9..30 m, skewed toward larger trees
          const hgt = 9 + 21 * Math.pow(rng(), 0.6);
          spots.push([x, z, hgt]);
          const ix = Math.min(SIG.TREE_GRID - 1, (x / SIZE * SIG.TREE_GRID) | 0);
          const iz = Math.min(SIG.TREE_GRID - 1, (z / SIZE * SIG.TREE_GRID) | 0);
          treeGrid[iz * SIG.TREE_GRID + ix]++;
        }
      }
    }
    const dummy = new THREE.Object3D();
    // trunks
    const trunkIM = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.35, 0.55, 1, 5),
      new THREE.MeshLambertMaterial({ color: 0x5a3d28 }), spots.length);
    // canopies
    const canIM = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 6),
      new THREE.MeshLambertMaterial({ color: 0x1d4a26 }), spots.length);
    spots.forEach(([x, z, hgt], i) => {
      const gy = sampleH(H, GRID, SIZE, x, z);
      const trunkH = hgt * 0.35, canH = hgt * 0.75;
      dummy.rotation.set(0, rng() * 6.28, 0);
      dummy.position.set(x, gy + trunkH / 2, z);
      dummy.scale.set(0.8 + hgt * 0.02, trunkH, 0.8 + hgt * 0.02);
      dummy.updateMatrix(); trunkIM.setMatrixAt(i, dummy.matrix);
      const cr = 2.2 + hgt * 0.09;
      dummy.position.set(x, gy + trunkH + canH / 2 - 1, z);
      dummy.scale.set(cr, canH, cr);
      dummy.updateMatrix(); canIM.setMatrixAt(i, dummy.matrix);
    });
    trunkIM.instanceMatrix.needsUpdate = true;
    canIM.instanceMatrix.needsUpdate = true;
    worldGroup.add(trunkIM); worldGroup.add(canIM);
  }
  W.treeGrid = treeGrid;

  // town labels
  for (const t of world.towns) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 6;
    g.strokeText(t.name.toUpperCase(), 128, 32);
    g.fillStyle = '#f5f0e2'; g.fillText(t.name.toUpperCase(), 128, 32);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: true, transparent: true }));
    sp.scale.set(120, 30, 1);
    sp.position.set(t.x, t.elev + 26, t.z);
    worldGroup.add(sp);
  }

  // people + locator pillars
  W.people = placePeople(world, seed);
  W.playerHash = nodeHash(seed, 7);
  document.getElementById('mynode').textContent = W.playerHash.slice(0, 4).toUpperCase();
  for (const p of W.people) {
    const g = new THREE.Group();
    const gy = sampleH(H, GRID, SIZE, p.x, p.z);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 4.5, 8), new THREE.MeshLambertMaterial({ color: 0xff5533 }));
    body.position.y = 2.25;
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.1, 8, 8), new THREE.MeshLambertMaterial({ color: 0xe8b98a }));
    head.position.y = 5.4;
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.6, 24), new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.6;
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 46, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    pillar.position.y = 23;
    g.add(body, head, ring, pillar);
    g.position.set(p.x, gy, p.z);
    g.userData = { body, ring, pillar, person: p, reached: false, flashUntil: 0 };
    worldGroup.add(g);
    personMeshes.push(g);
  }

  // sweep line + ring (radar reveal)
  sweepLine = new THREE.Mesh(new THREE.PlaneGeometry(SIG.MAX_RANGE, 2.2),
    new THREE.MeshBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }));
  sweepLine.visible = false; worldGroup.add(sweepLine);
  sweepRing = new THREE.Mesh(new THREE.RingGeometry(0.96, 1.0, 96),
    new THREE.MeshBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: false }));
  sweepRing.rotation.x = -Math.PI / 2; sweepRing.visible = false; worldGroup.add(sweepRing);

  // waypoint marker
  waypointMesh = new THREE.Mesh(new THREE.OctahedronGeometry(3),
    new THREE.MeshBasicMaterial({ color: 0x33ddff, transparent: true, opacity: 0.9, depthTest: false }));
  waypointMesh.visible = false; waypointMesh.renderOrder = 5; worldGroup.add(waypointMesh);

  buildMinimapBase();
  spawnPlayer();
  updateStats();
}

function spawnPlayer() {
  const { SIZE, GRID } = SIG;
  const t = W.world.towns[0];
  W.player.x = t.x; W.player.z = W.world.roadZ(t.x) + 12;
  W.player.yaw = 0; W.player.pitch = 0; // facing the town (-z)
  W.player.eyeY = sampleH(W.world.heights, GRID, SIZE, W.player.x, W.player.z) + 1.7;
}

/* ================= repeaters & sweeps ================= */
function dropRepeater() {
  if (W.revealing) return;
  const { SIZE, GRID } = SIG;
  const x = W.player.x, z = W.player.z;
  const gy = sampleH(W.world.heights, GRID, SIZE, x, z);
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 3), new THREE.MeshLambertMaterial({ color: 0x222630 }));
  base.position.y = 0.8;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, 1, 8), new THREE.MeshLambertMaterial({ color: 0x9aa0a8 }));
  mast.scale.y = W.antH; mast.position.y = W.antH / 2;
  const panel = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.3, 2.2), new THREE.MeshLambertMaterial({ color: 0x1c3f8f }));
  panel.position.set(2.2, 1.2, 0); panel.rotation.z = -0.5;
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 10), new THREE.MeshBasicMaterial({ color: 0x33ff66 }));
  beacon.position.y = W.antH + 0.9;
  g.add(base, mast, panel, beacon);
  g.position.set(x, gy, z);
  g.userData.beacon = beacon;
  worldGroup.add(g);
  repeaterGroups.push(g);
  const rep = {
    name: 'R' + (W.repeaters.length + 1),
    hash: nodeHash(W.seed, 5000 + W.repeaters.length),
    x, z, antH: W.antH, group: g,
    seenIds: new Set(), known: false, flashUntil: 0, lastSeen: 0, lastSignal: 0,
  };
  g.userData.rep = rep;
  W.repeaters.push(rep);
  clearPreview(); // a real repeater supersedes the handheld preview
  rep.cov = revealSweep(x, z, W.antH, false); // keep its own coverage map
  setStat('rep', W.repeaters.length);
  showToast(`${rep.name} [${rep.hash.slice(0, 4).toUpperCase()}] dropped — open 📻 and scan`);
}

function scanPreview() {
  if (W.revealing) return;
  setStat('scan', 'scanning…');
  revealSweep(W.player.x, W.player.z, 2, true); // handheld height
}

// Animated radar reveal. Merges into covAcc (or preview layer), painting
// progressively behind a rotating sweep line.
function revealSweep(tx, tz, antH, isPreview) {
  const { SIZE, GRID } = SIG;
  const covNew = sweepCoverage(W.world.heights, W.treeGrid, tx, tz, antH);
  const old = isPreview ? null : W.covAcc.slice();
  if (!isPreview) for (let i = 0; i < covNew.length; i++) if (covNew[i] > W.covAcc[i]) W.covAcc[i] = covNew[i];

  // texels of the new sweep, sorted by angle around the transmitter
  const ang = new Float32Array(GRID * GRID).fill(-1e9);
  const order = [];
  for (let iz = 0; iz < GRID; iz++) for (let ix = 0; ix < GRID; ix++) {
    const s = covNew[iz * GRID + ix];
    if (s <= 0) continue;
    const x = (ix + 0.5) / GRID * SIZE, z = (iz + 0.5) / GRID * SIZE;
    const a = Math.atan2(z - tz, x - tx);
    ang[iz * GRID + ix] = a;
    order.push({ i: iz * GRID + ix, a, d: Math.hypot(x - tx, z - tz) });
  }
  order.sort((p, q) => p.a - q.a);

  const gy = sampleH(W.world.heights, GRID, SIZE, tx, tz);
  sweepLine.visible = true;
  sweepLine.position.set(tx, gy + 3, tz);
  sweepRing.visible = true;
  sweepRing.position.set(tx, gy + 3, tz);

  const target = isPreview ? prevCtx : covCtx;
  const img = target.createImageData(GRID, GRID);
  const data = img.data;
  const DUR = isPreview ? 0.9 : 1.4;
  W.revealing = { order, ang, old, isPreview, covNew, target, img, data, t: 0, DUR, tx, tz };

  if (isPreview) { W.preview = { alpha: 0 }; }
  return covNew;
}

function stepReveal(dt) {
  const R = W.revealing;
  if (!R) return;
  R.t += dt;
  const k = Math.min(1, R.t / R.DUR);
  const curA = -Math.PI + k * Math.PI * 2;
  const { GRID } = SIG, data = R.data, ang = R.ang;
  for (let i = 0, p = 0; i < ang.length; i++, p += 4) {
    let s = R.isPreview ? 0 : R.old[i];
    if (ang[i] <= curA) {
      const ns = R.isPreview ? R.covNew[i] : W.covAcc[i];
      if (ns > s) s = ns;
    }
    if (s > 0) {
      data[p] = 255; data[p + 1] = 42; data[p + 2] = 42;
      data[p + 3] = Math.round(255 * (0.22 + 0.60 * Math.min(1, s * 2.4)));
    } else { data[p + 3] = 0; }
  }
  R.target.putImageData(R.img, 0, 0);
  (R.isPreview ? prevTex : covTex).needsUpdate = true;

  const cur = R.order[Math.min(R.order.length - 1, (k * R.order.length) | 0)];
  if (cur) {
    sweepLine.rotation.y = -cur.a;
    sweepLine.position.x = R.tx + Math.cos(cur.a) * SIG.MAX_RANGE / 2;
    sweepLine.position.z = R.tz + Math.sin(cur.a) * SIG.MAX_RANGE / 2;
    sweepRing.scale.set(cur.d, cur.d, 1);
  }
  if (k >= 1) {
    sweepLine.visible = false; sweepRing.visible = false;
    if (R.isPreview) {
      // persistent preview (orange) until the next scan or repeater drop
      let n = 0;
      for (let i = 0; i < R.covNew.length; i++) if (R.covNew[i] > 0) n++;
      const pct = (n / R.covNew.length * 100).toFixed(1);
      W.preview = { alpha: 1 };
      setPrevAlpha(1);
      if (n === 0) {
        setStat('scan', 'no signal here — try higher ground');
        showToast('no signal here — try higher ground');
      } else {
        setStat('scan', `preview: ${pct}% in range`);
        showToast(`scan complete: ${pct}% of map in range`);
      }
    }
    else { paintCoverage(covCtx, W.covAcc); updateStats(); }
    W.revealing = null;
  }
}

function paintCoverage(ctx, cov) {
  const { GRID } = SIG;
  const img = ctx.createImageData(GRID, GRID);
  const d = img.data;
  for (let i = 0, p = 0; i < cov.length; i++, p += 4) {
    const s = cov[i];
    if (s > 0) {
      d[p] = 255; d[p + 1] = 42; d[p + 2] = 42;
      d[p + 3] = Math.round(255 * (0.22 + 0.60 * Math.min(1, s * 2.4)));
    }
  }
  ctx.putImageData(img, 0, 0);
  covTex.needsUpdate = true;
}

function setPrevAlpha(a) {
  const sh = terrainMesh.material.userData.sh;
  if (sh) sh.uniforms.uPrevA.value = a;
}
function clearPreview() {
  W.preview = null;
  prevCtx.clearRect(0, 0, SIG.GRID, SIG.GRID);
  prevTex.needsUpdate = true;
  setPrevAlpha(0);
  setStat('scan', '—');
}

function updateStats() {
  const { SIZE, GRID } = SIG;
  let n = 0;
  for (let i = 0; i < W.covAcc.length; i++) if (W.covAcc[i] > 0) n++;
  setStat('cov', (n / W.covAcc.length * 100).toFixed(1) + '% of map');
  let reached = 0;
  for (const g of personMeshes) {
    const p = g.userData.person;
    const okp = sampleCov(W.covAcc, SIZE, GRID, p.x, p.z) > SIG.REACH_T;
    g.userData.reached = okp;
    if (okp) reached++;
    const col = okp ? 0x33dd55 : 0xff5533;
    g.userData.body.material.color.setHex(col);
    g.userData.ring.material.color.setHex(col);
    g.userData.pillar.material.color.setHex(col);
  }
  setStat('reach', `${reached} / ${W.people.length} linked`);
  setStat('people', reached === W.people.length ? 'everyone is linked!' : `${W.people.length - reached} still need a repeater`);
  setStat('rep', W.repeaters.length);
}

/* ================= minimap ================= */
function hypo(h) {
  const s1 = clamp((h - 120) / 140, 0, 1), s2 = clamp((h - 260) / 130, 0, 1);
  const t1 = s1 * s1 * (3 - 2 * s1), t2 = s2 * s2 * (3 - 2 * s2);
  let r = 0.16 + (0.45 - 0.16) * t1, g = 0.36 + (0.40 - 0.36) * t1, b = 0.15 + (0.23 - 0.15) * t1;
  r += (0.58 - r) * t2; g += (0.57 - g) * t2; b += (0.60 - b) * t2;
  const sn = clamp((h - 420) / 50, 0, 1); // snow caps
  r += (0.92 - r) * sn; g += (0.93 - g) * sn; b += (0.95 - b) * sn;
  return [r * 255 | 0, g * 255 | 0, b * 255 | 0];
}
// Elevation labels along the major contours: scan rows for level crossings,
// orient each label along the contour tangent, keep them spaced out.
function drawContourLabels(c, N) {
  const { SIZE, GRID } = SIG, H = W.world.heights;
  const placed = [];
  c.font = '600 13px system-ui, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let L = 100; L <= 400; L += 100) {
    for (let iz = 4; iz < N - 4; iz += 3) {
      const z = (iz + 0.5) / N * SIZE;
      let prevH = sampleH(H, GRID, SIZE, 0.5 / N * SIZE, z);
      for (let ix = 1; ix < N; ix++) {
        const x = (ix + 0.5) / N * SIZE;
        const h = sampleH(H, GRID, SIZE, x, z);
        if ((prevH - L) * (h - L) < 0) {
          const t = (L - prevH) / (h - prevH);
          const cx = (ix - 1 + t + 0.5) / N * SIZE;
          const e = 5;
          const gx = (sampleH(H, GRID, SIZE, cx + e, z) - sampleH(H, GRID, SIZE, cx - e, z)) / (2 * e);
          const gz = (sampleH(H, GRID, SIZE, cx, z + e) - sampleH(H, GRID, SIZE, cx, z - e)) / (2 * e);
          let ang = Math.atan2(gx, -gz); // contour tangent
          if (ang > Math.PI / 2) ang -= Math.PI;
          if (ang < -Math.PI / 2) ang += Math.PI;
          const px = cx / SIZE * N, py = z / SIZE * N;
          if (!placed.some(p => (p[0] - px) * (p[0] - px) + (p[1] - py) * (p[1] - py) < 62 * 62)) {
            placed.push([px, py]);
            c.save();
            c.translate(px, py); c.rotate(ang);
            c.lineWidth = 3.5; c.strokeStyle = 'rgba(238,232,216,0.9)';
            c.strokeText(String(L), 0, 0);
            c.fillStyle = '#4a3b28';
            c.fillText(String(L), 0, 0);
            c.restore();
          }
        }
        prevH = h;
      }
    }
  }
}
function buildMinimapBase() {
  const { SIZE, GRID } = SIG, H = W.world.heights, N = 512;
  mmBase = document.createElement('canvas'); mmBase.width = mmBase.height = N;
  const c = mmBase.getContext('2d');
  const img = c.createImageData(N, N), d = img.data;
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const x = (ix + 0.5) / N * SIZE, z = (iz + 0.5) / N * SIZE;
    const h = sampleH(H, GRID, SIZE, x, z);
    let [r, g, b] = hypo(h);
    // dense forest reads darker on the topo sheet
    if (W.world.forestClass(x, z) === 2) { r *= 0.55; g *= 0.72; b *= 0.55; }
    // contour lines: 50 m interval, 250 m major
    const d50 = Math.abs(h / 50 - Math.round(h / 50)) * 50;
    const d250 = Math.abs(h / 250 - Math.round(h / 250)) * 250;
    const mul = d250 < 4 ? 0.55 : (d50 < 2.2 ? 0.78 : 1);
    const p = (iz * N + ix) * 4;
    d[p] = r * mul; d[p + 1] = g * mul; d[p + 2] = b * mul; d[p + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  // road
  c.fillStyle = '#3c3a36';
  for (let x = 48; x <= 976; x += 2) {
    const z = W.world.roadZ(x);
    c.fillRect(x / SIZE * N - 2, z / SIZE * N - 2, 5, 5);
  }
  // towns
  c.fillStyle = '#f0ead8';
  for (const t of W.world.towns) {
    c.beginPath(); c.arc(t.x / SIZE * N, t.z / SIZE * N, 8, 0, 7); c.fill();
    c.fillStyle = '#4a3b28';
    c.font = '600 15px system-ui, sans-serif'; c.textAlign = 'center';
    c.fillText(t.name.toUpperCase(), t.x / SIZE * N, t.z / SIZE * N - 16);
    c.fillStyle = '#f0ead8';
  }
  drawContourLabels(c, N);
}

function drawMinimap() {
  const S = 512, k = S / SIG.SIZE;
  mmCtx.clearRect(0, 0, S, S);
  mmCtx.drawImage(mmBase, 0, 0, S, S);
  if (W.preview && W.preview.alpha > 0) {
    mmCtx.globalAlpha = 0.9;
    mmCtx.drawImage(prevCanvas, 0, 0, S, S);
    mmCtx.globalAlpha = 1;
  }
  mmCtx.globalAlpha = 0.85;
  mmCtx.drawImage(covCanvas, 0, 0, S, S);
  mmCtx.globalAlpha = 1;
  // people (dots + hash labels + 10s message flash halos)
  const now = performance.now();
  mmCtx.font = '600 10px system-ui, sans-serif'; mmCtx.textAlign = 'left'; mmCtx.textBaseline = 'middle';
  for (const g of personMeshes) {
    const p = g.userData.person;
    const px = p.x * k, pz = p.z * k;
    const flashing = now < g.userData.flashUntil;
    if (flashing) {
      mmCtx.strokeStyle = '#66ff88'; mmCtx.lineWidth = 2.5;
      mmCtx.beginPath(); mmCtx.arc(px, pz, 11 + 4 * Math.sin(now / 130), 0, 7); mmCtx.stroke();
    }
    mmCtx.fillStyle = flashing ? '#66ff88' : (g.userData.reached ? '#33dd55' : '#ff5533');
    mmCtx.fillRect(px - 3, pz - 3, 6, 6);
    const tag = p.hash.slice(0, 4).toUpperCase();
    mmCtx.lineWidth = 3; mmCtx.strokeStyle = 'rgba(0,0,0,0.65)';
    mmCtx.strokeText(tag, px + 7, pz);
    mmCtx.fillStyle = '#fff';
    mmCtx.fillText(tag, px + 7, pz);
  }
  // repeaters
  mmCtx.fillStyle = '#ffd75e';
  for (const r of W.repeaters) mmCtx.fillRect(r.x * k - 4, r.z * k - 4, 8, 8);
  // waypoint
  if (W.waypoint) {
    mmCtx.fillStyle = '#33ddff';
    const wx = W.waypoint.x * k, wz = W.waypoint.z * k;
    mmCtx.beginPath(); mmCtx.moveTo(wx, wz - 7); mmCtx.lineTo(wx + 7, wz); mmCtx.lineTo(wx, wz + 7); mmCtx.lineTo(wx - 7, wz); mmCtx.fill();
  }
  // player arrow
  const px = W.player.x * k, pz = W.player.z * k;
  mmCtx.save();
  mmCtx.translate(px, pz); mmCtx.rotate(-W.player.yaw);
  mmCtx.fillStyle = '#ffffff';
  mmCtx.beginPath(); mmCtx.moveTo(0, -11); mmCtx.lineTo(7, 8); mmCtx.lineTo(0, 4); mmCtx.lineTo(-7, 8); mmCtx.fill();
  mmCtx.restore();
}

function toggleMap(force) {
  const exp = force !== undefined ? force : !mapEl.classList.contains('expanded');
  mapEl.classList.toggle('expanded', exp);
  if (exp && document.pointerLockElement) document.exitPointerLock();
  if (!exp && !IS_TOUCH && !document.pointerLockElement && helpEl.classList.contains('hidden'))
    showToast('click the view to capture the mouse');
}
function setWaypointFromEvent(e) {
  const r = mmCanvas.getBoundingClientRect();
  const wx = (e.clientX - r.left) / r.width * SIG.SIZE;
  const wz = (e.clientY - r.top) / r.height * SIG.SIZE;
  W.waypoint = { x: clamp(wx, 0, SIG.SIZE), z: clamp(wz, 0, SIG.SIZE) };
}

/* ================= simulated MeshCore device ================= */
let msgSeq = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function devToggle() {
  const d = document.getElementById('device');
  d.classList.contains('open') ? devClose() : devOpen();
}
function devOpen() {
  document.getElementById('device').classList.add('open');
  discoverRepeaters();
}
function devClose() { document.getElementById('device').classList.remove('open'); }

function flashPerson(p) {
  const g = personMeshes.find(g => g.userData.person === p);
  if (g) g.userData.flashUntil = performance.now() + 10000; // green for 10 s
}

// Discovery: a repeater replies if you're standing inside its own coverage
// map — i.e. exactly where the map is red for that repeater.
function discoverRepeaters() {
  const { SIZE, GRID } = SIG;
  let n = 0;
  for (const r of W.repeaters) {
    if (!r.cov) continue;
    const s = sampleCov(r.cov, SIZE, GRID, W.player.x, W.player.z);
    if (s > SIG.COVER_T) {
      n++;
      r.lastSeen = Date.now(); r.lastSignal = s;
      if (!r.known) {
        r.known = true;
        addChannelMsg('SYS', `repeater ${r.name} [${r.hash.slice(0, 4).toUpperCase()}] discovered`, 'sys');
      }
    }
  }
  renderRepeaterList();
  showToast(n ? `${n} repeater${n > 1 ? 's' : ''} replied` : 'no repeaters in range');
}

function renderRepeaterList() {
  const el = document.getElementById('replist');
  const known = W.repeaters.filter(r => r.known);
  if (!known.length) {
    el.innerHTML = '<div class="rempty">no known repeaters yet — drop one with E, then scan</div>';
    return;
  }
  el.innerHTML = known.map(r => {
    const nb = Math.max(1, Math.min(4, Math.ceil((r.lastSignal || 0.1) * 4)));
    const ago = r.lastSeen ? Math.max(0, Math.round((Date.now() - r.lastSeen) / 1000)) + 's ago' : '—';
    return `<div class="rep"><span class="rname">${r.name}</span>` +
      `<span class="rhash">${r.hash.slice(0, 4).toUpperCase()}</span>` +
      `<span class="rsig">${'▮'.repeat(nb)}${'▯'.repeat(4 - nb)}</span>` +
      `<span class="rago">${ago}</span></div>`;
  }).join('');
}

function addChannelMsg(who, text, cls) {
  const box = document.getElementById('msgs');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'msg ' + (cls || '');
  const t = new Date();
  div.innerHTML = `<span class="who"></span><span class="txt"></span><span class="ts">${t.toTimeString().slice(0, 5)}</span>`;
  div.querySelector('.who').textContent = who;
  div.querySelector('.txt').textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 60) box.removeChild(box.firstChild);
}

function nodePos(n) {
  if (n.kind === 'player') return { x: W.player.x, z: W.player.z, h: 2 };
  if (n.kind === 'rep') return { x: n.ref.x, z: n.ref.z, h: n.ref.antH };
  return { x: n.ref.x, z: n.ref.z, h: 1.5 }; // person (client)
}

function sendChat() {
  const inp = document.getElementById('msgin');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  const id = 'm' + (msgSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
  addChannelMsg('YOU', text, 'me');
  floodMessage({ id, text, from: { kind: 'player' }, isAck: false });
}

// Simulated flood: the message hops repeater-to-repeater in waves. Each
// repeater checks the message id and repeats it exactly once; every client
// (person) that hears it flashes green for 10 s.
function floodMessage(msg) {
  W.floodQueue.push(msg);
  pumpFlood();
}
async function pumpFlood() {
  if (W.flooding) return;
  const msg = W.floodQueue.shift();
  if (!msg) return;
  W.flooding = true;
  try {
    const { SIZE, GRID } = SIG;
    const repeated = new Set(); // repeater hashes that already handled this id
    let wave = [msg.from];
    for (let depth = 0; depth < 14 && wave.length; depth++) {
      await sleep(450);
      const next = [];
      for (const sender of wave) {
        const sp = nodePos(sender);
        for (const r of W.repeaters) {
          if (repeated.has(r.hash)) continue;
          if (sender.kind === 'rep' && sender.ref === r) continue;
          const s = linkStrength(W.world.heights, GRID, SIZE, W.treeGrid, sp.x, sp.z, sp.h, r.x, r.z, r.antH);
          if (s > SIG.REACH_T) {
            repeated.add(r.hash); // id check: repeat once, never again
            r.seenIds.add(msg.id);
            r.flashUntil = performance.now() + 900;
            next.push({ kind: 'rep', ref: r });
          }
        }
        for (const p of W.people) {
          if (sender.kind === 'person' && sender.ref === p) continue;
          const s = linkStrength(W.world.heights, GRID, SIZE, W.treeGrid, sp.x, sp.z, sp.h, p.x, p.z, 1.5);
          if (s > SIG.REACH_T) {
            flashPerson(p);
            if (!msg.isAck && msg.from.kind === 'player' && p.acked !== msg.id) {
              p.acked = msg.id;
              setTimeout(() => {
                const aid = 'm' + (msgSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
                addChannelMsg(p.hash.slice(0, 4).toUpperCase(), '✓ got it', 'ack');
                floodMessage({ id: aid, text: '', from: { kind: 'person', ref: p }, isAck: true });
              }, 700 + Math.random() * 1400);
            }
          }
        }
      }
      wave = next;
    }
  } finally {
    W.flooding = false;
    pumpFlood();
  }
}

function showDevTab(which) {
  const tr = document.getElementById('tab-rep'), tc = document.getElementById('tab-ch');
  const rep = which === 'rep';
  tr.classList.toggle('on', rep); tc.classList.toggle('on', !rep);
  document.getElementById('pane-rep').style.display = rep ? 'block' : 'none';
  document.getElementById('pane-ch').style.display = rep ? 'none' : 'block';
}

function wireDevice() {
  document.getElementById('devbtn').onclick = devToggle;
  document.getElementById('devx').onclick = devClose;
  document.getElementById('dscan').onclick = discoverRepeaters;
  document.getElementById('send').onclick = sendChat;
  document.getElementById('ppwr').onclick = devClose;
  document.getElementById('ppscan').onclick = discoverRepeaters;
  document.getElementById('ppch').onclick = () => showDevTab(
    document.getElementById('pane-ch').style.display === 'none' ? 'ch' : 'rep');
  document.getElementById('msgin').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
    e.stopPropagation();
  });
  document.getElementById('tab-rep').onclick = () => showDevTab('rep');
  document.getElementById('tab-ch').onclick = () => showDevTab('ch');
}

/* ================= HUD & input ================= */
function setStat(id, txt) { document.getElementById('st-' + id).textContent = txt; }

function wireUI() {
  wireDevice();
  document.getElementById('drop').onclick = () => { hideHelp(); dropRepeater(); };
  document.getElementById('scan').onclick = () => { hideHelp(); scanPreview(); };
  document.getElementById('mapbtn').onclick = () => toggleMap();
  document.getElementById('newmap').onclick = () => buildWorld((Math.random() * 1e9) | 0);
  const sl = document.getElementById('ant');
  sl.oninput = () => {
    W.antH = +sl.value;
    document.getElementById('antval').textContent = W.antH + ' m';
  };
  W.antH = +sl.value;
  mapEl.addEventListener('click', (e) => {
    if (mapEl.classList.contains('expanded')) setWaypointFromEvent(e);
    else toggleMap(true);
  });
  helpEl.addEventListener('click', () => {
    hideHelp();
    lockPointer();
  });
  // clicking the 3D view also captures the mouse (when the map is closed)
  renderer.domElement.addEventListener('click', () => {
    if (!helpEl.classList.contains('hidden') || mapEl.classList.contains('expanded')) return;
    lockPointer();
  });
}
function hideHelp() { helpEl.classList.add('hidden'); }
let toastTimer = 0;
function showToast(msg, ms) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, ms || 2600);
}
function lockPointer() {
  if (IS_TOUCH || document.pointerLockElement) return;
  try {
    const p = renderer.domElement.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
}

function wireInput() {
  addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space') e.preventDefault();
    W.keys[e.code] = true;
    if (e.code === 'KeyE') { hideHelp(); dropRepeater(); }
    if (e.code === 'KeyQ') { hideHelp(); scanPreview(); }
    if (e.code === 'KeyM') toggleMap();
    if (e.code === 'KeyB') devToggle();
    if (e.code === 'KeyX') { W.waypoint = null; waypointMesh.visible = false; }
    if (e.code === 'Escape' && mapEl.classList.contains('expanded')) toggleMap(false);
  });
  addEventListener('keyup', (e) => { W.keys[e.code] = false; });

  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && !IS_TOUCH && !mapEl.classList.contains('expanded')
        && helpEl.classList.contains('hidden'))
      showToast('click the view to capture the mouse');
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement) {
      W.player.yaw -= e.movementX * 0.0026;
      W.player.pitch = clamp(W.player.pitch - e.movementY * 0.0026, -1.45, 1.45);
    }
  });

  // touch: left joystick moves, canvas drag looks
  const joy = document.getElementById('joy'), knob = document.getElementById('joyknob');
  let joyId = null, joyOX = 0, joyOY = 0;
  const joyVec = { x: 0, y: 0 };
  W.joyVec = joyVec;
  joy.addEventListener('pointerdown', (e) => {
    joyId = e.pointerId; joyOX = e.clientX; joyOY = e.clientY;
    joy.setPointerCapture(e.pointerId);
  });
  joy.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joyId) return;
    const dx = clamp(e.clientX - joyOX, -44, 44), dy = clamp(e.clientY - joyOY, -44, 44);
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    joyVec.x = dx / 44; joyVec.y = dy / 44;
  });
  const joyEnd = (e) => {
    if (e.pointerId !== joyId) return;
    joyId = null; joyVec.x = joyVec.y = 0;
    knob.style.transform = '';
  };
  joy.addEventListener('pointerup', joyEnd);
  joy.addEventListener('pointercancel', joyEnd);

  let lookId = null, lx = 0, ly = 0, tapOX = 0, tapOY = 0, tapT = 0;
  const cv = renderer.domElement;
  cv.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && lookId === null) {
      lookId = e.pointerId; lx = e.clientX; ly = e.clientY;
      tapOX = e.clientX; tapOY = e.clientY; tapT = performance.now();
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    W.player.yaw -= (e.clientX - lx) * 0.005;
    W.player.pitch = clamp(W.player.pitch - (e.clientY - ly) * 0.005, -1.45, 1.45);
    lx = e.clientX; ly = e.clientY;
  });
  const lookEnd = (e) => {
    if (e.pointerId !== lookId) return;
    lookId = null;
    // touch: a tap (not a drag) on the 3D view closes the expanded map
    if (e.pointerType === 'touch' && mapEl.classList.contains('expanded') &&
        Math.hypot(e.clientX - tapOX, e.clientY - tapOY) < 12 &&
        performance.now() - tapT < 350) toggleMap(false);
  };
  cv.addEventListener('pointerup', lookEnd);
  cv.addEventListener('pointercancel', lookEnd);
}

/* ================= movement ================= */
function stepPlayer(dt) {
  const P = W.player, { SIZE, GRID } = SIG;
  const k = W.keys;
  let fw = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
  let st = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
  if (W.joyVec) { fw += -W.joyVec.y; st += W.joyVec.x; }
  const mag = Math.hypot(fw, st);
  if (mag > 0.01) {
    const sp = (k.ShiftLeft || k.ShiftRight ? 70 : 7); // run is 10x walk
    const nfw = fw / Math.max(1, mag), nst = st / Math.max(1, mag);
    const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
    // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
    P.x += (-sy * nfw + cy * nst) * sp * dt;
    P.z += (-cy * nfw - sy * nst) * sp * dt;
  }
  P.x = clamp(P.x, 16, SIZE - 16);
  P.z = clamp(P.z, 16, SIZE - 16);
  // building collision: push out of footprints
  for (const b of W.buildings) {
    const dx = P.x - b.x, dz = P.z - b.z;
    const r = 0.5 * Math.hypot(b.w, b.d) * 0.8 + 1.4;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      P.x = b.x + dx / d * r; P.z = b.z + dz / d * r;
    }
  }
  const gy = sampleH(W.world.heights, GRID, SIZE, P.x, P.z) + 1.7;
  P.eyeY += (gy - P.eyeY) * Math.min(1, 30 * dt); // fast follow: no lag, no bobbing
  if (P.eyeY < gy) P.eyeY = gy;                  // hard floor: never clip into the ground
  camera.position.set(P.x, P.eyeY, P.z);
  camera.rotation.y = P.yaw;
  camera.rotation.x = P.pitch;
}

/* ================= frame ================= */
let lastT = 0;
function tick(t) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
  const tt = t / 1000;

  stepPlayer(dt); // movement, collision, eye height, camera pose
  stepReveal(dt);

  // life: beacons, rings, waypoint bob
  for (const g of repeaterGroups) {
    const b = g.userData.beacon;
    if (!b) continue;
    if (performance.now() < (g.userData.rep.flashUntil || 0)) b.material.color.setRGB(1, 1, 1);
    else b.material.color.setRGB(0.2, 0.6 + 0.4 * Math.sin(tt * 4 + g.position.x), 0.2);
  }
  for (const g of personMeshes) {
    const r = g.userData.ring;
    const flashing = performance.now() < g.userData.flashUntil;
    const s = 1 + 0.18 * Math.sin(tt * 3 + g.position.x);
    if (flashing) {
      r.scale.set(s * 1.9, s * 1.9, 1);
      r.material.color.setHex(0x66ff88);
      r.material.opacity = 1;
    } else {
      r.scale.set(s, s, 1);
      r.material.color.setHex(g.userData.reached ? 0x33dd55 : 0xff5533);
      r.material.opacity = 0.8;
    }
  }
  if (W.waypoint) {
    const { SIZE, GRID } = SIG;
    waypointMesh.visible = true;
    waypointMesh.position.set(W.waypoint.x,
      sampleH(W.world.heights, GRID, SIZE, W.waypoint.x, W.waypoint.z) + 10 + Math.sin(tt * 2.5) * 1.5,
      W.waypoint.z);
    waypointMesh.rotation.y = tt * 1.5;
  } else if (waypointMesh) waypointMesh.visible = false;

  drawMinimap();
  renderer.render(scene, camera);
}

window.__sig = { W, buildWorld, dropRepeater, scanPreview, toggleMap };
addEventListener('load', init);
