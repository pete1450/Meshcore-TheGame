/* node tests for logic.js */
'use strict';
const assert = require('assert');
const L = require('../logic.js');
const { SIG } = L;

let n = 0;
function ok(cond, msg) { n++; assert(cond, msg); }

// bilinear sampler correctness on a known asymmetric ramp (regression:
// sampleH once read h[jz*grid+jz] instead of h[jz*grid+jx])
{
  const g = 4, ramp = new Float32Array(g * g);
  for (let iz = 0; iz < g; iz++) for (let ix = 0; ix < g; ix++) ramp[iz * g + ix] = ix * 10 + iz * 100;
  const S = 300; // grid coord = w/300*3
  const v = L.sampleH(ramp, g, S, 150, 50); // gx=1.5, gz=0.5 → 65
  ok(Math.abs(v - 65) < 1e-4, `bilinear asymmetric = 65 (got ${v})`);
  const v2 = L.sampleH(ramp, g, S, 50, 50); // center of cell → 55
  ok(Math.abs(v2 - 55) < 1e-4, `bilinear center = 55 (got ${v2})`);
  const vc = L.sampleCov(ramp, S, g, 150, 50);
  ok(Math.abs(vc - 65) < 1e-4, `sampleCov asymmetric = 65 (got ${vc})`);
}

// determinism
const w1 = L.generateMap(12345), w2 = L.generateMap(12345);
ok(w1.heights.every((v, i) => v === w2.heights[i]), 'same seed -> same heights');
const w3 = L.generateMap(999);
ok(!w1.heights.every((v, i) => v === w3.heights[i]), 'different seed -> different heights');

// towns flattened (core is dead flat; outskirts blend into the hills)
for (const t of w1.towns) {
  let mn = 1e9, mx = -1e9;
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
    const x = t.x - 28 + a * 3.75, z = t.z - 28 + b * 3.75;
    const h = L.sampleH(w1.heights, SIG.GRID, SIG.SIZE, x, z);
    mn = Math.min(mn, h); mx = Math.max(mx, h);
  }
  ok(mx - mn < 2, `town ${t.name} core flat (spread ${mx - mn})`);
}
ok(w1.towns.length === 2, 'two towns');
ok(w1.towns[0].name !== w1.towns[1].name, 'town names differ');

// road is smooth along its length (no bucking)
{
  let prev = null, jumps = 0;
  const step = Math.max(8, SIG.SIZE / SIG.GRID); // don't sample finer than the grid
  for (let x = 60; x < SIG.SIZE - 40; x += step) {
    const h = L.sampleH(w1.heights, SIG.GRID, SIG.SIZE, x, w1.roadZ(x));
    if (prev !== null && Math.abs(h - prev) > 6 * (step / 8)) jumps++;
    prev = h;
  }
  ok(jumps < 4, `road smooth (${jumps} jumps)`);
}

// buildings + people
const blds = L.placeBuildings(w1, 16);
ok(blds.length === 34, '16 buildings + workshop per town');
ok(blds.filter(b => b.type !== 'workshop').every(b => Math.abs(b.z - w1.roadZ(b.x)) > 8), 'buildings off the road');
const people = L.placePeople(w1, 12345);
ok(people.length >= 10, `${people.length} people placed`);
ok(people.filter(p => p.kind === 'town').length === 4, '4 town folk');
ok(people.every(p => /^[0-9a-f]{8}$/.test(p.hash)), 'people have 8-hex hashes');
ok(new Set(people.map(p => p.hash)).size === people.length, 'hashes unique');

// sweep on a perfectly flat map: full disc coverage
{
  const flat = new Float32Array(SIG.GRID * SIG.GRID).fill(20);
  const trees = new Uint8Array(SIG.TREE_GRID * SIG.TREE_GRID);
  const cov = L.sweepCoverage(flat, trees, 512, 512, 10);
  let covered = 0, total = 0;
  for (let iz = 0; iz < SIG.GRID; iz++) for (let ix = 0; ix < SIG.GRID; ix++) {
    const x = ix / SIG.GRID * SIG.SIZE, z = iz / SIG.GRID * SIG.SIZE;
    const d = Math.hypot(x - 512, z - 512);
    if (d < SIG.MAX_RANGE * 0.9) { total++; if (cov[iz * SIG.GRID + ix] > 0) covered++; }
  }
  ok(covered / total > 0.94, `flat map disc covered ${(covered / total * 100).toFixed(1)}%`);
}

// ridge blocks LOS: synthetic wall between tx and far side
{
  const h = new Float32Array(SIG.GRID * SIG.GRID).fill(20);
  for (let iz = 0; iz < SIG.GRID; iz++) for (let ix = 0; ix < SIG.GRID; ix++) {
    const x = ix / SIG.GRID * SIG.SIZE;
    if (x > 600 && x < 640) h[iz * SIG.GRID + ix] = 120; // wall ridge
  }
  const trees = new Uint8Array(SIG.TREE_GRID * SIG.TREE_GRID);
  const cov = L.sweepCoverage(h, trees, 512, 512, 10);
  const near = L.sampleCov(cov, SIG.SIZE, SIG.GRID, 560, 512);
  const far = L.sampleCov(cov, SIG.SIZE, SIG.GRID, 700, 512);
  const farFar = L.sampleCov(cov, SIG.SIZE, SIG.GRID, 900, 512);
  ok(near > SIG.COVER_T, `near side covered (${near.toFixed(3)})`);
  ok(far < near * 0.7, `shadow behind ridge weaker than LOS side (${far.toFixed(3)} < ${near.toFixed(3)})`);
  ok(farFar < SIG.COVER_T, `deep shadow stays dark (${farFar.toFixed(3)})`);
}

// hilltop sees far; valley floor does not (real terrain)
{
  const trees = new Uint8Array(SIG.TREE_GRID * SIG.TREE_GRID);
  // find a high crest and a low holler
  let hi = { h: -1 }, lo = { h: 1e9 };
  for (let i = 0; i < SIG.GRID * SIG.GRID; i += 37) {
    const ix = i % SIG.GRID, iz = (i / SIG.GRID) | 0;
    const x = ix / SIG.GRID * SIG.SIZE, z = iz / SIG.GRID * SIG.SIZE;
    if (w1.townDist(x, z) < 120) continue;
    const e = w1.heights[i];
    if (e > hi.h) hi = { h: e, x, z };
    if (e < lo.h) lo = { h: e, x, z };
  }
  const covHi = L.sweepCoverage(w1.heights, trees, hi.x, hi.z, 10);
  const covLo = L.sweepCoverage(w1.heights, trees, lo.x, lo.z, 10);
  const frac = (c) => c.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) / c.length;
  ok(frac(covHi) > frac(covLo) * 1.5,
    `crest covers more (${(frac(covHi) * 100).toFixed(1)}%) than holler (${(frac(covLo) * 100).toFixed(1)}%)`);
}

// taller antenna beats shorter antenna from the same spot
{
  const trees = new Uint8Array(SIG.TREE_GRID * SIG.TREE_GRID);
  const a = L.sweepCoverage(w1.heights, trees, 400, 400, 3);
  const b = L.sweepCoverage(w1.heights, trees, 400, 400, 20);
  const frac = (c) => c.reduce((s, v) => s + (v > 0 ? 1 : 0), 0) / c.length;
  ok(frac(b) >= frac(a), `taller mast covers >= shorter (${(frac(b) * 100).toFixed(1)} vs ${(frac(a) * 100).toFixed(1)})`);
}

// sweep is deterministic
{
  const trees = new Uint8Array(SIG.TREE_GRID * SIG.TREE_GRID);
  const a = L.sweepCoverage(w1.heights, trees, 400, 400, 12);
  const b = L.sweepCoverage(w1.heights, trees, 400, 400, 12);
  ok(a.every((v, i) => v === b[i]), 'sweep deterministic');
}

// forest patches: sparse woodland, mixed, and dense forest all exist
{
  const w = L.generateMap(12345);
  const seen = new Set();
  let dMin = 1, dMax = 0;
  for (let iz = 0; iz < 40; iz++) for (let ix = 0; ix < 40; ix++) {
    const x = (ix + 0.5) / 40 * SIG.SIZE, z = (iz + 0.5) / 40 * SIG.SIZE;
    seen.add(w.forestClass(x, z));
    const d = w.forestDensity(x, z);
    if (d > 0) { dMin = Math.min(dMin, d); dMax = Math.max(dMax, d); }
  }
  ok(seen.has(0) && seen.has(1) && seen.has(2), 'sparse, mixed and dense forest patches all exist');
  ok(dMax > 0.7, `dense forest is dense (${dMax.toFixed(2)})`);
  ok(dMin < 0.2, `sparse woodland is sparse (${dMin.toFixed(2)})`);
}
{
  const flat = new Float32Array(SIG.GRID * SIG.GRID).fill(100);
  const trees = new Uint8Array(SIG.TREE_GRID * SIG.TREE_GRID);
  const s = L.linkStrength(flat, SIG.GRID, SIG.SIZE, trees, 1500, 1500, 10, 1600, 1500, 10);
  ok(s > 0.5, `short LOS link strong (${s.toFixed(3)})`);
  const self = L.linkStrength(flat, SIG.GRID, SIG.SIZE, trees, 1500, 1500, 10, 1500, 1500, 10);
  ok(self === 1, 'zero distance = 1');
  const far = L.linkStrength(flat, SIG.GRID, SIG.SIZE, trees, 100, 100, 10, 3100, 3100, 10);
  ok(far === 0, 'beyond MAX_RANGE = 0');
  // ridge between the two ends kills the link
  const h = new Float32Array(SIG.GRID * SIG.GRID).fill(100);
  for (let iz = 0; iz < SIG.GRID; iz++) for (let ix = 0; ix < SIG.GRID; ix++) {
    const x = ix / SIG.GRID * SIG.SIZE;
    if (x > 1560 && x < 1640) h[iz * SIG.GRID + ix] = 480;
  }
  const blocked = L.linkStrength(h, SIG.GRID, SIG.SIZE, trees, 1400, 1600, 10, 1800, 1600, 10);
  const open = L.linkStrength(h, SIG.GRID, SIG.SIZE, trees, 1400, 1400, 10, 1500, 1400, 10);
  ok(blocked < open * 0.5, `ridge weakens link (${blocked.toFixed(3)} < ${open.toFixed(3)})`);
  // clear line of sight: distance barely matters (like real LoRa)
  const far2 = L.linkStrength(flat, SIG.GRID, SIG.SIZE, trees, 100, 1600, 10, 1300, 1600, 10);
  ok(far2 > 0.5, `1200m LOS link stays strong (${far2.toFixed(3)})`);
  // ...but trees are the real enemy
  const forest = new Uint8Array(SIG.TREE_GRID * SIG.TREE_GRID);
  const frow = Math.floor(1600 / SIG.SIZE * SIG.TREE_GRID); // tree row at z=1600
  for (let ix = 0; ix < SIG.TREE_GRID; ix++) forest[frow * SIG.TREE_GRID + ix] = 4;
  const thru = L.linkStrength(flat, SIG.GRID, SIG.SIZE, forest, 100, 1600, 10, 700, 1600, 10);
  const clear = L.linkStrength(flat, SIG.GRID, SIG.SIZE, trees, 100, 1600, 10, 700, 1600, 10);
  ok(thru < clear * 0.5, `600m of forest weakens link (${thru.toFixed(3)} < ${clear.toFixed(3)})`);
}

console.log(`all ${n} asserts pass`);
