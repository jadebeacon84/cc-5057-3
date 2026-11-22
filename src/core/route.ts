import type {
  KeyPlacement,
  LevelDef,
  Placement,
  ProofEntry,
  RouteLeg,
  RoutePlan,
  RouteStop,
  RunProof,
  Vec3,
} from './types.ts';
import type { NavGrid } from './nav.ts';
import { cellWorld, closedGateSet, findPath, nearestWalkable } from './nav.ts';

export interface PlanStop {
  kind: 'step' | 'key';
  id: string;
  label: string;
  role: 'main' | 'side' | 'key';
  objectCell: number;
  standCell: number;
  objectPos: Vec3;
  standPos: Vec3;
  zoneId: string;
  seq: number;
  requires: string[];
  interactionDistance: number;
  lineOfSight: boolean;
}

interface Edge {
  from: number;
  to: number;
  cost: number;
  leg: RouteLeg;
}

export interface PlanOutcome {
  ok: boolean;
  proof: RunProof;
  stuck: Array<{ id: string; reason: string; gate?: string; zoneId?: string }>;
}

export function keyOpenGates(level: LevelDef, keyMask: number): Set<string> {
  const gates = new Set<string>();
  for (let i = 0; i < level.keys.length; i++) {
    if (keyMask & (1 << i)) for (const g of level.keys[i].unlocks) gates.add(g);
  }
  return gates;
}

export function keyMaskLabel(level: LevelDef, mask: number): string {
  const names: string[] = [];
  for (let i = 0; i < level.keys.length; i++) {
    if (mask & (1 << i)) names.push(level.keys[i].label);
  }
  return names.length ? names.join(' + ') : 'no keys';
}

function idxOf(grid: NavGrid, cell: readonly [number, number]): number {
  const cx = cell[0];
  const cz = cell[1];
  if (cx < 0 || cz < 0 || cx >= grid.cols || cz >= grid.rows) return -1;
  const i = cz * grid.cols + cx;
  return grid.cells[i] ? i : -1;
}

class MinHeap<T extends { cost: number }> {
  private items: T[] = [];
  push(item: T) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}

/**
 * Exact state search over (completed steps, collected keys, last interacted stop).
 * Position is only ever a stop's approach cell or the entry, so the state space
 * stays small while movement still uses real walk-only grid paths.
 *
 * There is deliberately no teleport or flight transition: a route that would
 * require dropping a branch or bypassing a gate simply has no path to the goal.
 */
export function planRoute(
  level: LevelDef,
  grid: NavGrid,
  placements: Placement[],
  keys: KeyPlacement[]
): PlanOutcome {
  const steps = level.steps;
  const stepIndex = new Map(steps.map((s, i) => [s.id, i]));
  const keyIndex = new Map(level.keys.map((k, i) => [k.id, i]));

  const reserved = new Set<number>();
  const stops: PlanStop[] = [];
  for (const p of placements) {
    const oc = idxOf(grid, p.objectCell);
    const ac = idxOf(grid, p.approachCell);
    if (oc < 0 || ac < 0) continue;
    reserved.add(oc);
    const step = steps[stepIndex.get(p.stepId)!];
    stops.push({
      kind: 'step',
      id: p.stepId,
      label: step.label,
      role: step.role,
      objectCell: oc,
      standCell: ac,
      objectPos: p.objectPos,
      standPos: p.approachPos,
      zoneId: p.zoneId,
      seq: step.seq,
      requires: [...step.requires],
      interactionDistance: p.interactionDistance,
      lineOfSight: p.lineOfSight,
    });
  }
  for (const k of keys) {
    const oc = idxOf(grid, k.cell);
    const ac = idxOf(grid, k.approachCell);
    if (oc < 0 || ac < 0) continue;
    reserved.add(oc);
    const key = level.keys[keyIndex.get(k.keyId)!];
    stops.push({
      kind: 'key',
      id: k.keyId,
      label: key.label,
      role: 'key',
      objectCell: oc,
      standCell: ac,
      objectPos: k.pos,
      standPos: k.approachPos,
      zoneId: k.zoneId,
      seq: -1,
      requires: [],
      interactionDistance: Math.hypot(
        k.pos[0] - k.approachPos[0],
        k.pos[1] - k.approachPos[1],
        k.pos[2] - k.approachPos[2]
      ),
      lineOfSight: true,
    });
  }

  const entryCell = grid.entryCell;
  const exitCell = nearestWalkable(grid, level.exitPoint[0], level.exitPoint[2], 6);
  if (entryCell < 0) {
    return { ok: false, proof: failProof('The entry point is not walkable.'), stuck: [
      { id: 'entry', reason: 'Entry is not on a walkable cell.' },
    ] };
  }
  if (exitCell < 0) {
    return { ok: false, proof: failProof('No walkable cell at the single-destination exit.'), stuck: [
      { id: 'exit', reason: 'Exit is not on a walkable cell.' },
    ] };
  }

  const nodes = stops;
  const nodeByKey = new Map<string, number>();
  nodes.forEach((s, i) => nodeByKey.set(`${s.kind}:${s.id}`, i));

  const pathCache = new Map<string, ReturnType<typeof findPath>>();
  const edge = (fromCell: number, toCell: number, gates: Set<string>): ReturnType<typeof findPath> => {
    const gk = [...gates].sort().join(',');
    const cacheKey = `${fromCell}>${toCell}|${gk}`;
    let v = pathCache.get(cacheKey);
    if (!v) {
      v = findPath(grid, fromCell, toCell, gates, reserved);
      pathCache.set(cacheKey, v);
    }
    return v;
  };

  const startState = `E|0|0`;
  const best = new Map<string, number>();
  const prev = new Map<string, { state: string; edge?: RouteLeg; stopIndex?: number; kind?: 'step' | 'key'; toExit?: boolean }>();
  const heap = new MinHeap<{ state: string; cost: number }>();
  best.set(startState, 0);
  heap.push({ state: startState, cost: 0 });
  const allDone = (1 << steps.length) - 1;

  let goalState: string | null = null;

  const parseState = (state: string) => {
    const [nodeStr, doneStr, keyStr] = state.split('|');
    const node = nodeStr === 'E' ? -1 : Number(nodeStr);
    return { node, done: Number(doneStr), keyMask: Number(keyStr) };
  };  while (heap.size) {
    const item = heap.pop()!;
    if (item.cost > (best.get(item.state) ?? Infinity) + 1e-9) continue;
    if (item.state.startsWith('X|')) {
      goalState = item.state;
      break;
    }
    const { node, done, keyMask } = parseState(item.state);
    const gates = keyOpenGates(level, keyMask);
    const posCell = node < 0 ? entryCell : nodes[node].standCell;

    if (done === allDone) {
      const p = edge(posCell, exitCell, gates);
      if (p.found) {
        const next = `X|${done}|${keyMask}`;
        const cost = item.cost + p.distance;
        if (cost < (best.get(next) ?? Infinity)) {
          best.set(next, cost);
          prev.set(next, { state: item.state, edge: legOf(p, gates), toExit: true });
          heap.push({ state: next, cost });
        }
      }
    }

    for (let ni = 0; ni < nodes.length; ni++) {
      if (ni === node) continue;
      const stop = nodes[ni];
      if (stop.kind === 'step') {
        const si = stepIndex.get(stop.id)!;
        if (done & (1 << si)) continue;
        if (!dependenciesMet(stop.requires, done, stepIndex)) continue;
      } else {
        const ki = keyIndex.get(stop.id)!;
        if (keyMask & (1 << ki)) continue;
      }
      const path = edge(posCell, stop.standCell, gates);
      if (!path.found) continue;
      const nextDone = stop.kind === 'step' ? done | (1 << stepIndex.get(stop.id)!) : done;
      const nextKey = stop.kind === 'key' ? keyMask | (1 << keyIndex.get(stop.id)!) : keyMask;
      const next = `${ni}|${nextDone}|${nextKey}`;
      const penalty = stop.kind === 'step' ? orderPenalty(level, done, stop.id) : 0.02;
      const cost = item.cost + path.distance + penalty;
      if (cost < (best.get(next) ?? Infinity)) {
        best.set(next, cost);
        prev.set(next, { state: item.state, edge: legOf(path, gates), stopIndex: ni, kind: stop.kind });
        heap.push({ state: next, cost });
      }
    }
  }

  if (!goalState) {
    const stuck = diagnose(level, grid, stops, entryCell, reserved);
    const proof = failProof(
      stuck.length
        ? `No walk-only completion exists. ${stuck.length} stop(s) can never be reached: ${stuck.map((s) => `${s.id} (${s.reason})`).join('; ')}.`
        : 'No walk-only completion exists: every stop is individually reachable but the full step/key/exit state sequence is not.'
    );
    return { ok: false, proof, stuck };
  }

  // Reconstruct chain.
  const chain: Array<{ state: string; edge?: RouteLeg; stopIndex?: number; kind?: 'step' | 'key'; toExit?: boolean }> = [];
  let at = goalState;
  while (at !== startState) {
    const p = prev.get(at);
    if (!p) break;
    chain.push(p);
    at = p.state;
  }
  chain.reverse();

  const routeStops: RouteStop[] = [];
  const entries: ProofEntry[] = [];
  const visited: string[] = [];
  const collected: string[] = [];
  const opened: string[] = [];
  const legs: RouteLeg[] = [];
  let order = 0;

  for (const link of chain) {
    if (link.edge) legs.push(link.edge);
    if (link.toExit) {
      const zid = grid.cells[exitCell]?.zoneId ?? '';
      routeStops.push({
        order: ++order,
        kind: 'exit',
        id: 'exit',
        label: 'Single-destination exit',
        role: 'exit',
        pos: level.exitPoint,
        standPos: cellWorld(grid, exitCell),
        zoneId: zid,
        reachState: opened.length ? `open: ${opened.join(', ')}` : 'no gates open',
      });
      entries.push({
        order,
        id: 'exit',
        kind: 'exit',
        status: 'ok',
        label: 'Single-destination exit',
        why: `Walked ${(link.edge?.distance ?? 0).toFixed(1)} m on walkable cells to the one-way grate. Reaching it terminates the level.`,
        standPos: cellWorld(grid, exitCell),
        reachState: 'route complete',
      });
      continue;
    }
    if (link.stopIndex === undefined) continue;
    const stop = nodes[link.stopIndex];
    const stopOrder = ++order;
    if (stop.kind === 'key') {
      collected.push(stop.id);
      const def = level.keys.find((k) => k.id === stop.id)!;
      for (const g of def.unlocks) if (!opened.includes(g)) opened.push(g);
    } else {
      visited.push(stop.id);
    }
    const stateLabel = opened.length ? `open: ${opened.join(', ')}` : 'no gates open';
    routeStops.push({
      order: stopOrder,
      kind: stop.kind,
      id: stop.id,
      label: stop.label,
      role: stop.role,
      pos: stop.objectPos,
      standPos: stop.standPos,
      zoneId: stop.zoneId,
      reachState: stateLabel,
    });
    const radius = stop.kind === 'step' ? stepRadius(level, stop.id) : 1.3;
    const keyDef = stop.kind === 'key' ? level.keys.find((k) => k.id === stop.id) : undefined;
    entries.push({
      order: stopOrder,
      id: stop.id,
      kind: stop.kind,
      status: 'ok',
      label: stop.label,
      why:
        stop.kind === 'key'
          ? `Picked up ${stop.label} in ${stop.zoneId} after walking ${(link.edge?.distance ?? 0).toFixed(1)} m; opens ${keyDef?.unlocks.join(', ') || 'nothing'}.`
          : `Walked ${(link.edge?.distance ?? 0).toFixed(1)} m to ${stop.zoneId}; stood at ${stop.interactionDistance.toFixed(2)} m from the object (limit ${radius.toFixed(1)} m)${stop.lineOfSight ? ', line of sight clear' : ''}.`,
      standPos: stop.standPos,
      reachState: stateLabel,
      interactionDistance: stop.interactionDistance,
      lineOfSight: stop.lineOfSight,
    });
  }

  const missing = steps.filter((s) => !visited.includes(s.id));
  if (missing.length) {
    return {
      ok: false,
      proof: failProof(`Plan reached the exit without: ${missing.map((m) => m.id).join(', ')}.`),
      stuck: missing.map((m) => ({ id: m.id, reason: 'absent from the reconstructed proof' })),
    };
  }

  let interactionsOk = true;
  for (const entry of entries) {
    if (entry.kind !== 'step') continue;
    const radius = stepRadius(level, entry.id);
    if (entry.interactionDistance === undefined || entry.interactionDistance > radius + 1e-6) {
      entry.status = 'interaction-fail';
      entry.why = `Interaction distance ${entry.interactionDistance?.toFixed(2)} m exceeds the ${radius.toFixed(1)} m range.`;
      interactionsOk = false;
    } else if (entry.lineOfSight === false) {
      entry.status = 'interaction-fail';
      entry.why = 'Line of sight to the object is blocked by static geometry.';
      interactionsOk = false;
    }
  }

  // Merge consecutive zero-length legs to keep the proof readable.
  const merged = mergeLegs(legs);
  const totalDistance = merged.reduce((a, l) => a + l.distance, 0);
  const route: RoutePlan = { stops: routeStops, legs: merged, totalDistance, mode: 'walk' };

  return {
    ok: interactionsOk,
    proof: {
      ok: interactionsOk,
      mode: 'walk',
      entries,
      route,
      visitedSteps: visited,
      collectedKeys: collected,
      openedGates: opened,
      issues: interactionsOk ? [] : ['At least one interaction fails its range/line-of-sight check.'],
    },
    stuck: [],
  };
}

function mergeLegs(legs: RouteLeg[]): RouteLeg[] {
  const out: RouteLeg[] = [];
  for (const l of legs) {
    if (l.distance < 1e-6 && out.length > 0) {
      out[out.length - 1] = {
        ...out[out.length - 1],
        to: l.to,
        points: [...out[out.length - 1].points, ...l.points.slice(1)],
      };
      continue;
    }
    out.push(l);
  }
  return out;
}

function stepRadius(level: LevelDef, id: string): number {
  return level.steps.find((s) => s.id === id)?.interaction.radius ?? 0;
}

function dependenciesMet(requires: string[], done: number, index: Map<string, number>): boolean {
  for (const r of requires) {
    const i = index.get(r);
    if (i === undefined) return false;
    if (!(done & (1 << i))) return false;
  }
  return true;
}

function orderPenalty(level: LevelDef, doneMask: number, stepId: string): number {
  const step = level.steps.find((s) => s.id === stepId)!;
  let maxDoneSeq = -1;
  for (let i = 0; i < level.steps.length; i++) {
    if (doneMask & (1 << i)) maxDoneSeq = Math.max(maxDoneSeq, level.steps[i].seq);
  }
  return step.seq < maxDoneSeq ? 4 + 0.5 * (maxDoneSeq - step.seq) : 0;
}

function legOf(path: ReturnType<typeof findPath>, gates: Set<string>): RouteLeg {
  return {
    from: path.points[0] ?? [0, 0, 0],
    to: path.points[path.points.length - 1] ?? [0, 0, 0],
    points: path.points,
    distance: path.distance,
    openedGates: [...gates],
  };
}

function failProof(issue: string): RunProof {
  return {
    ok: false,
    mode: 'walk',
    entries: [],
    route: { stops: [], legs: [], totalDistance: 0, mode: 'walk' },
    visitedSteps: [],
    collectedKeys: [],
    openedGates: [],
    issues: [issue],
  };
}

/**
 * Explore the reachable (done, keyMask) closure (ignoring travel cost) to find
 * stops that can never be completed. This is what separates "the table has a
 * cycle" from "the table is acyclic but the level is still impossible".
 */
function diagnose(
  level: LevelDef,
  grid: NavGrid,
  stops: PlanStop[],
  entryCell: number,
  reserved: ReadonlySet<number>
): PlanOutcome['stuck'] {
  const stepIndex = new Map(level.steps.map((s, i) => [s.id, i]));
  const keyIndex = new Map(level.keys.map((k, i) => [k.id, i]));
  const stepStop = new Map(stops.filter((s) => s.kind === 'step').map((s) => [s.id, s]));
  const keyStop = new Map(stops.filter((s) => s.kind === 'key').map((s) => [s.id, s]));
  const seen = new Set<string>();
  const queue: Array<{ done: number; keyMask: number }> = [{ done: 0, keyMask: 0 }];
  const stepsDoneSomewhere = new Set<string>();
  const keysCollectedSomewhere = new Set<string>();

  const closureFields = new Map<number, Set<number>>();
  const reachSet = (keyMask: number): Set<number> => {
    let s = closureFields.get(keyMask);
    if (s) return s;
    const gates = keyOpenGates(level, keyMask);
    const closed = closedGateSet(grid, gates);
    const out = new Set<number>();
    const q = [entryCell];
    const seenCells = new Set<number>([entryCell]);
    while (q.length) {
      const cur = q.pop()!;
      out.add(cur);
      const cc = grid.cells[cur]!;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cc.cx + dx;
        const nz = cc.cz + dz;
        if (nx < 0 || nz < 0 || nx >= grid.cols || nz >= grid.rows) continue;
        const ni = nz * grid.cols + nx;
        const nc = grid.cells[ni];
        if (!nc || !nc.walkable) continue;
        if (seenCells.has(ni) || closed.has(ni) || reserved.has(ni)) continue;
        if (Math.abs(nc.y - cc.y) > grid.maxStep + 1e-6) continue;
        seenCells.add(ni);
        q.push(ni);
      }
    }
    closureFields.set(keyMask, out);
    return out;
  };

  while (queue.length) {
    const s = queue.pop()!;
    const key = `${s.done}|${s.keyMask}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reach = reachSet(s.keyMask);

    for (const stop of stops) {
      if (!reach.has(stop.standCell)) continue;
      if (stop.kind === 'key') {
        const ki = keyIndex.get(stop.id)!;
        if (!(s.keyMask & (1 << ki))) {
          keysCollectedSomewhere.add(stop.id);
          queue.push({ done: s.done, keyMask: s.keyMask | (1 << ki) });
        }
      } else {
        const si = stepIndex.get(stop.id)!;
        if (s.done & (1 << si)) continue;
        if (dependenciesMet(stop.requires, s.done, stepIndex)) {
          stepsDoneSomewhere.add(stop.id);
          queue.push({ done: s.done | (1 << si), keyMask: s.keyMask });
        }
      }
    }
  }

  const stuck: PlanOutcome['stuck'] = [];
  for (const stop of stops) {
    if (stop.kind === 'key' && !keysCollectedSomewhere.has(stop.id)) {
      const def = level.keys.find((k) => k.id === stop.id)!;
      stuck.push({
        id: stop.id,
        reason: `key pickup in ${stop.zoneId} is unreachable in every reachable gate state (its own gate “${def.unlocks.join(', ')}” is never openable before the key)`,
        gate: def.unlocks.join(', ') || undefined,
        zoneId: stop.zoneId,
      });
    }
    if (stop.kind === 'step' && !stepsDoneSomewhere.has(stop.id)) {
      const def = level.steps.find((x) => x.id === stop.id)!;
      const unmet = def.requires.filter((r) => !stepsDoneSomewhere.has(r));
      stuck.push({
        id: stop.id,
        reason: unmet.length
          ? `dependencies never become satisfiable (${unmet.join(', ')})`
          : `no reachable approach cell under any key state; a gate, prop or interaction range blocks it`,
        zoneId: stop.zoneId,
      });
    }
  }
  return stuck;
}
