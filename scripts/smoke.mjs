import { DEMO_LEVEL, makeInvalidLevel } from '../src/core/demoLevel.ts';
import { buildGrid } from '../src/core/nav.ts';
import { placeLevel } from '../src/core/placement.ts';
import { staticConflicts } from '../src/core/staticAnalysis.ts';

const level = DEMO_LEVEL;
const grid = buildGrid(level);
const walkable = grid.cells.filter((c) => c?.walkable).length;
console.log(`grid ${grid.cols}x${grid.rows}, entry=${grid.entryCell}, walkable=${walkable}`);
console.log('static conflicts:', staticConflicts(level).map((c) => c.code));

const t0 = performance.now();
const res = placeLevel(level, { seeds: 6 });
console.log(`place: ok=${res.ok} ms=${Math.round(performance.now() - t0)} attempts=${res.metrics.attempts}`);
console.log('metrics:', res.metrics);
console.log('placements:', res.placements.map((p) => `${p.stepId}@${p.zoneId}(${p.objectCell}) d=${p.interactionDistance.toFixed(2)}`));
console.log('keys:', res.keys.map((k) => `${k.keyId}@${k.zoneId}(${k.cell}) ${k.reachStateNote}`));
console.log('proof entries:', res.proof.entries.map((e) => `${e.order}. ${e.kind}:${e.id} [${e.status}]`));
console.log('route stops:', res.proof.route.stops.map((s) => `${s.order}.${s.id}@${s.zoneId}`));
console.log('route len:', res.proof.route.totalDistance.toFixed(1), 'legs', res.proof.route.legs.length);
console.log('conflicts:', res.conflicts.map((c) => `${c.severity}:${c.code}: ${c.message}`));
console.log('seeds:', res.seeds.map((s) => `#${s.seed} ok=${s.ok} cost=${s.softCost} route=${s.routeLength}`));

console.log('\n--- invalid ---');
const bad = makeInvalidLevel();
const badGrid = buildGrid(bad);
console.log('walkable', badGrid.cells.filter((c) => c?.walkable).length);
const badRes = placeLevel(bad, { seeds: 4 });
console.log(`bad ok=${badRes.ok}`);
console.log('bad conflicts:', badRes.conflicts.map((c) => `${c.severity}:${c.code}`));
for (const c of badRes.conflicts) console.log(' -', c.code, '|', c.message);
