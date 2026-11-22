import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_LEVEL, makeInvalidLevel } from '../src/core/demoLevel.ts';
import { buildGrid, findPath, cellWorld, nearestWalkable } from '../src/core/nav.ts';
import { placeLevel, evaluateManual, mulberry32 } from '../src/core/placement.ts';
import { planRoute } from '../src/core/route.ts';
import { staticConflicts, findCycles, topoOrder } from '../src/core/staticAnalysis.ts';

const clone = (o) => JSON.parse(JSON.stringify(o));

test('bundled scene has no static conflicts', () => {
  const conflicts = staticConflicts(DEMO_LEVEL);
  assert.deepEqual(
    conflicts.filter((c) => c.severity === 'hard').map((c) => c.code),
    []
  );
});

test('generates a fully valid walk-only plan for the bundled scene', () => {
  const res = placeLevel(DEMO_LEVEL, { seeds: 6 });
  assert.equal(res.ok, true, JSON.stringify(res.conflicts, null, 2));
  assert.equal(res.proof.ok, true);
  assert.equal(res.proof.mode, 'walk');
  assert.equal(res.proof.entries.length, DEMO_LEVEL.steps.length + DEMO_LEVEL.keys.length + 1);

  // Every step, key and the exit appear in the proof, in a legal order.
  const seen = new Set();
  let exitSeen = false;
  for (const e of res.proof.entries) {
    if (e.kind === 'exit') {
      exitSeen = true;
      continue;
    }
    assert.equal(exitSeen, false, 'nothing may follow the one-way exit');
    assert.equal(seen.has(e.id), false, 'each object is collected once');
    seen.add(e.id);
    if (e.kind === 'step') {
      const step = DEMO_LEVEL.steps.find((s) => s.id === e.id);
      for (const r of step.requires) {
        assert.ok(seen.has(r), `step ${e.id} completed before its requirement ${r}`);
      }
    }
  }
  for (const s of DEMO_LEVEL.steps) assert.ok(seen.has(s.id));
  for (const k of DEMO_LEVEL.keys) assert.ok(seen.has(k.id));
});

test('proof legs are physically traversable: walkable cells, 4-neighbour, maxStep', () => {
  const res = placeLevel(DEMO_LEVEL, { seeds: 6 });
  const grid = buildGrid(DEMO_LEVEL);
  assert.ok(res.proof.route.legs.length > 0);
  for (const leg of res.proof.route.legs) {
    for (let i = 0; i < leg.points.length; i++) {
      const p = leg.points[i];
      const cx = Math.floor((p[0] - grid.minX) / grid.cellSize);
      const cz = Math.floor((p[2] - grid.minZ) / grid.cellSize);
      const c = grid.cells[cz * grid.cols + cx];
      assert.ok(c?.walkable, `leg point ${i} is on a walkable cell`);
      if (i > 0) {
        const q = leg.points[i - 1];
        assert.ok(Math.hypot(p[0] - q[0], p[2] - q[2]) <= 1.5, 'horizontal step is one cell');
        assert.ok(Math.abs(p[1] - q[1]) <= grid.maxStep + 1e-6, 'height step stays within maxStep');
      }
    }
  }
});

test('the key route climbs the real stairs instead of flying', () => {
  const res = placeLevel(DEMO_LEVEL, { seeds: 6 });
  const heights = res.proof.route.legs.flatMap((l) => l.points.map((p) => p[1]));
  assert.ok(Math.max(...heights) >= 2.0, 'route reaches the cliff tier');
  assert.ok(Math.min(...heights) <= -1.0, 'route descends into the vault');
  const ramp = res.proof.route.legs.some((l) =>
    l.points.some((p, i) => i > 0 && Math.abs(p[1] - l.points[i - 1][1]) > 1e-6)
  );
  assert.ok(ramp, 'at least one leg crosses a slope');
});

test('keys are placed by reachable state: the sun key sits behind the vine gate', () => {
  const res = placeLevel(DEMO_LEVEL, { seeds: 6 });
  const sun = res.keys.find((k) => k.keyId === 'sun-key');
  const vine = res.keys.find((k) => k.keyId === 'vine-key');
  assert.ok(sun && vine);
  assert.equal(vine.zoneId, 'garden');
  // The sun key is only reachable after the vine key opens the tunnel hatch.
  assert.match(sun.reachStateNote, /before this key is collected/);
  const proofIds = res.proof.entries.map((e) => e.id);
  assert.ok(proofIds.indexOf('vine-key') < proofIds.indexOf('sun-key'));
});

test('closed gates actually block movement, and no walk-around exists', () => {
  const grid = buildGrid(DEMO_LEVEL);
  const exitCell = nearestWalkable(grid, DEMO_LEVEL.exitPoint[0], DEMO_LEVEL.exitPoint[2], 6);
  assert.ok(exitCell >= 0);
  const blocked = findPath(grid, grid.entryCell, exitCell, new Set());
  assert.equal(blocked.found, false, 'exit is unreachable while the vault gate is closed');
  const open = findPath(grid, grid.entryCell, exitCell, new Set(['vault-gate']));
  assert.equal(open.found, true, 'vault is reachable once the gate opens');
});

test('a key forced behind its own gate is rejected, not silently dropped', () => {
  const bad = clone(DEMO_LEVEL);
  bad.config = { forcedKeyZones: { 'sun-key': 'vault' } };
  const res = placeLevel(bad, { seeds: 3 });
  assert.equal(res.ok, false);
  const codes = res.conflicts.map((c) => c.code);
  assert.ok(codes.includes('KEY_BEHIND_GATE'), `codes: ${codes.join(', ')}`);
  // The side branches still exist in the result; nothing was discarded.
  assert.equal(res.placements.length, bad.steps.length);
});

test('key reachability is stateful: geometric proximity to the exit is not safety', () => {
  // Force the sun key deep in the vault, but right next to the exit. Geometrically
  // it is the closest possible hiding spot to the exit; by state it is illegal.
  const bad = clone(DEMO_LEVEL);
  bad.config = { forcedKeyZones: { 'sun-key': 'vault' } };
  const res = placeLevel(bad, { seeds: 2 });
  const sun = res.keys.find((k) => k.keyId === 'sun-key');
  assert.ok(sun, 'the key is still returned so the designer can inspect it');
  assert.ok(sun.distanceToExit < 12, `key is close to exit (${sun.distanceToExit})`);
  assert.ok(res.conflicts.some((c) => c.code === 'KEY_BEHIND_GATE'));
});

test('dependency cycles are caught even though the table is connected', () => {
  const bad = makeInvalidLevel();
  const cycles = findCycles(bad.steps);
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]].sort(), ['herb', 'hermit']);
  assert.equal(topoOrder(bad.steps), null);
  const conflicts = staticConflicts(bad);
  assert.ok(conflicts.some((c) => c.code === 'DEPENDENCY_CYCLE'));
});

test('an acyclic table can still be physically impossible and is reported', () => {
  // Only the hard zone pin + hard exit proximity conflict; no cycle this time.
  const bad = clone(DEMO_LEVEL);
  bad.steps = bad.steps.map((s) =>
    s.id === 'seal' ? { ...s, requiredKind: 'hall', preferredZone: 'gallery' } : s
  );
  assert.ok(topoOrder(bad.steps), 'dependency graph is acyclic');
  const res = placeLevel(bad, { seeds: 4 });
  assert.equal(res.ok, false);
  const codes = res.conflicts.map((c) => c.code);
  assert.ok(
    codes.includes('HARD_MAX_DISTANCE') || codes.includes('NO_CELL_FOR_STEP'),
    `codes: ${codes.join(', ')}`
  );
});

test('invalid scene names every seeded fault', () => {
  const bad = makeInvalidLevel();
  const res = placeLevel(bad, { seeds: 3 });
  assert.equal(res.ok, false);
  const codes = new Set(res.conflicts.map((c) => c.code));
  assert.ok(codes.has('DEPENDENCY_CYCLE'), 'cycle named');
  assert.ok(codes.has('IMPOSSIBLE_DISTANCE_WINDOW'), 'impossible window named');
  assert.ok(codes.has('KEY_BEHIND_GATE'), 'key behind gate named');
  assert.ok(
    codes.has('HARD_MAX_DISTANCE') || codes.has('NO_CELL_FOR_STEP'),
    'hard zone pin conflict named'
  );
});

test('every seeded fault has a locatable subject or position', () => {
  const bad = makeInvalidLevel();
  const res = placeLevel(bad, { seeds: 3 });
  const named = res.conflicts.filter((c) => c.severity === 'hard');
  assert.ok(named.length >= 4);
  for (const c of named) {
    assert.ok(c.subjects.length > 0 || c.at, `${c.code} identifies where it happens`);
  }
});

test('seeds produce a variety of placements, all valid or clearly invalid', () => {
  const res = placeLevel(DEMO_LEVEL, { seeds: 8 });
  assert.ok(res.seeds.length >= 5);
  const okSeeds = res.seeds.filter((s) => s.ok);
  assert.ok(okSeeds.length >= 2, 'more than one seed yields a complete plan');
  const signatures = new Set(okSeeds.map((s) => s.placementSignature));
  assert.ok(signatures.size >= 2, 'seeds give genuinely different layouts');
});

test('soft constraints are honoured as preferences, not dropped', () => {
  const res = placeLevel(DEMO_LEVEL, { seeds: 8 });
  const hermit = res.placements.find((p) => p.stepId === 'hermit');
  const herb = res.placements.find((p) => p.stepId === 'herb');
  const d = Math.hypot(
    hermit.objectPos[0] - herb.objectPos[0],
    hermit.objectPos[1] - herb.objectPos[1],
    hermit.objectPos[2] - herb.objectPos[2]
  );
  assert.ok(d <= 6, `herb stays near the hermit (${d.toFixed(1)} m) where geometry allows`);
});

test('manual override that breaks reachability is reported', () => {
  const res = placeLevel(DEMO_LEVEL, { seeds: 6 });
  const seal = res.placements.find((p) => p.stepId === 'seal');
  // Move the seal into a sealed part of the hall; the proof must fail and say why.
  const manual = evaluateManual(
    DEMO_LEVEL,
    { seal: { x: -15, z: 3 } },
    { placements: res.placements, keys: res.keys }
  );
  assert.equal(manual.ok, false);
  assert.ok(manual.conflicts.some((c) => c.severity === 'hard'));
  assert.ok(seal);
});

test('placing every object on one another still yields one object per step', () => {
  const res = placeLevel(DEMO_LEVEL, { seeds: 4 });
  const cells = new Set(
    [...res.placements.map((p) => p.objectCell.join(',')), ...res.keys.map((k) => k.cell.join(','))]
  );
  assert.equal(cells.size, res.placements.length + res.keys.length);
});

test('seeded RNG is deterministic', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
});

test('proof is reproducible for the same seed', () => {
  const a = placeLevel(DEMO_LEVEL, { seeds: 1 });
  const b = placeLevel(DEMO_LEVEL, { seeds: 1 });
  assert.deepEqual(
    a.placements.map((p) => [p.stepId, p.objectCell]),
    b.placements.map((p) => [p.stepId, p.objectCell])
  );
  assert.deepEqual(a.seeds[0].placementSignature, b.seeds[0].placementSignature);
});

test('manual relocation changes the walk-only proof', () => {
  const base = placeLevel(DEMO_LEVEL, { seeds: 4 });
  const moved = evaluateManual(
    DEMO_LEVEL,
    { cache: { x: 10, z: 3 } },
    { placements: base.placements, keys: base.keys }
  );
  const before = base.placements.find((p) => p.stepId === 'cache');
  const after = moved.placements.find((p) => p.stepId === 'cache');
  assert.notDeepEqual(after.objectCell, before.objectCell);
  assert.equal(moved.ok, true);
  assert.ok(moved.proof.route.totalDistance > 0);
});

test('a manual click with no walkable cell is rejected and located', () => {
  const base = placeLevel(DEMO_LEVEL, { seeds: 4 });
  const manual = evaluateManual(
    DEMO_LEVEL,
    { seal: { x: 200, z: 200 } },
    { placements: base.placements, keys: base.keys }
  );
  assert.equal(manual.ok, false);
  const c = manual.conflicts.find((x) => x.code === 'MANUAL_CELL_REJECTED');
  assert.ok(c, 'expected MANUAL_CELL_REJECTED');
  assert.match(c.message, /not usable/);
  assert.ok(c.subjects.includes('seal'));
});

test('a manual click that steals another object’s approach cell is named', () => {
  const base = placeLevel(DEMO_LEVEL, { seeds: 4 });
  const manual = evaluateManual(
    DEMO_LEVEL,
    { cache: { x: 14, z: 0 } },
    { placements: base.placements, keys: base.keys }
  );
  assert.equal(manual.ok, false);
  const c = manual.conflicts.find((x) => x.code === 'MANUAL_APPROACH_BLOCKED');
  assert.ok(c, 'expected MANUAL_APPROACH_BLOCKED');
  assert.ok(c.subjects.includes('cache'));
  assert.ok(c.subjects.length >= 2, 'names the blocking object');
});
