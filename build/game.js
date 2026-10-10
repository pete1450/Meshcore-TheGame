/* MeshCore signal-map game — FPV edition.
 * Walk the terrain (WASD + mouse), drop repeaters (E), preview signal (Q),
 * grow the minimap (M, animated) and click it to set a waypoint.
 */
'use strict';

const W = {
  seed: (Math.random() * 1e9) | 0,
  world: null, buildings: [], people: [], treeGrid: null,
  scan: null,                   // single map scan {x, z, cov} — one at a time
  repeaters: [],
  player: { x: 512, z: 512, yaw: 0, pitch: 0, eyeY: 60 },
  antH: 2,
  waypoint: null,                // scan target set by clicking the map
  floodQueue: [],               // pending simulated mesh messages
  flooding: false,
  keys: {},
};

const IS_TOUCH = 'ontouchstart' in window;

let renderer, scene, camera;
let terrainMesh, scanCanvas, scanCtx;
let worldGroup, personMeshes = [], repeaterGroups = [];
let waypointMesh;
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

  // single-scan overlay for the map (one scan at a time, map only)
  scanCanvas = document.createElement('canvas');
  scanCanvas.width = scanCanvas.height = SIG.GRID;
  scanCtx = scanCanvas.getContext('2d');

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

function buildWorld(seed, worldOverride) {
  W.seed = seed;
  if (worldGroup) { scene.remove(worldGroup); disposeGroup(worldGroup); }
  worldGroup = new THREE.Group();
  scene.add(worldGroup);
  personMeshes = []; repeaterGroups = [];
  W.repeaters = [];
  W.scan = null; W.waypoint = null;
  W.floodQueue = []; W.flooding = false;
  if (waypointMesh) { waypointMesh.visible = false; }
  scanCtx.clearRect(0, 0, SIG.GRID, SIG.GRID);
  hideRepMenu();
  setStat('scan', '—');

  const world = worldOverride || generateMap(seed);
  W.world = world;
  W.mapLabel = world.real ? world.label : null;
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
  let mat;
  if (world.groundTexture) {
    const tex = new THREE.CanvasTexture(world.groundTexture);
    tex.anisotropy = 4;
    mat = new THREE.MeshLambertMaterial({ map: tex });
  } else {
    mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    mat.onBeforeCompile = (sh) => {
    mat.userData.sh = sh;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = position.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 hc = mix(vec3(0.16,0.36,0.15), vec3(0.45,0.40,0.23), smoothstep(120.0, 260.0, vH));
        hc = mix(hc, vec3(0.58,0.57,0.60), smoothstep(260.0, 390.0, vH));
        hc = mix(hc, vec3(0.90,0.92,0.94), smoothstep(420.0, 470.0, vH));
        float f50 = abs(fract(vH/50.0+0.5)-0.5)*50.0;
        float f250 = abs(fract(vH/250.0+0.5)-0.5)*250.0;
        hc = mix(hc, vec3(0.15,0.12,0.09), clamp((1.0-smoothstep(0.0,4.5,f50))*0.30 + (1.0-smoothstep(0.0,8.0,f250))*0.32, 0.0, 0.55));
        diffuseColor.rgb = hc;`);
    };
  }
  terrainMesh = new THREE.Mesh(geo, mat);
  worldGroup.add(terrainMesh);

  // road ribbon (procedural maps only — real terrain uses OSM roads or none)
  if (!world.real) {
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
  }
  // real OSM roads (if fetched)
  if (world.roads && world.roads.length) {
    const roadMat = new THREE.MeshLambertMaterial({ color: 0x2e2c28, polygonOffset: true, polygonOffsetFactor: -2 });
    for (const road of world.roads) {
      const pts = road.pts, w = road.w / 2;
      if (pts.length < 2) continue;
      const vp = [], idx = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
        let dx = q.x - o.x, dz = q.z - o.z;
        const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
        const nx = -dz * w, nz2 = dx * w;
        const h1 = sampleH(H, GRID, SIZE, p.x + nx, p.z + nz2) + 0.4;
        const h2 = sampleH(H, GRID, SIZE, p.x - nx, p.z - nz2) + 0.4;
        vp.push(p.x + nx, h1, p.z + nz2, p.x - nx, h2, p.z - nz2);
        if (i > 0) { const b = i * 2; idx.push(b - 2, b - 1, b, b - 1, b + 1, b); }
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(vp, 3));
      rg.setIndex(idx); rg.computeVertexNormals();
      worldGroup.add(new THREE.Mesh(rg, roadMat));
    }
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
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.0, 1.5, 8), new THREE.MeshLambertMaterial({ color: 0xff5533 }));
    body.position.y = 0.75;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.37, 8, 8), new THREE.MeshLambertMaterial({ color: 0xe8b98a }));
    head.position.y = 1.8;
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
  if (W.world.towns.length) {
    const t = W.world.towns[0];
    W.player.x = t.x; W.player.z = W.world.roadZ(t.x) + 12;
  } else {
    // real terrain: start near the center on a gentle spot
    W.player.x = SIZE / 2; W.player.z = SIZE / 2;
  }
  W.player.yaw = 0; W.player.pitch = 0;
  W.player.eyeY = sampleH(W.world.heights, GRID, SIZE, W.player.x, W.player.z) + 1.7;
}

/* ================= repeaters ================= */
function dropRepeater() {
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
  // generous invisible hitbox so taps land easily
  const hitbox = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 7, 6),
    new THREE.MeshBasicMaterial({ visible: false }));
  hitbox.position.y = 3.5;
  g.add(base, mast, panel, beacon, hitbox);
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
  updateLinked();
  setStat('rep', W.repeaters.length);
  showToast(`${rep.name} [${rep.hash.slice(0, 4).toUpperCase()}] dropped`);
}

// tap-a-repeater menu (ID + delete)
let menuRep = null;
const raycaster = new THREE.Raycaster();
function showRepMenu(rep) {
  menuRep = rep;
  document.getElementById('rm-id').textContent =
    rep.name + ' · ' + rep.hash.slice(0, 4).toUpperCase();
  document.getElementById('repmenu').classList.remove('hidden');
}
function hideRepMenu() {
  menuRep = null;
  document.getElementById('repmenu').classList.add('hidden');
}
function deleteRepeater(rep) {
  const g = rep.group;
  worldGroup.remove(g);
  g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  W.repeaters.splice(W.repeaters.indexOf(rep), 1);
  repeaterGroups.splice(repeaterGroups.indexOf(g), 1);
  hideRepMenu();
  updateLinked();
  setStat('rep', W.repeaters.length);
  showToast(`${rep.name} deleted`);
}
function repeaterFromTap(cx, cy) {
  const rect = renderer.domElement.getBoundingClientRect();
  const nx = ((cx - rect.left) / rect.width) * 2 - 1;
  const ny = -((cy - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera({ x: nx, y: ny }, camera);
  const hits = raycaster.intersectObjects(repeaterGroups, true);
  if (!hits.length) return null;
  let g = hits[0].object;
  while (g && !g.userData.rep) g = g.parent;
  return g ? g.userData.rep : null;
}

// Animated radar reveal. Merges into covAcc (or preview layer), painting
// progressively behind a rotating sweep line.
// Map scans: one at a time, map only. Click the map to set the target,
// press SCAN (or Q for your own position) to run it.
function runMapScan(x, z) {
  const { SIZE, GRID } = SIG;
  const t0 = performance.now();
  const cov = sweepCoverage(W.world.heights, W.treeGrid, x, z, 2 + 0.9); // 2 m antenna + sphere
  W.scan = { x, z, cov };
  paintScan(cov);
  drawMinimap();
  let n = 0;
  for (let i = 0; i < cov.length; i++) if (cov[i] > SIG.COVER_T) n++;
  setStat('scan', (n / cov.length * 100).toFixed(1) + '% of map');
}

function paintScan(cov) {
  const { GRID } = SIG;
  const img = scanCtx.createImageData(GRID, GRID);
  const d = img.data;
  for (let i = 0, p = 0; i < cov.length; i++, p += 4) {
    const s = cov[i];
    if (s > 0) {
      d[p] = 255; d[p + 1] = 42; d[p + 2] = 42;
      d[p + 3] = Math.round(255 * (0.22 + 0.60 * Math.min(1, s * 2.4)));
    }
  }
  scanCtx.putImageData(img, 0, 0);
}

// "Linked" = a live RF link exists from the person to any repeater.
function updateLinked() {
  const { SIZE, GRID } = SIG;
  let reached = 0;
  for (const g of personMeshes) {
    const p = g.userData.person;
    let okp = false;
    for (const r of W.repeaters) {
      const s = linkStrength(W.world.heights, GRID, SIZE, W.treeGrid,
        p.x, p.z, 1.7, r.x, r.z, r.antH + 0.9);
      if (s > SIG.REACH_T) { okp = true; break; }
    }
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
function updateStats() { updateLinked(); }

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
  if (W.scan) {
    mmCtx.globalAlpha = 0.85;
    mmCtx.drawImage(scanCanvas, 0, 0, S, S);
    mmCtx.globalAlpha = 1;
    // scan origin marker
    mmCtx.fillStyle = '#ffdd44';
    const sx = W.scan.x * k, sz = W.scan.z * k;
    mmCtx.beginPath(); mmCtx.arc(sx, sz, 6, 0, 7); mmCtx.fill();
  }
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
// Discovery: a repeater replies if a live link exists from your handheld.
function discoverRepeaters() {
  const { SIZE, GRID } = SIG;
  let n = 0;
  for (const r of W.repeaters) {
    const s = linkStrength(W.world.heights, GRID, SIZE, W.treeGrid,
      W.player.x, W.player.z, 2, r.x, r.z, r.antH + 0.9);
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
  if (n.kind === 'rep') return { x: n.ref.x, z: n.ref.z, h: n.ref.antH + 0.9 }; // antenna sphere
  return { x: n.ref.x, z: n.ref.z, h: 1.7 }; // person (client): head height
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
  document.getElementById('mapbtn').onclick = () => toggleMap();
  document.getElementById('mapscan').onclick = (e) => {
    e.stopPropagation();
    if (W.waypoint) runMapScan(W.waypoint.x, W.waypoint.z);
    else showToast('click the map to set a scan target first');
  };
  document.getElementById('rm-delete').onclick = () => { if (menuRep) deleteRepeater(menuRep); };
  document.getElementById('rm-close').onclick = hideRepMenu;
  document.getElementById('menubtn').onclick = () => {
    document.getElementById('menudlg').classList.remove('hidden');
  };
  document.getElementById('m-close').onclick = () => {
    document.getElementById('menudlg').classList.add('hidden');
  };
  document.getElementById('m-newmap').onclick = () => {
    document.getElementById('menudlg').classList.add('hidden');
    buildWorld((Math.random() * 1e9) | 0);
  };
  document.getElementById('m-realmap').onclick = () => {
    document.getElementById('menudlg').classList.add('hidden');
    document.getElementById('pickdlg').classList.remove('hidden');
    pkRender();
  };
  pkInit();
  mapEl.addEventListener('click', (e) => {
    if (mapEl.classList.contains('expanded')) setWaypointFromEvent(e);
    else toggleMap(true);
  });
  helpEl.addEventListener('click', () => {
    hideHelp();
    lockPointer();
  });
  // clicking the 3D view: repeater menu if one was clicked, else capture the mouse
  renderer.domElement.addEventListener('click', (e) => {
    if (!helpEl.classList.contains('hidden') || mapEl.classList.contains('expanded')) return;
    if (document.pointerLockElement) {
      // looking at a repeater (crosshair)? open its menu
      const rep = repeaterFromTap(innerWidth / 2, innerHeight / 2);
      if (rep) showRepMenu(rep);
      return;
    }
    if (IS_TOUCH) return;
    const rep = repeaterFromTap(e.clientX, e.clientY);
    if (rep) { showRepMenu(rep); return; }
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
    if (e.code === 'KeyQ') {
      hideHelp();
      // personal scan: map must be open; scans from your position
      if (mapEl.classList.contains('expanded')) runMapScan(W.player.x, W.player.z);
      else showToast('open the map (M) to scan');
    }
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
    if (e.pointerType !== 'touch') return;
    const isTap = Math.hypot(e.clientX - tapOX, e.clientY - tapOY) < 12 &&
                  performance.now() - tapT < 350;
    if (!isTap) return;
    // touch: a tap on the 3D view closes the expanded map…
    if (mapEl.classList.contains('expanded')) { toggleMap(false); return; }
    // …otherwise it may open a repeater's menu
    if (helpEl.classList.contains('hidden')) {
      const rep = repeaterFromTap(e.clientX, e.clientY);
      if (rep) showRepMenu(rep);
    }
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
  if (W.sky) W.sky.position.copy(camera.position); // sky dome follows the eye

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

/* ================= real-terrain picker ================= */
// OpenTopoMap viewer + zip geocode + Terrarium elevation -> 3x3 mile map
const PK = { lat: 35.7357, lon: -87.1282, zoom: 11, selLat: null, selLon: null, tiles: [] };
function pkLonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latR = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
  return { x, y };
}
function pkTileToLonLat(x, y, z) {
  const n = Math.pow(2, z);
  const lon = x / n * 360 - 180;
  const latR = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  return { lon, lat: latR * 180 / Math.PI };
}
function pkRender() {
  const el = document.getElementById('pk-map');
  const Wpx = el.clientWidth, Hpx = el.clientHeight;
  // center in world pixels
  const n = Math.pow(2, PK.zoom) * 256;
  const cx = (PK.lon + 180) / 360 * n;
  const latR = PK.lat * Math.PI / 180;
  const cy = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  // clear old tiles
  el.querySelectorAll('img').forEach(i => i.remove());
  const sub = ['a', 'b', 'c'];
  let si = 0;
  const x0 = Math.floor((cx - Wpx / 2) / 256), x1 = Math.floor((cx + Wpx / 2) / 256);
  const y0 = Math.floor((cy - Hpx / 2) / 256), y1 = Math.floor((cy + Hpx / 2) / 256);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const img = document.createElement('img');
    img.src = `https://${sub[si++ % 3]}.tile.opentopomap.org/${PK.zoom}/${tx}/${ty}.png`;
    img.style.left = (tx * 256 - (cx - Wpx / 2)) + 'px';
    img.style.top = (ty * 256 - (cy - Hpx / 2)) + 'px';
    img.draggable = false;
    el.appendChild(img);
  }
  // pin at selected (or center)
  const pin = document.getElementById('pk-pin');
  const sLat = PK.selLat !== null ? PK.selLat : PK.lat;
  const sLon = PK.selLon !== null ? PK.selLon : PK.lon;
  const sLatR = sLat * Math.PI / 180;
  const sx = (sLon + 180) / 360 * n, sy = (1 - Math.log(Math.tan(sLatR) + 1 / Math.cos(sLatR)) / Math.PI) / 2 * n;
  pin.style.display = 'block';
  pin.style.left = (sx - (cx - Wpx / 2)) + 'px';
  pin.style.top = (sy - (cy - Hpx / 2)) + 'px';
  document.getElementById('pk-coords').textContent =
    `${sLat.toFixed(5)}, ${sLon.toFixed(5)}`;
}
function pkInit() {
  const el = document.getElementById('pk-map');
  let dragging = false, sx = 0, sy = 0, moved = 0;
  const n = () => Math.pow(2, PK.zoom) * 256;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#pk-zoom')) return; // let zoom buttons handle it
    dragging = true; moved = 0; sx = e.clientX; sy = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    moved += Math.abs(dx) + Math.abs(dy); sx = e.clientX; sy = e.clientY;
    const wpp = 360 / n(); // deg lon per pixel
    PK.lon -= dx * wpp;
    const hpp = 170.1 / n(); // approx deg lat per pixel (web mercator)
    PK.lat += dy * hpp;
    PK.lat = Math.max(-85, Math.min(85, PK.lat));
    pkRender();
  });
  el.addEventListener('pointerup', (e) => {
    if (e.target.closest('#pk-zoom')) return; // zoom button, not a map tap
    dragging = false;
    if (moved < 8) { // tap: select this point
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left - r.width / 2, py = e.clientY - r.top - r.height / 2;
      const wpp = 360 / n();
      const hpp = 170.1 / n();
      PK.selLon = PK.lon + px * wpp;
      PK.selLat = PK.lat - py * hpp;
      pkRender();
    }
  });
  document.getElementById('pk-find').onclick = async () => {
    const zip = document.getElementById('pk-zip').value.trim();
    if (!zip) return;
    pkStatus('looking up ' + zip + '…');
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&countrycodes=us&format=json&limit=1`);
      const j = await r.json();
      if (!j.length) { pkStatus('zip not found'); return; }
      PK.lat = parseFloat(j[0].lat); PK.lon = parseFloat(j[0].lon);
      PK.selLat = PK.lat; PK.selLon = PK.lon;
      pkRender();
      pkStatus(j[0].display_name.split(',').slice(0, 3).join(','));
    } catch (e) { pkStatus('lookup failed: ' + e.message); }
  };
  document.getElementById('pk-cancel').onclick = () => {
    document.getElementById('pickdlg').classList.add('hidden');
  };
  document.getElementById('pk-zin').onclick = (e) => {
    e.stopPropagation();
    PK.zoom = Math.min(15, PK.zoom + 1); pkRender();
  };
  document.getElementById('pk-zout').onclick = (e) => {
    e.stopPropagation();
    PK.zoom = Math.max(8, PK.zoom - 1); pkRender();
  };
  document.getElementById('pk-generate').onclick = pkGenerate;
}
function pkStatus(t) { document.getElementById('pk-status').textContent = t; }
function pkLoadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}
// Fetch Terrarium elevation tiles for a 3x3 mile box, resample to 256x256.
async function pkFetchElevation(lat, lon, onProgress) {
  const SIZE_M = 4828, Z = 13, GRID = 256;
  const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
  const dLat = (SIZE_M / 2) / mPerDegLat, dLon = (SIZE_M / 2) / mPerDegLon;
  const t0 = pkLonLatToTile(lon - dLon, lat + dLat, Z);
  const t1 = pkLonLatToTile(lon + dLon, lat - dLat, Z);
  const tiles = [];
  for (let ty = t0.y; ty <= t1.y; ty++) for (let tx = t0.x; tx <= t1.x; tx++) tiles.push({ tx, ty });
  onProgress(`fetching ${tiles.length} elevation tiles…`);
  const tileMaps = await Promise.all(tiles.map(async ({ tx, ty }) => {
    const img = await pkLoadImage(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`);
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { tx, ty, data: g.getImageData(0, 0, 256, 256).data };
  }));
  onProgress('sampling terrain…');
  const heights = new Float32Array(GRID * GRID);
  const n = Math.pow(2, Z);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const gx = (i + 0.5) / GRID * SIZE_M - SIZE_M / 2; // m east of center
      const gz = (j + 0.5) / GRID * SIZE_M - SIZE_M / 2; // m south of center
      const pLat = lat - gz / mPerDegLat;
      const pLon = lon + gx / mPerDegLon;
      const fx = (pLon + 180) / 360 * n, fy = (1 - Math.log(Math.tan(pLat * Math.PI / 180) + 1 / Math.cos(pLat * Math.PI / 180)) / Math.PI) / 2 * n;
      const tx = Math.floor(fx), ty = Math.floor(fy);
      const px = Math.min(255, Math.max(0, Math.floor((fx - tx) * 256)));
      const py = Math.min(255, Math.max(0, Math.floor((fy - ty) * 256)));
      const t = tileMaps.find(td => td.tx === tx && td.ty === ty);
      let elev = 0;
      if (t) {
        const k = (py * 256 + px) * 4;
        elev = t.data[k] * 256 + t.data[k + 1] + t.data[k + 2] / 256 - 32768;
      }
      heights[j * GRID + i] = elev;
    }
    if ((j & 31) === 0) await new Promise(r => setTimeout(r, 0)); // keep UI alive
  }
  return heights;
}
// Fetch OpenTopoMap tiles for the 3x3 mile bbox, stitch north-up into a canvas.
async function pkFetchTexture(lat, lon, onProgress) {
  const SIZE_M = 4828, Z = 15;
  const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
  const dLat = (SIZE_M / 2) / mPerDegLat, dLon = (SIZE_M / 2) / mPerDegLon;
  const n = Math.pow(2, Z);
  // bbox in global pixel coords
  const px = (lo) => (lo + 180) / 360 * n * 256;
  const py = (la) => {
    const r = la * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n * 256;
  };
  const x0 = px(lon - dLon), x1 = px(lon + dLon);
  const y0 = py(lat + dLat), y1 = py(lat - dLat); // y0 north (smaller)
  const tx0 = Math.floor(x0 / 256), tx1 = Math.floor(x1 / 256);
  const ty0 = Math.floor(y0 / 256), ty1 = Math.floor(y1 / 256);
  const Wpx = Math.ceil(x1 - x0), Hpx = Math.ceil(y1 - y0);
  onProgress(`fetching ${(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} map tiles…`);
  const canvas = document.createElement('canvas');
  canvas.width = Wpx; canvas.height = Hpx;
  const g = canvas.getContext('2d');
  const sub = ['a', 'b', 'c'];
  let si = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const img = await pkLoadImage(`https://${sub[si++ % 3]}.tile.opentopomap.org/${Z}/${tx}/${ty}.png`);
      g.drawImage(img, tx * 256 - x0, ty * 256 - y0);
      onProgress(`fetching map tiles… ${si}/${(tx1 - tx0 + 1) * (ty1 - ty0 + 1)}`);
    }
  }
  return canvas;
}
// Fetch real roads from OpenStreetMap main API for the 3x3 mile box.
async function pkFetchRoads(lat, lon, onProgress) {
  const SIZE_M = 4828;
  const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
  const dLat = (SIZE_M / 2) / mPerDegLat, dLon = (SIZE_M / 2) / mPerDegLon;
  const south = lat - dLat, north = lat + dLat, west = lon - dLon, east = lon + dLon;
  const dbg = PK.roadDebug = { bbox: [west, south, east, north], step: 'start' };
  try {
    onProgress('fetching roads…');
    dbg.url = `https://api.openstreetmap.org/api/0.6/map?bbox=${west},${south},${east},${north}`;
    dbg.step = 'fetching';
    const r = await fetch(dbg.url);
    dbg.step = 'fetched'; dbg.status = r.status;
    if (!r.ok) throw new Error('roads fetch failed: ' + r.status);
    const xml = await r.text();
    dbg.step = 'parsing'; dbg.xmlLen = xml.length;
    dbg.xmlHead = xml.slice(0, 200);
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const parseErr = doc.getElementsByTagName('parsererror');
    if (parseErr.length) throw new Error('XML parse error: ' + parseErr[0].textContent.slice(0, 120));
    const nodes = {};
    const nodeEls = doc.getElementsByTagName('node');
    dbg.step = 'nodes'; dbg.nodeCount = nodeEls.length;
    for (const n of nodeEls) {
      nodes[n.getAttribute('id')] = {
        lat: parseFloat(n.getAttribute('lat')),
        lon: parseFloat(n.getAttribute('lon')),
      };
    }
    const widthFor = (t) => t === 'motorway' ? 14 : t === 'trunk' ? 11 : t === 'primary' ? 9 : t === 'secondary' ? 8 : 6;
    const okHwy = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service)$/;
    const roads = [];
    const wayEls = doc.getElementsByTagName('way');
    dbg.step = 'ways'; dbg.wayCount = wayEls.length;
    let hwyWays = 0;
    for (const w of wayEls) {
      let hwy = null;
      for (const t of w.getElementsByTagName('tag')) {
        if (t.getAttribute('k') === 'highway') hwy = t.getAttribute('v');
      }
      if (!hwy || !okHwy.test(hwy)) continue;
      hwyWays++;
      const pts = [];
      for (const nd of w.getElementsByTagName('nd')) {
        const n = nodes[nd.getAttribute('ref')];
        if (!n) continue;
        pts.push({
          x: (n.lon - lon) * mPerDegLon + SIZE_M / 2,
          z: (lat - n.lat) * mPerDegLat + SIZE_M / 2,
        });
      }
      if (pts.length >= 2) roads.push({ pts, w: widthFor(hwy) });
    }
    dbg.step = 'done'; dbg.hwyWays = hwyWays; dbg.roadCount = roads.length;
    onProgress(`found ${roads.length} roads (${dbg.nodeCount} nodes, ${dbg.wayCount} ways)`);
    return roads;
  } catch (e) {
    dbg.step = 'error'; dbg.error = e.message;
    throw e;
  }
}
async function pkGenerate() {
  const lat = PK.selLat !== null ? PK.selLat : PK.lat;
  const lon = PK.selLon !== null ? PK.selLon : PK.lon;
  const useTex = document.getElementById('pk-usetex').checked;
  const btn = document.getElementById('pk-generate');
  btn.disabled = true;
  try {
    const heights = await pkFetchElevation(lat, lon, pkStatus);
    let texCanvas = null;
    if (useTex) texCanvas = await pkFetchTexture(lat, lon, pkStatus);
    let roads = [];
    try { roads = await pkFetchRoads(lat, lon, pkStatus); }
    catch (e) { pkStatus('roads unavailable, continuing…'); }
    pkStatus('building map…');
    await new Promise(r => setTimeout(r, 30));
    const label = `real terrain ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    const world = generateRealMap(heights, (Math.random() * 1e9) | 0, label);
    world.roads = roads;
    if (useTex) {
      world.groundTexture = texCanvas;
      world.noForest = true;
      // no trees: override density
      world.forestDensity = () => 0;
    }
    document.getElementById('pickdlg').classList.add('hidden');
    buildWorld((Math.random() * 1e9) | 0, world);
    showToast('real terrain loaded: ' + label);
  } catch (e) {
    pkStatus('failed: ' + e.message);
  }
  btn.disabled = false;
}

window.__sig = { W, buildWorld, dropRepeater, runMapScan, toggleMap, showRepMenu, hideRepMenu, deleteRepeater, PK };
addEventListener('load', init);
