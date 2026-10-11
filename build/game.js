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

// Workshop: walk-in building with workbench, computer, and part boxes.
// Returns { group, walls, bench, computer, boxes }.
function buildWorkshop(b, H) {
  const { SIZE, GRID } = SIG;
  const gy = sampleH(H, GRID, SIZE, b.x, b.z);
  const group = new THREE.Group();
  const walls = []; // {x1,z1,x2,z2} AABBs for collision
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x8a6f4d });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0x5a4632 });
  
  const W2 = 6, D2 = 5, HT = 4, TH = 0.3; // half-width, half-depth, height, thickness
  const cx = b.x, cz = b.z;
  
  function addWall(x1, z1, x2, z2) {
    const w = Math.abs(x2 - x1) || TH, d = Math.abs(z2 - z1) || TH;
    const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, TH), HT, Math.max(d, TH)), wallMat);
    m.position.set(mx, gy + HT / 2, mz);
    group.add(m);
    walls.push({ x1: Math.min(x1, x2) - TH/2, z1: Math.min(z1, z2) - TH/2,
                 x2: Math.max(x1, x2) + TH/2, z2: Math.max(z1, z2) + TH/2 });
  }
  
  // back wall (+z)
  addWall(cx - W2, cz + D2, cx + W2, cz + D2);
  // front wall (-z) with 2m door gap in center
  addWall(cx - W2, cz - D2, cx - 1, cz - D2);
  addWall(cx + 1, cz - D2, cx + W2, cz - D2);
  // side walls
  addWall(cx - W2, cz - D2, cx - W2, cz + D2);
  addWall(cx + W2, cz - D2, cx + W2, cz + D2);
  
  // roof
  const roof = new THREE.Mesh(new THREE.BoxGeometry(W2*2 + 1, 0.3, D2*2 + 1), trimMat);
  roof.position.set(cx, gy + HT + 0.15, cz);
  group.add(roof);
  
  // floor
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W2*2, 0.1, D2*2),
    new THREE.MeshLambertMaterial({ color: 0x6b5b45 }));
  floor.position.set(cx, gy + 0.05, cz);
  group.add(floor);
  
  // workbench: against back wall
  const bench = new THREE.Group();
  const bTop = new THREE.Mesh(new THREE.BoxGeometry(4, 0.15, 1.2),
    new THREE.MeshLambertMaterial({ color: 0x7a5c3e }));
  bTop.position.set(cx, gy + 1.0, cz + 3.5);
  bench.add(bTop);
  for (const sx of [-1.8, 1.8]) for (const sz of [-0.5, 0.5]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.12), trimMat);
    leg.position.set(cx + sx, gy + 0.5, cz + 3.5 + sz);
    bench.add(leg);
  }
  group.add(bench);
  
  // computer: monitor on bench, screen faces -z (into room)
  const comp = new THREE.Group();
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.3, 0.15), trimMat);
  stand.position.set(cx - 1.2, gy + 1.2, cz + 3.5);
  comp.add(stand);
  const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.08),
    new THREE.MeshLambertMaterial({ color: 0x222222 }));
  monitor.position.set(cx - 1.2, gy + 1.55, cz + 3.5);
  monitor.userData.isComputer = true;
  comp.add(monitor);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.35),
    new THREE.MeshBasicMaterial({ color: 0x1a3a5a }));
  screen.position.set(cx - 1.2, gy + 1.55, cz + 3.5 - 0.045);
  screen.rotation.y = Math.PI; // face -z
  screen.userData.isComputer = true;
  comp.add(screen);
  // keyboard
  const kb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.2),
    new THREE.MeshLambertMaterial({ color: 0x333333 }));
  kb.position.set(cx - 1.2, gy + 1.1, cz + 3.0);
  comp.add(kb);
  group.add(comp);
  
  // 10 box slots on bench (5x2 grid)
  const boxes = []; // {slot, mesh, part}
  const slotX0 = cx + 0.2, slotZ0 = cz + 3.2;
  for (let i = 0; i < 10; i++) {
    const sx = slotX0 + (i % 5) * 0.65;
    const sz = slotZ0 + Math.floor(i / 5) * 0.65;
    boxes.push({ slot: i, x: sx, z: sz, y: gy + 1.15, mesh: null, part: null });
  }
  
  // interior light
  const light = new THREE.PointLight(0xffe0b0, 1.2, 20);
  light.position.set(cx, gy + 3.2, cz);
  group.add(light);
  
  return { group, walls, benchPos: { x: cx, z: cz + 3.5, y: gy + 1.0 }, computer: comp, boxes, cx, cz, gy };
}

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
  W.roadMeshCount = 0;
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
        const h1 = sampleH(H, GRID, SIZE, p.x + nx, p.z + nz2) + 0.1;
        const h2 = sampleH(H, GRID, SIZE, p.x - nx, p.z - nz2) + 0.1;
        vp.push(p.x + nx, h1, p.z + nz2, p.x - nx, h2, p.z - nz2);
        if (i > 0) { const b = i * 2; idx.push(b - 2, b, b - 1, b - 1, b, b + 1); }
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(vp, 3));
      rg.setIndex(idx); rg.computeVertexNormals();
      worldGroup.add(new THREE.Mesh(rg, roadMat));
      W.roadMeshCount++;
    }
  }

  // buildings
  W.buildings = placeBuildings(world, 16);
  {
    const byType = { house: [], barn: [], store: [] };
    W.buildings.forEach(b => { if (b.type !== 'workshop') byType[b.type].push(b); });
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

  // workshops: walk-in buildings with workbench + computer
  W.workshops = [];
  for (const b of W.buildings) {
    if (b.type !== 'workshop') continue;
    const ws = buildWorkshop(b, H);
    W.workshops.push(ws);
    worldGroup.add(ws.group);
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
  const skinTones = [0xe8b98a, 0xd4a06a, 0xb87e4a, 0x8a5a32, 0xf0c8a0];
  const shirtColors = [0x4a7ac8, 0xc84a4a, 0x4ac86a, 0xc8a44a, 0x8a4ac8, 0x4ac8c0, 0xe07a3a];
  const pantsColors = [0x3a4a5a, 0x5a4a3a, 0x2a3a4a, 0x4a5a3a];
  for (const p of W.people) {
    const g = new THREE.Group();
    const gy = sampleH(H, GRID, SIZE, p.x, p.z);
    const prng = mulberry32(p.hash.charCodeAt(0) * 7919 + p.hash.charCodeAt(1));
    const skin = skinTones[(prng() * skinTones.length) | 0];
    const shirt = shirtColors[(prng() * shirtColors.length) | 0];
    const pants = pantsColors[(prng() * pantsColors.length) | 0];
    const skinMat = new THREE.MeshLambertMaterial({ color: skin });
    const shirtMat = new THREE.MeshLambertMaterial({ color: shirt });
    const pantsMat = new THREE.MeshLambertMaterial({ color: pants });
    
    // legs (two stubby cylinders)
    for (const sx of [-0.14, 0.14]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.5, 8), pantsMat);
      leg.position.set(sx, 0.25, 0);
      g.add(leg);
      // shoe
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.3),
        new THREE.MeshLambertMaterial({ color: 0x2a2018 }));
      shoe.position.set(sx, 0.06, 0.05);
      g.add(shoe);
    }
    // body: tapered cylinder (shirt)
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 0.75, 10), shirtMat);
    body.position.y = 0.875;
    g.add(body);
    // arms
    for (const sx of [-0.42, 0.42]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.6, 8), shirtMat);
      arm.position.set(sx, 0.9, 0);
      arm.rotation.z = sx > 0 ? 0.08 : -0.08; // tops tilt slightly inward
      g.add(arm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), skinMat);
      hand.position.set(sx * 1.02, 0.58, 0);
      g.add(hand);
    }
    // big cartoony head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 14, 12), skinMat);
    head.position.y = 1.62;
    head.scale.y = 1.1;
    g.add(head);
    // eyes (white + pupils, facing +z)
    for (const sx of [-0.13, 0.13]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8),
        new THREE.MeshLambertMaterial({ color: 0xffffff }));
      eye.position.set(sx, 1.68, 0.3);
      g.add(eye);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 8),
        new THREE.MeshLambertMaterial({ color: 0x1a1a1a }));
      pupil.position.set(sx, 1.68, 0.355);
      g.add(pupil);
    }
    // hair cap (half-sphere, random dark color)
    const hairColors = [0x2a1a0a, 0x4a2a0a, 0x1a1a1a, 0x6a4a2a, 0x8a8a8a];
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.375, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
      new THREE.MeshLambertMaterial({ color: hairColors[(prng() * hairColors.length) | 0] }));
    hair.position.y = 1.66;
    g.add(hair);
    // random yaw so they don't all face the same way
    g.rotation.y = prng() * Math.PI * 2;
    
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.6, 24), new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.6;
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 46, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    pillar.position.y = 23;
    g.add(ring, pillar);
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
function workshopFromTap(cx, cy) {
  const rect = renderer.domElement.getBoundingClientRect();
  const nx = ((cx - rect.left) / rect.width) * 2 - 1;
  const ny = -((cy - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera({ x: nx, y: ny }, camera);
  const targets = [];
  for (const ws of W.workshops || []) targets.push(ws.group);
  const hits = raycaster.intersectObjects(targets, true);
  if (!hits.length) return null;
  const o = hits[0].object;
  if (o.userData.isComputer) return { type: 'computer' };
  if (o.userData.boxSlot) return { type: 'box', slot: o.userData.boxSlot, workshop: o.userData.workshop };
  return null;
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
  // real OSM roads
  if (W.world.roads && W.world.roads.length) {
    mmCtx.strokeStyle = '#3a3a3a'; mmCtx.lineWidth = 2; mmCtx.lineCap = 'round';
    for (const road of W.world.roads) {
      mmCtx.beginPath();
      road.pts.forEach((p, i) => {
        const x = p.x * k, z = p.z * k;
        if (i === 0) mmCtx.moveTo(x, z); else mmCtx.lineTo(x, z);
      });
      mmCtx.stroke();
    }
  }
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
  document.getElementById('store-close').onclick = () => {
    document.getElementById('storedlg').classList.add('hidden');
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
      if (rep) { showRepMenu(rep); return; }
      const ws = workshopFromTap(innerWidth / 2, innerHeight / 2);
      if (ws) { handleWorkshopTap(ws); return; }
      return;
    }
    // workshop taps work on touch too
    const wsTap = workshopFromTap(e.clientX, e.clientY);
    if (wsTap) { handleWorkshopTap(wsTap); return; }
    if (IS_TOUCH) return;
    const rep = repeaterFromTap(e.clientX, e.clientY);
    if (rep) { showRepMenu(rep); return; }
    lockPointer();
  });
}
function handleWorkshopTap(ws) {
  if (ws.type === 'computer') openStore();
  else if (ws.type === 'box') unboxPart(ws.workshop, ws.slot);
}
function unboxPart(workshop, slot) {
  if (!slot.mesh || slot.part) return;
  // remove box, add part model
  workshop.group.remove(slot.mesh);
  slot.mesh = null;
  const part = makePartModel(slot.partId);
  part.position.set(slot.x, slot.y, slot.z);
  workshop.group.add(part);
  slot.part = part;
  showToast(slot.partName + ' unboxed');
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
  // building collision: push out of footprints (workshops use wall collision instead)
  for (const b of W.buildings) {
    if (b.type === 'workshop') continue;
    const dx = P.x - b.x, dz = P.z - b.z;
    const r = 0.5 * Math.hypot(b.w, b.d) * 0.8 + 1.4;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      P.x = b.x + dx / d * r; P.z = b.z + dz / d * r;
    }
  }
  // workshop walls: AABB push-out (door gap lets you walk in)
  if (W.workshops) for (const ws of W.workshops) {
    for (const wl of ws.walls) {
      const pr = 0.5; // player radius
      if (P.x > wl.x1 - pr && P.x < wl.x2 + pr && P.z > wl.z1 - pr && P.z < wl.z2 + pr) {
        // push out along smallest penetration
        const dx1 = P.x - (wl.x1 - pr), dx2 = (wl.x2 + pr) - P.x;
        const dz1 = P.z - (wl.z1 - pr), dz2 = (wl.z2 + pr) - P.z;
        const m = Math.min(dx1, dx2, dz1, dz2);
        if (m === dx1) P.x = wl.x1 - pr;
        else if (m === dx2) P.x = wl.x2 + pr;
        else if (m === dz1) P.z = wl.z1 - pr;
        else P.z = wl.z2 + pr;
      }
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
    // clip to map bounds: drop points far outside, split ways at gaps
    const clipped = [];
    for (const r of roads) {
      let seg = [];
      for (const p of r.pts) {
        if (p.x >= -50 && p.x <= SIZE_M + 50 && p.z >= -50 && p.z <= SIZE_M + 50) {
          seg.push(p);
        } else if (seg.length >= 2) {
          clipped.push({ pts: seg, w: r.w }); seg = [];
        } else seg = [];
      }
      if (seg.length >= 2) clipped.push({ pts: seg, w: r.w });
    }
    dbg.clippedCount = clipped.length;
    onProgress(`found ${clipped.length} roads (${dbg.nodeCount} nodes, ${dbg.wayCount} ways)`);
    return clipped;
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

/* ================= parts store ================= */
const STORE = {
  'Boards': [
    { id: 'rak-mini', name: 'RAK mini', desc: 'RAK19003 base + RAK4631 core', price: 29 },
  ],
  'Batteries': [],
  'Antennas': [],
  'Cases': [],
  'Solar Panels': [],
  'Enclosures': [],
};
let storeCat = 'Boards';
function renderStore() {
  const cats = document.getElementById('store-cats');
  cats.innerHTML = '';
  for (const c of Object.keys(STORE)) {
    const b = document.createElement('button');
    b.textContent = c + (STORE[c].length ? ` (${STORE[c].length})` : '');
    if (c === storeCat) b.classList.add('active');
    b.onclick = () => { storeCat = c; renderStore(); };
    cats.appendChild(b);
  }
  const items = document.getElementById('store-items');
  items.innerHTML = '';
  for (const it of STORE[storeCat]) {
    const d = document.createElement('div');
    d.className = 'store-item';
    d.innerHTML = `<div class="nm"><b>${it.name}</b><span>${it.desc}</span></div>
      <div class="price">$${it.price}</div>`;
    const buy = document.createElement('button');
    buy.textContent = 'buy';
    buy.onclick = () => buyPart(it);
    d.appendChild(buy);
    items.appendChild(d);
  }
  if (!STORE[storeCat].length) {
    items.innerHTML = '<div style="color:#9fb0c3;font-size:13px;padding:12px;">No parts yet — check back soon.</div>';
  }
}
function openStore() {
  document.getElementById('storedlg').classList.remove('hidden');
  renderStore();
}
function buyPart(item) {
  // find the workshop the player is in (nearest)
  let best = null, bd = 1e9;
  for (const ws of W.workshops || []) {
    const d = Math.hypot(W.player.x - ws.cx, W.player.z - ws.cz);
    if (d < bd) { bd = d; best = ws; }
  }
  if (!best || bd > 20) { showToast('get closer to a workbench'); return; }
  const slot = best.boxes.find(b => !b.mesh && !b.part);
  if (!slot) { showToast('bench is full (10 boxes)'); return; }
  // create cardboard box
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.5),
    new THREE.MeshLambertMaterial({ color: 0xa0784a }));
  box.position.y = 0.175;
  g.add(box);
  const tape = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.06, 0.12),
    new THREE.MeshLambertMaterial({ color: 0xd0c0a0 }));
  tape.position.y = 0.35;
  g.add(tape);
  g.position.set(slot.x, slot.y, slot.z);
  // make tappable
  g.traverse(o => { o.userData.boxSlot = slot; o.userData.workshop = best; });
  slot.mesh = g;
  slot.partId = item.id;
  slot.partName = item.name;
  best.group.add(g);
  document.getElementById('storedlg').classList.add('hidden');
  showToast(item.name + ' ordered — tap the box to unbox');
}

/* ================= part models ================= */
function makePartModel(partId) {
  const g = new THREE.Group();
  if (partId === 'rak-mini') {
    // RAK19003 WisBlock base + RAK4631 core (from reference image)
    // Black PCB, portrait orientation
    const pcb = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.34),
      new THREE.MeshLambertMaterial({ color: 0x0a0a0a }));
    pcb.position.y = 0.01;
    g.add(pcb);
    // RAK4631 core module: large white/silver shield in center
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.025, 0.16),
      new THREE.MeshLambertMaterial({ color: 0xd8d8d8 }));
    core.position.set(0, 0.032, 0.01);
    g.add(core);
    // RAK logo mark on the module (dark square)
    const logo = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.006, 0.04),
      new THREE.MeshLambertMaterial({ color: 0x333333 }));
    logo.position.set(-0.03, 0.047, -0.03);
    g.add(logo);
    // USB-C connector at top edge (silver)
    const usb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.025, 0.035),
      new THREE.MeshLambertMaterial({ color: 0xb0b0b0 }));
    usb.position.set(0.03, 0.032, -0.155);
    g.add(usb);
    // White JST connectors (top-left 2-pin, top-right 3-pin)
    const jstMat = new THREE.MeshLambertMaterial({ color: 0xf0f0f0 });
    const jst1 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.025, 0.03), jstMat);
    jst1.position.set(-0.07, 0.032, -0.14);
    g.add(jst1);
    const jst2 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.025, 0.03), jstMat);
    jst2.position.set(0.085, 0.032, -0.135);
    g.add(jst2);
    // 4 large gold mounting holes at corners
    const goldMat = new THREE.MeshLambertMaterial({ color: 0xd4af37 });
    for (const [hx, hz] of [[-0.095, -0.145], [0.095, -0.145], [-0.095, 0.145], [0.095, 0.145]]) {
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.024, 12), goldMat);
      hole.position.set(hx, 0.022, hz);
      g.add(hole);
      const holeInner = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.026, 8),
        new THREE.MeshLambertMaterial({ color: 0x000000 }));
      holeInner.position.set(hx, 0.022, hz);
      g.add(holeInner);
    }
    // Gold pin headers along left and right edges
    for (const sx of [-0.105, 0.105]) {
      for (let i = 0; i < 8; i++) {
        const pin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.02, 0.012), goldMat);
        pin.position.set(sx, 0.03, -0.1 + i * 0.028);
        g.add(pin);
      }
    }
    // Small SMD components (resistors/caps)
    const smdMat = new THREE.MeshLambertMaterial({ color: 0x4a3a2a });
    const positions = [[-0.05, 0.09], [0.05, 0.09], [-0.05, -0.08], [0.06, 0.06], [-0.06, -0.04]];
    for (const [px, pz] of positions) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.01, 0.01), smdMat);
      c.position.set(px, 0.025, pz);
      g.add(c);
    }
    // Small green LED
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.012, 0.015),
      new THREE.MeshLambertMaterial({ color: 0x00aa00, emissive: 0x003300 }));
    led.position.set(0.04, 0.026, 0.1);
    g.add(led);
  }
  return g;
}

window.__sig = { W, buildWorld, dropRepeater, runMapScan, toggleMap, showRepMenu, hideRepMenu, deleteRepeater, PK };
addEventListener('load', init);
