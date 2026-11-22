import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_LEVEL, makeInvalidLevel, makeOrderingLevel } from '../src/core/demoLevel.ts';
import { buildGrid, findPath, nearestWalkable, worldToIndex } from '../src/core/nav.ts';
import { placeLevel } from '../src/core/placement.ts';

const clone = (o) => structuredClone(o);

function gateCellsFor(level, gate) {
  const grid = buildGrid(level);
  return [...(grid.gateCells.get(gate) ?? [])];
}

// ---------------------------------------------------------------------------
// 1. Gate band geometry: a gate must seal the full corridor, not two rows.
// ---------------------------------------------------------------------------

test('a gate seals the full corridor width, so there is no walk-around', () => {
  const level = makeOrderingLevel();
  const grid = buildGrid(level);
  const exitCell = nearestWalkable(grid, level.exitPoint[0], level.exitPoint[2], 6);
  assert.ok(exitCell >= 0);

  // Both corridor gates closed: the exit is unreachable.
  assert.equal(findPath(grid, grid.entryCell, exitCell, new Set()).found, false);
  // Only the near gate open: still unreachable, the far gate holds.
  assert.equal(findPath(grid, grid.entryCell, exitCell, new Set(['hall-gate'])).found, false);
  // Only the far gate open is meaningless without the near one.
  assert.equal(findPath(grid, grid.entryCell, exitCell, new Set(['vault-gate'])).found, false);
  // Both open: the route exists.
  assert.equal(findPath(grid, grid.entryCell, exitCell, new Set(['hall-gate', 'vault-gate'])).found, true);

  // The gate band covers every walkable cell in the one-cell corridor at the
  // gate's cross-section, so the one-cell hall cannot be skirted.
  const hallRows = new Set(
    grid.cells.filter((c) => c?.walkable && c.zoneId === 'hall').map((c) => c.cz)
  );
  assert.equal(hallRows.size, 1, 'fixture corridor is exactly one cell wide');
  const band = gateCellsFor(level, 'hall-gate');
  assert.ok(band.length >= 1, 'gate owns walkable blocking cells');
  for (const idx of band) assert.equal(grid.cells[idx].gate, 'hall-gate');
});

// ---------------------------------------------------------------------------
// 2. Offline item-set enumeration must agree with run-time state tracking.
// ---------------------------------------------------------------------------

/** Exhaustive state closure over key masks, independent of planRoute. */
function offlineReachability(level) {
  const grid = buildGrid(level);
  const keyBit = new Map(level.keys.map((k, i) => [k.id, i]));

  const seen = new Set();
  const queue = [0];
  const reachedKeys = new Set();
  while (queue.length) {
    const mask = queue.pop();
    if (seen.has(mask)) continue;
    seen.add(mask);
    const open = new Set();
    for (let i = 0; i < level.keys.length; i++) {
      if (mask & (1 << i)) for (const g of level.keys[i].unlocks) open.add(g);
    }
    const dist = flood(grid, open);
    for (const k of level.keys) {
      const ki = keyBit.get(k.id);
      if (mask & (1 << ki)) continue;
      const allowed = allowedCells(level, grid, k);
      if (allowed.some((idx) => dist.has(idx))) {
        reachedKeys.add(k.id);
        queue.push(mask | (1 << ki));
      }
    }
  }
  return { reachedKeys };
}

function allowedCells(level, grid, key) {
  const forced = level.config?.forcedKeyZones?.[key.id];
  const gateCells = new Set();
  for (const list of grid.gateCells.values()) for (const i of list) gateCells.add(i);
  const out = [];
  for (let i = 0; i < grid.cells.length; i++) {
    const c = grid.cells[i];
    if (!c || !c.walkable || !c.zoneId) continue;
    if (gateCells.has(i)) continue;
    if (forced && c.zoneId !== forced) continue;
    out.push(i);
  }
  return out;
}

function flood(grid, open) {
  const closed = new Set();
  for (const [gate, list] of grid.gateCells) {
    if (open.has(gate)) continue;
    for (const i of list) closed.add(i);
  }
  const out = new Set();
  const queue = [grid.entryCell];
  out.add(grid.entryCell);
  while (queue.length) {
    const cur = queue.pop();
    const cc = grid.cells[cur];
    if (!cc) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cc.cx + dx;
      const nz = cc.cz + dz;
      if (nx < 0 || nz < 0 || nx >= grid.cols || nz >= grid.rows) continue;
      const ni = nz * grid.cols + nx;
      const nc = grid.cells[ni];
      if (!nc || !nc.walkable || out.has(ni) || closed.has(ni)) continue;
      if (Math.abs(nc.y - cc.y) > grid.maxStep + 1e-6) continue;
      out.add(ni);
      queue.push(ni);
    }
  }
  return out;
}

test('run-time proof agrees with offline enumeration on the minimal fixture', () => {
  const level = makeOrderingLevel();
  const res = placeLevel(level, { seeds: 4 });
  const offline = offlineReachability(level);
  assert.equal(res.ok, true);
  for (const k of level.keys) {
    assert.ok(offline.reachedKeys.has(k.id), `${k.id} is collectable offline`);
    assert.ok(res.proof.collectedKeys.includes(k.id), `${k.id} is collected in the proof`);
  }
  for (const s of level.steps) {
    assert.ok(res.proof.visitedSteps.includes(s.id));
  }
});

// ---------------------------------------------------------------------------
// 3. Key/gate mutual lock: offline expansion must not fabricate states.
// ---------------------------------------------------------------------------

test('a key and a passage that depend on each other are both reported stuck', () => {
  const level = makeOrderingLevel();
  // hall-key must open the hall, but is hidden behind the vault gate;
  // vault-key needs the hall gate. Neither can ever be collected.
  level.config = { forcedKeyZones: { 'hall-key': 'vault', 'vault-key': 'vault' } };
  const res = placeLevel(level, { seeds: 2 });
  assert.equal(res.ok, false);
  assert.equal(res.proof.ok, false);

  const codes = res.conflicts.map((c) => c.code);
  assert.ok(codes.includes('KEY_BEHIND_GATE'), `codes: ${codes.join(', ')}`);
  assert.ok(codes.includes('KEY_SELF_LOCKED'), `codes: ${codes.join(', ')}`);

  // Both keys keep a placement so the designer can inspect the failure; nothing
  // is silently dropped. The evidence route is empty rather than fabricated.
  assert.equal(res.keys.length, level.keys.length);
  assert.deepEqual(res.proof.route.stops, []);
  assert.ok(res.proof.issues.length >= 1);
});

test('reachability notes never claim a cell is safe in a state that already holds the key', () => {
  const level = makeOrderingLevel();
  const res = placeLevel(level, { seeds: 4 });
  for (const k of res.keys) {
    assert.match(k.reachStateNote, /before this key is collected/);
    // The listed masks must not contain the key itself.
    const label = level.keys.find((x) => x.id === k.keyId).label;
    const statePart = k.reachStateNote.slice(k.reachStateNote.indexOf('{'));
    assert.equal(statePart.includes(label), false, `${k.keyId} note must not include itself: ${k.reachStateNote}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Pick up then pass vs block then pass, compared in opposite orders.
// ---------------------------------------------------------------------------

function corridorScene(interactionKind, reverse) {
  const level = makeOrderingLevel();
  // Keep the multi-zone structure but remove gates and keys so this test
  // isolates the ordering rule: a corridor object must be cleared before the
  // rest of the level is traversable.
  level.links = level.links
    .filter((l) => l.id !== 'hall-vault')
    .map((l) => ({ ...l, gate: undefined }));
  level.keys = [];
  level.steps = [
    {
      id: 'guard',
      label: 'Corridor object',
      role: 'main',
      requiredKind: 'hall',
      zoneHint: 'hall',
      seq: reverse ? 1 : 0,
      depth: 0,
      requires: [],
      interaction: { kind: interactionKind, radius: 1.0 },
    },
    {
      id: 'after',
      label: 'Exit task',
      role: 'main',
      zoneHint: 'vault',
      seq: reverse ? 0 : 1,
      depth: 1,
      requires: ['guard'],
      interaction: { kind: 'talk', radius: 1.5 },
    },
  ];
  level.constraints = [];
  level.entry = [-2, 0, 0.5];
  level.exitPoint = [23, 0, 0.5];
  level.config = {};
  return level;
}

test('a consumable pickup in a one-cell corridor can be taken first, then passed', () => {
  const level = corridorScene('pickup', false);
  const res = placeLevel(level, { seeds: 4 });
  assert.equal(res.ok, true, JSON.stringify(res.conflicts));
  const order = res.proof.route.stops.map((s) => s.id);
  assert.ok(order.indexOf('guard') < order.indexOf('after'), `order: ${order.join(' -> ')}`);
  assert.ok(order.includes('guard'));
});

test('a permanent object in the same corridor seals the route and is named', () => {
  const level = corridorScene('talk', false);
  const res = placeLevel(level, { seeds: 4 });
  assert.equal(res.ok, false);
  const codes = new Set(res.conflicts.map((c) => c.code));
  assert.ok(codes.has('OBJECT_SEALS_PATH'), `codes: ${[...codes].join(', ')}`);
  assert.deepEqual(res.proof.route.stops, []);
});

test('the reverse event order is reported as a dependency deadlock, not as a normal block', () => {
  const level = corridorScene('pickup', true);
  // Reverse: guard now requires after, while after still needs to cross guard's
  // cell. This is not a pickup-clear issue; it must be an ordering failure.
  const guard = level.steps.find((s) => s.id === 'guard');
  guard.requires = ['after'];
  const res = placeLevel(level, { seeds: 4 });
  assert.equal(res.ok, false);
  const codes = new Set(res.conflicts.map((c) => c.code));
  assert.ok(
    codes.has('ROUTE_STATE') || codes.has('DEPENDENCY_CYCLE'),
    `codes: ${[...codes].join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// 5. Old sample still runs to the end; conclusions are reproduced on re-run.
// ---------------------------------------------------------------------------

test('the original demo level still completes end to end', () => {
  const res = placeLevel(DEMO_LEVEL, { seeds: 6 });
  assert.equal(res.ok, true);
  assert.equal(res.proof.entries.length, DEMO_LEVEL.steps.length + DEMO_LEVEL.keys.length + 1);
  for (const s of DEMO_LEVEL.steps) assert.ok(res.proof.visitedSteps.includes(s.id), s.id);
  for (const k of DEMO_LEVEL.keys) assert.ok(res.proof.collectedKeys.includes(k.id), k.id);
  // Execution evidence: every leg is real, walkable, 4-neighbour, height-legal.
  const grid = buildGrid(DEMO_LEVEL);
  for (const leg of res.proof.route.legs) {
    assert.ok(leg.points.length >= 1);
    for (let i = 0; i < leg.points.length; i++) {
      const p = leg.points[i];
      const idx = worldToIndex(grid, p[0], p[2]);
      assert.ok(grid.cells[idx]?.walkable, `leg cell ${idx} walkable`);
      if (i > 0) {
        const q = leg.points[i - 1];
        assert.ok(Math.hypot(p[0] - q[0], p[2] - q[2]) <= 1.5 + 1e-6);
        assert.ok(Math.abs(p[1] - q[1]) <= grid.maxStep + 1e-6);
      }
    }
  }
});

test('re-running the same seed reproduces the same verdict and route', () => {
  for (const level of [DEMO_LEVEL, makeOrderingLevel()]) {
    const a = placeLevel(clone(level), { seeds: 1, onlySeed: 1 });
    const b = placeLevel(clone(level), { seeds: 1, onlySeed: 1 });
    assert.equal(a.ok, b.ok);
    assert.deepEqual(
      a.proof.entries.map((e) => [e.order, e.id, e.status]),
      b.proof.entries.map((e) => [e.order, e.id, e.status])
    );
    assert.deepEqual(
      a.placements.map((p) => [p.stepId, p.objectCell]),
      b.placements.map((p) => [p.stepId, p.objectCell])
    );
  }
});

test('an invalid scene keeps its failure evidence instead of an empty proof', () => {
  const res = placeLevel(makeInvalidLevel(), { seeds: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.placements.length, makeInvalidLevel().steps.length);
  const hard = res.conflicts.filter((c) => c.severity === 'hard');
  assert.ok(hard.length >= 4);
  for (const c of hard) {
    assert.ok(c.subjects.length > 0 || c.at, `${c.code} is locatable`);
  }
});
