/* MeshCore signal-map game — world generation + propagation model.
 * Pure JS, no three.js dependency, so it runs under node for testing.
 * World units are meters. Map is SIZE x SIZE, heightfield GRID x GRID.
 */
'use strict';

const SIG = {
  SIZE: 4828,          // world extent (m) — 3x3 miles
  GRID: 256,           // heightfield resolution (logic)
  TREE_GRID: 128,      // tree-count grid used for foliage attenuation
  MAX_RANGE: 1300,     // sweep range for map scans (m)
  LINK_RANGE: 5000,    // max range for person/repeater links (m) — full map width
  RAY_STEP: 4,         // march step along each ray (m)
  RAY_COUNT: 720,      // 0.5-degree rays
  RX_H: 1.7,           // receiver height above ground (head/handheld, m)
  DECAY: 3000,         // very gentle distance falloff: clear LOS reaches, period
  NLOS_RANGE: 300,     // how far past the first blockage NLOS can still reach (m)
  NLOS_DEPTH: 40,      // diffraction penalty scale for depth below LOS line (m)
  TREE_K: 0.025,       // attenuation per tree per 8 m of forest, where the ray is in the canopy
  CANOPY_H: 24,        // ray height above ground below which trees attenuate (m)
  LOS_CLEAR: 3,        // terrain within this many m above the sightline still counts as radio LOS
  COVER_T: 0.06,       // strength above this counts as covered
  REACH_T: 0.10,       // strength above this counts a person as reached
  LINK_NLOS: 600,      // max distance for a non-LOS direct link (m)
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic 2D value noise.
class ValueNoise {
  constructor(seed) {
    const rng = mulberry32(seed);
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  _g(ix, iy) {
    return this.perm[(this.perm[ix & 255] + iy) & 255] / 255;
  }
  noise2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = this._g(ix, iy), b = this._g(ix + 1, iy);
    const c = this._g(ix, iy + 1), d = this._g(ix + 1, iy + 1);
    return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1; // [-1,1]
  }
  fbm(x, y, oct) {
    let v = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      v += amp * this.noise2(x * f, y * f);
      norm += amp; amp *= 0.5; f *= 2.03;
    }
    return v / norm; // [-1,1]
  }
  ridged(x, y, oct) {
    let v = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      v += amp * (1 - Math.abs(this.noise2(x * f, y * f)));
      norm += amp; amp *= 0.5; f *= 2.11;
    }
    return v / norm; // [0,1], 1 = sharp crest
  }
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Short stable node hashes (8 hex chars) for people / repeaters / player.
function nodeHash(seed, i) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (i * 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f) >>> 0; h ^= h >>> 16;
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sampleH(h, grid, size, x, z) {
  const gx = clamp01(x / size) * (grid - 1);
  const gz = clamp01(z / size) * (grid - 1);
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz;
  const jx = Math.min(ix + 1, grid - 1), jz = Math.min(iz + 1, grid - 1);
  const a = h[iz * grid + ix], b = h[iz * grid + jx];
  const c = h[jz * grid + ix], d = h[jz * grid + jx];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

// ---- world generation -------------------------------------------------

const TOWN_NAMES = ['Cedar Gap', 'Holler Creek', 'Piney Flats', 'Buzzard Roost', 'Laurel Fork', 'Sandy Ridge'];

function generateMap(seed) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const nz = new ValueNoise(seed);
  const { SIZE, GRID } = SIG;
  const raw = new Float32Array(GRID * GRID);

  // Big dramatic relief: deep holler floors near 0 m, sharp crests to ~500 m.
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
      const x = (ix / (GRID - 1)) * SIZE, z = (iz / (GRID - 1)) * SIZE;
      const nx = x * 0.0042, nz2 = z * 0.0042;
      const roll = (nz.fbm(nx, nz2, 5) + 1) / 2;                 // 0..1
      const ridge = nz.ridged(nx * 0.6 + 7.3, nz2 * 0.6 - 3.1, 4); // 0..1
      raw[iz * GRID + ix] = 500 * (0.30 * roll + 0.70 * Math.pow(ridge, 1.25)); // 0..500 m
    }
  }

  // Two towns on flat plateaus at differing elevations, spread along x.
  const t1z = SIZE / 2 + nz.noise2(3.1, seed * 0.001) * 260;
  const t2z = SIZE / 2 + nz.noise2(9.7, seed * 0.001 + 40) * 260;
  const towns = [
    { x: SIZE * 0.29, z: t1z, r: 80, name: TOWN_NAMES[(rng() * TOWN_NAMES.length) | 0] },
    { x: SIZE * 0.71, z: t2z, r: 80, name: TOWN_NAMES[(rng() * TOWN_NAMES.length) | 0] },
  ];
  if (towns[1].name === towns[0].name) towns[1].name = TOWN_NAMES[(TOWN_NAMES.indexOf(towns[0].name) + 3) % TOWN_NAMES.length];
  const flattenTowns = () => {
    for (const t of towns) {
      for (let iz = 0; iz < GRID; iz++) {
        for (let ix = 0; ix < GRID; ix++) {
          const x = (ix / (GRID - 1)) * SIZE, z = (iz / (GRID - 1)) * SIZE;
          const d = Math.hypot(x - t.x, z - t.z);
          if (d < t.r) {
            const w = 1 - smoothstep(t.r * 0.55, t.r, d);
            const i = iz * GRID + ix;
            raw[i] = raw[i] * (1 - w) + t.elev * w;
          }
        }
      }
    }
  };
  for (const t of towns) t.elev = sampleH(raw, GRID, SIZE, t.x, t.z);
  flattenTowns();

  // Slope limit: no steeper than 45° (1m vertical per 1m horizontal).
  // Applied to natural terrain before road/towns; keeps peaks, rounds cliffs.
  {
    const cell = SIZE / (GRID - 1);
    const maxD = cell * 1.0; // tan(45°) = 1
    for (let pass = 0; pass < 300; pass++) {
      let changed = false;
      for (let iz = 0; iz < GRID; iz++) {
        for (let ix = 0; ix < GRID; ix++) {
          const i = iz * GRID + ix;
          if (ix > 0) {
            const d = raw[i] - raw[i - 1];
            if (d > maxD) { raw[i] = raw[i - 1] + maxD; changed = true; }
            else if (d < -maxD) { raw[i] = raw[i - 1] - maxD; changed = true; }
          }
          if (iz > 0) {
            const d = raw[i] - raw[i - GRID];
            if (d > maxD) { raw[i] = raw[i - GRID] + maxD; changed = true; }
            else if (d < -maxD) { raw[i] = raw[i - GRID] - maxD; changed = true; }
          }
        }
      }
      for (let iz = GRID - 1; iz >= 0; iz--) {
        for (let ix = GRID - 1; ix >= 0; ix--) {
          const i = iz * GRID + ix;
          if (ix < GRID - 1) {
            const d = raw[i] - raw[i + 1];
            if (d > maxD) { raw[i] = raw[i + 1] + maxD; changed = true; }
            else if (d < -maxD) { raw[i] = raw[i + 1] - maxD; changed = true; }
          }
          if (iz < GRID - 1) {
            const d = raw[i] - raw[i + GRID];
            if (d > maxD) { raw[i] = raw[i + GRID] + maxD; changed = true; }
            else if (d < -maxD) { raw[i] = raw[i + GRID] - maxD; changed = true; }
          }
        }
      }
      if (!changed) break;
    }
  }

  // Single road through both towns, single-valued in x, with a gentle wiggle.
  const [t1, t2] = towns;
  const townDist = (x, z) => Math.min(...towns.map(t => Math.hypot(x - t.x, z - t.z)));
  const roadDist = (x, z) => Math.abs(z - roadZ(x));
  const roadZ = (x) => {
    const t = clamp01((x - t1.x) / (t2.x - t1.x));
    return t1.z + (t2.z - t1.z) * t + nz.noise2(x * 0.008, 3.7) * 34;
  };
  // Smooth road profile: box-blurred along the road so the road doesn't buck
  // over the steeper terrain.
  const prof = new Float32Array(GRID);
  for (let ix = 0; ix < GRID; ix++) {
    const x = (ix / (GRID - 1)) * SIZE;
    let s = 0, n = 0;
    for (let k = -6; k <= 6; k++) {
      const sx = Math.min(SIZE - 40, Math.max(40, x + k * 10));
      s += sampleH(raw, GRID, SIZE, sx, roadZ(sx)); n++;
    }
    prof[ix] = s / n;
  }
  // Multi-pass wide smoothing: mountain roads need gentle grades.
  for (let pass = 0; pass < 4; pass++) {
    const q = new Float32Array(GRID);
    for (let ix = 0; ix < GRID; ix++) {
      let s = 0, n = 0;
      for (let k = -20; k <= 20; k++) {
        const j = Math.min(GRID - 1, Math.max(0, ix + k));
        s += prof[j]; n++;
      }
      q[ix] = s / n;
    }
    prof.set(q);
  }
  // Anchor the profile to each town's plateau elevation so the road meets
  // the towns with no step. Wide blend zone = gentle mountain approach.
  for (let ix = 0; ix < GRID; ix++) {
    const x = (ix / (GRID - 1)) * SIZE;
    for (const t of towns) {
      const d = Math.abs(x - t.x);
      if (d < 400) {
        const w = 1 - smoothstep(90, 400, d);
        prof[ix] = prof[ix] * (1 - w) + t.elev * w;
      }
    }
  }
  // Grade limiting: relax the profile until no step exceeds a 30% grade,
  // so the mountain road stays plausible. Town cores stay pinned.
  {
    const pinned = new Float32Array(GRID);
    for (let ix = 0; ix < GRID; ix++) {
      const x = (ix / (GRID - 1)) * SIZE;
      let p = 0;
      for (const t of towns) p = Math.max(p, 1 - smoothstep(90, 400, Math.abs(x - t.x)));
      pinned[ix] = p;
    }
    const dx = SIZE / (GRID - 1), maxD = 0.30 * dx;
    for (let pass = 0; pass < 60; pass++) {
      let changed = false;
      for (let ix = 1; ix < GRID; ix++) {
        if (pinned[ix] > 0.5) continue;
        const d = prof[ix] - prof[ix - 1];
        if (d > maxD) { prof[ix] = prof[ix - 1] + maxD; changed = true; }
        else if (d < -maxD) { prof[ix] = prof[ix - 1] - maxD; changed = true; }
      }
      for (let ix = GRID - 2; ix >= 0; ix--) {
        if (pinned[ix] > 0.5) continue;
        const d = prof[ix] - prof[ix + 1];
        if (d > maxD) { prof[ix] = prof[ix + 1] + maxD; changed = true; }
        else if (d < -maxD) { prof[ix] = prof[ix + 1] - maxD; changed = true; }
      }
      if (!changed) break;
    }
  }
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
      const x = (ix / (GRID - 1)) * SIZE, z = (iz / (GRID - 1)) * SIZE;
      if (x < 8 || x > SIZE - 8) continue;
      const d = Math.abs(z - roadZ(x));
      const hw = 20 * (SIZE / 3200); // scale road width with map size
      if (d < hw) {
        const w = 1 - smoothstep(hw * 0.4, hw, d);
        const i = iz * GRID + ix;
        raw[i] = raw[i] * (1 - w) + prof[ix] * w;
      }
    }
  }
  flattenTowns(); // towns get the final say: dead-flat plateaus

  // Forest patches: a large low-frequency mask decides sparse woodland vs
  // dense forest; detail noise modulates within. Returns 0..1 tree density.
  function forestPatch(x, z) {
    return (nz.fbm(x * 0.0011 + 4.7, z * 0.0011 - 8.2, 2) + 1) / 2;
  }
  function forestClass(x, z) {
    const p = forestPatch(x, z);
    return p > 0.60 ? 2 : p > 0.47 ? 1 : 0; // 2 dense, 1 mixed, 0 sparse
  }
  function forestDensity(x, z) {
    if (townDist(x, z) < 100 || roadDist(x, z) < 13) return 0;
    const e = sampleH(raw, GRID, SIZE, x, z);
    if (e > 380) return 0; // bare rocky crests (snow above ~420)
    const detail = (nz.fbm(x * 0.006 + 11.2, z * 0.006 - 5.4, 3) + 1) / 2;
    const c = forestClass(x, z);
    if (c === 2) return 0.72 + 0.28 * detail;      // dense forest
    if (c === 1) return 0.30 + 0.30 * detail;      // mixed
    return 0.06 + 0.14 * detail;                   // sparse woodland
  }

  return { heights: raw, towns, roadZ, townDist, roadDist, forestDensity, forestClass, noise: nz, rng };
}

// Real-terrain map: heights is a Float32Array(GRID*GRID) of real elevations (m).
// No procedural towns/roads; forest is applied procedurally via noise patches.
function generateRealMap(heights, seed, label) {
  const { SIZE, GRID } = SIG;
  const rng = mulberry32(seed);
  const nz = new ValueNoise(seed ^ 0x9e3779b9);
  const raw = heights; // use directly

  const townDist = () => Infinity;
  const roadDist = () => Infinity;
  const roadZ = () => SIZE / 2;

  function forestPatch(x, z) {
    return (nz.fbm(x * 0.0011 + 4.7, z * 0.0011 - 8.2, 2) + 1) / 2;
  }
  function forestClass(x, z) {
    const p = forestPatch(x, z);
    return p > 0.60 ? 2 : p > 0.47 ? 1 : 0;
  }
  function forestDensity(x, z) {
    // no town/road/treeline exclusions — pure procedural patches on real terrain
    const detail = (nz.fbm(x * 0.006 + 11.2, z * 0.006 - 5.4, 3) + 1) / 2;
    const c = forestClass(x, z);
    if (c === 2) return 0.72 + 0.28 * detail;
    if (c === 1) return 0.30 + 0.30 * detail;
    return 0.06 + 0.14 * detail;
  }

  return {
    heights: raw, towns: [], roadZ, townDist, roadDist,
    forestDensity, forestClass, noise: nz, rng,
    real: true, label: label || 'real terrain',
  };
}

function placeBuildings(world, count) {
  const { towns, roadZ, rng } = world;
  const out = [];
  for (const t of towns) {
    const n = count;
    for (let i = 0; i < n; i++) {
      const x = t.x + (rng() * 2 - 1) * t.r * 0.85;
      const side = rng() < 0.5 ? -1 : 1;
      const z = roadZ(x) + side * (11 + rng() * 16);
      const r = rng();
      const type = (Math.abs(x - t.x) < 22 && r < 0.28) ? 'store' : (r < 0.45 ? 'barn' : 'house');
      out.push({
        x, z,
        w: type === 'store' ? 14 + rng() * 6 : 6 + rng() * 6,
        d: type === 'store' ? 10 + rng() * 4 : 5 + rng() * 5,
        hgt: type === 'barn' ? 5 + rng() * 2 : 3.5 + rng() * 2,
        rot: (rng() - 0.5) * 0.3,
        type,
      });
    }
    // workshop: walk-in building with workbench, near town center facing road
    // find a spot that doesn't intersect existing buildings
    const WW = 12, WD = 10;
    let wx = t.x + 30, wz = roadZ(wx) + 18;
    const intersects = (x, z) => {
      for (const b of out) {
        // AABB overlap (buildings have small rotation, use expanded bounds)
        const bx1 = b.x - b.w / 2 - WW / 2 - 2, bx2 = b.x + b.w / 2 + WW / 2 + 2;
        const bz1 = b.z - b.d / 2 - WD / 2 - 2, bz2 = b.z + b.d / 2 + WD / 2 + 2;
        if (x > bx1 && x < bx2 && z > bz1 && z < bz2) return true;
      }
      return false;
    };
    if (intersects(wx, wz)) {
      // spiral out to find a clear spot
      let found = false;
      for (let r = 20; r < 120 && !found; r += 10) {
        for (let a = 0; a < 12 && !found; a++) {
          const ang = a / 12 * Math.PI * 2;
          const tx = t.x + Math.cos(ang) * r;
          const tz = t.z + Math.sin(ang) * r;
          if (!intersects(tx, tz)) { wx = tx; wz = tz; found = true; }
        }
      }
    }
    out.push({
      x: wx, z: wz, w: WW, d: WD, hgt: 4,
      rot: 0, type: 'workshop',
    });
  }
  return out;
}

function placePeople(world, seed) {
  const { SIZE, GRID } = SIG;
  const { heights, towns, roadZ, roadDist, townDist, rng } = world;
  const out = [];
  // Two folks per town, near the road.
  for (const t of towns) {
    for (let k = 0; k < 2; k++) {
      const x = t.x + (rng() * 2 - 1) * 40;
      out.push({ x, z: roadZ(x) + (rng() < 0.5 ? -1 : 1) * (14 + rng() * 20), kind: 'town' });
    }
  }
  // Scattered folks: hollers, ridges, roadsides — the ones who need linking.
  let guard = 0;
  while (out.length < 12 && guard++ < 400) {
    const x = 60 + rng() * (SIZE - 120), z = 60 + rng() * (SIZE - 120);
    if (townDist(x, z) < 110) continue;
    const e = sampleH(heights, GRID, SIZE, x, z);
    const rd = roadDist(x, z);
    const kind = rd < 25 ? 'roadside' : (e < 150 ? 'holler' : (e > 380 ? 'ridge' : 'woods'));
    if (kind === 'woods' && rng() < 0.5) continue;
    out.push({ x, z, kind });
  }
  out.forEach((p, i) => { p.hash = nodeHash(seed, 1000 + i); });
  return out;
}

// ---- propagation ------------------------------------------------------

function treeCountAt(treeGrid, size, x, z) {
  const tg = SIG.TREE_GRID;
  const ix = Math.min(tg - 1, Math.max(0, (x / size * tg) | 0));
  const iz = Math.min(tg - 1, Math.max(0, (z / size * tg) | 0));
  return treeGrid[iz * tg + ix];
}
function treeCellAt(treeGrid, size, x, z) {
  const tg = SIG.TREE_GRID;
  const ix = Math.min(tg - 1, Math.max(0, (x / size * tg) | 0));
  const iz = Math.min(tg - 1, Math.max(0, (z / size * tg) | 0));
  return iz * tg + ix;
}

// 360-degree sweep from a transmitter. Returns Float32Array GRID*GRID of signal strength.
function sweepCoverage(heights, treeGrid, tx, tz, antH) {
  const { SIZE, GRID, MAX_RANGE, RAY_STEP, RAY_COUNT, RX_H, DECAY, NLOS_RANGE, NLOS_DEPTH, TREE_K, CANOPY_H, LOS_CLEAR, COVER_T } = SIG;
  const cov = new Float32Array(GRID * GRID);
  const hSrc = sampleH(heights, GRID, SIZE, tx, tz) + antH;
  const cell = SIZE / GRID;
  const stepM = RAY_STEP / 8; // tree attenuation is calibrated per 8 m

  for (let r = 0; r < RAY_COUNT; r++) {
    const ang = (r / RAY_COUNT) * Math.PI * 2;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    // Pass 1: walk the ray, recording terrain + prefix sums of tree counts.
    // Each tree-grid cell counts once per ray (steps are 4 m, cells 25 m).
    const rec = [];   // per step: {x,z,e,d,n,sT,slopeMax,los}
    const pref = [0]; // pref[k] = tree count over steps [0,k)
    const seenCells = new Set();
    let slopeMax = -Infinity;
    for (let d = RAY_STEP; d <= MAX_RANGE; d += RAY_STEP) {
      const x = tx + dx * d, z = tz + dz * d;
      if (x < 0 || x >= SIZE || z < 0 || z >= SIZE) break;
      const e = sampleH(heights, GRID, SIZE, x, z);
      const cellIdx = treeCellAt(treeGrid, SIZE, x, z);
      const n = seenCells.has(cellIdx) ? 0 : treeGrid[cellIdx];
      seenCells.add(cellIdx);
      pref.push(pref[pref.length - 1] + n);
      const sMid = (e - hSrc) / d;
      if (sMid > slopeMax) slopeMax = sMid;
      const sT = (e + RX_H - hSrc) / d;
      rec.push({ x, z, e, d, n, sT, slopeMax, los: sT >= slopeMax - LOS_CLEAR / d });
    }
    // Pass 2: exact canopy-gated tree loss for LOS texels. Step j's trees count
    // for texel i iff the segment to i passes within CANOPY_H of the ground
    // there: e_j > hSrc + sT_i*d_j - CANOPY_H  <=>  g(j) > sT_i, where
    // g(j) = (e_j + CANOPY_H - hSrc)/d_j. Sweep texels in descending sT,
    // activating steps by descending g, with a Fenwick tree for prefix sums.
    const n2 = rec.length;
    const gval = new Float64Array(n2);
    for (let j = 0; j < n2; j++) gval[j] = (rec[j].e + CANOPY_H - hSrc) / rec[j].d;
    const gOrd = [...Array(n2).keys()].sort((a, b) => gval[b] - gval[a]);
    const tOrd = [...Array(n2).keys()].sort((a, b) => rec[b].sT - rec[a].sT);
    const bit = new Float64Array(n2 + 1);
    const bitAdd = (idx, val) => { for (let k = idx + 1; k <= n2; k += k & -k) bit[k] += val; };
    const bitSum = (idx) => { let ssum = 0; for (let k = idx + 1; k > 0; k -= k & -k) ssum += bit[k]; return ssum; };
    const treesLOS = new Float64Array(n2);
    let gp = 0;
    for (const i of tOrd) {
      const sT = rec[i].sT;
      while (gp < n2 && gval[gOrd[gp]] > sT) { const j = gOrd[gp]; bitAdd(j, rec[j].n); gp++; }
      treesLOS[i] = bitSum(i); // steps [0..i]
    }
    // NLOS keeps full-path attenuation (the diffracted path is approximate).
    let attenFull = 1, firstBlocked = Infinity;
    for (let i = 0; i < n2; i++) {
      const s = rec[i];
      attenFull *= Math.exp(-TREE_K * (pref[i + 1] - pref[i]) * stepM);
      const base = Math.exp(-s.d / DECAY);
      let v;
      if (s.los) {
        v = base * Math.exp(-TREE_K * treesLOS[i] * stepM);
      } else {
        if (firstBlocked === Infinity) firstBlocked = s.d;
        const past = s.d - firstBlocked;
        if (past > NLOS_RANGE) { v = 0; }
        else {
          const excess = s.slopeMax * s.d + hSrc - (s.e + RX_H); // meters below the LOS line
          v = base * Math.exp(-excess / NLOS_DEPTH) * attenFull * (1 - past / NLOS_RANGE);
        }
      }
      if (v > COVER_T) {
        const ix = Math.min(GRID - 1, (s.x / cell) | 0), iz = Math.min(GRID - 1, (s.z / cell) | 0);
        const idx = iz * GRID + ix;
        if (v > cov[idx]) cov[idx] = v;
      }
      if (attenFull < 0.01 && !s.los) break; // deep forest + blocked: nothing left
    }
  }
  return cov;
}

// Direct link strength between two elevated points (single ray).
// ah/bh are heights ABOVE GROUND at each end. Used for repeater discovery
// and the simulated message flood.
function linkStrength(h, grid, size, treeGrid, ax, az, ah, bx, bz, bh) {
  const { DECAY, TREE_K, CANOPY_H, NLOS_DEPTH, LINK_RANGE, LINK_NLOS } = SIG;
  const dx = bx - ax, dz = bz - az;
  const dist = Math.hypot(dx, dz);
  if (dist < 1) return 1;
  if (dist > LINK_RANGE) return 0;
  const hA = sampleH(h, grid, size, ax, az) + ah;
  const hB = sampleH(h, grid, size, bx, bz) + bh;
  let slopeMax = -Infinity, atten = 1;
  const seenCells = new Set(); // each tree cell counts once
  const steps = Math.max(1, Math.floor(dist / 4));
  for (let i = 1; i < steps; i++) {
    const f = i / steps, d = f * dist;
    const x = ax + dx * f, z = az + dz * f;
    const e = sampleH(h, grid, size, x, z);
    // canopy gate: trees only attenuate where the segment runs within
    // CANOPY_H of the ground — a ray flying high over a valley ignores it
    if (hA + (hB - hA) * f - e < CANOPY_H) {
      const ci = treeCellAt(treeGrid, size, x, z);
      if (!seenCells.has(ci)) {
        seenCells.add(ci);
        atten *= Math.exp(-TREE_K * treeGrid[ci] * 0.5);
      }
    }
    const sMid = (e - hA) / d;
    if (sMid > slopeMax) slopeMax = sMid;
    if (atten < 0.005) break;
  }
  const base = Math.exp(-dist / DECAY);
  if ((hB - hA) / dist >= slopeMax - SIG.LOS_CLEAR / dist) return base * atten; // radio LOS
  if (dist > LINK_NLOS) return 0;
  const excess = slopeMax * dist + hA - hB; // meters below the LOS line
  return base * Math.exp(-excess / NLOS_DEPTH) * atten;
}

function sampleCov(cov, size, grid, x, z) {
  const gx = Math.min(grid - 1, Math.max(0, (x / size) * (grid - 1)));
  const gz = Math.min(grid - 1, Math.max(0, (z / size) * (grid - 1)));
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz;
  const jx = Math.min(ix + 1, grid - 1), jz = Math.min(iz + 1, grid - 1);
  const a = cov[iz * grid + ix], b = cov[iz * grid + jx];
  const c = cov[jz * grid + ix], d = cov[jz * grid + jx];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

if (typeof module !== 'undefined') {
  module.exports = { SIG, mulberry32, ValueNoise, generateMap, generateRealMap, placeBuildings, placePeople, sampleH, sweepCoverage, sampleCov, linkStrength, nodeHash, smoothstep, clamp01 };
}
