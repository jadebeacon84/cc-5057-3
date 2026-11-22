import type {
  Conflict,
  KeyDef,
  KeyPlacement,
  LevelDef,
  Placement,
  PlacementResult,
  QuestStepDef,
  RejectionReason,
  ScorePart,
  SeedSummary,
  Vec3,
} from './types.ts';
import type { NavGrid } from './nav.ts';
import {
  buildGrid,
  cellWorld,
  closedGateSet,
  nearestWalkable,
  worldToIndex,
  lineOfSight,
} from './nav.ts';
import { keyGateOrderConflicts, staticConflicts, topoOrder } from './staticAnalysis.ts';
import { planRoute, keyOpenGates } from './route.ts';

interface Candidate {
  zoneId: string;
  cell: readonly [number, number];
  objectIdx: number;
  approach: readonly [number, number];
  approachIdx: number;
  pos: Vec3;
  approachPos: Vec3;
  interactionDistance: number;
  lineOfSight: boolean;
  parts: ScorePart[];
  baseScore: number;
  critical: boolean;
  reject: RejectionReason[];
}

interface Attempt {
  steps: Map<string, Candidate>;
  keys: Map<string, KeyCandidate>;
  softCost: number;
  hardViolations: number;
  conflicts: Conflict[];
}

interface KeyCandidate {
  keyId: string;
  zoneId: string;
  cell: readonly [number, number];
  approach: readonly [number, number];
  pos: Vec3;
  approachPos: Vec3;
  reachStateNote: string;
  safe: boolean;
  score: number;
  reject: RejectionReason[];
  distanceToExit: number;
}

const SOFT_CONSTRAINT_WEIGHT = 5;
const HARD_CONSTRAINT_WEIGHT = 1e4;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dist3(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function dist2(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function idxOfCell(grid: NavGrid, cell: readonly [number, number]): number {
  return cell[1] * grid.cols + cell[0];
}

function cellPos(grid: NavGrid, idx: number): Vec3 {
  return cellWorld(grid, idx);
}

function posOfIndex(grid: NavGrid, idx: number): Vec3 {
  return cellWorld(grid, idx);
}

/**
 * A cell is critical if removing it splits its own walkable neighbours into
 * more than one connected group. Checking only the first two neighbours misses
 * a cut at a T-junction, where blocking the cell disconnects the third arm
 * while the first two still touch each other.
 */
function isCritical(grid: NavGrid, idx: number, blocked: ReadonlySet<number>): boolean {
  const c = grid.cells[idx];
  if (!c) return true;
  const nbrs: number[] = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = c.cx + dx;
    const nz = c.cz + dz;
    if (nx < 0 || nz < 0 || nx >= grid.cols || nz >= grid.rows) continue;
    const ni = nz * grid.cols + nx;
    const nc = grid.cells[ni];
    if (!nc || !nc.walkable || blocked.has(ni)) continue;
    if (Math.abs(nc.y - c.y) > grid.maxStep + 1e-6) continue;
    nbrs.push(ni);
  }
  if (nbrs.length <= 1) return false;
  // BFS from the first neighbour avoiding idx; every other neighbour must be
  // in the same component, otherwise idx is a separator.
  const seen = new Set<number>([nbrs[0], idx]);
  const queue = [nbrs[0]];
  while (queue.length) {
    const cur = queue.pop()!;
    const cc = grid.cells[cur]!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cc.cx + dx;
      const nz = cc.cz + dz;
      if (nx < 0 || nz < 0 || nx >= grid.cols || nz >= grid.rows) continue;
      const ni = nz * grid.cols + nx;
      const nc = grid.cells[ni];
      if (!nc || !nc.walkable || blocked.has(ni) || seen.has(ni)) continue;
      if (Math.abs(nc.y - cc.y) > grid.maxStep + 1e-6) continue;
      seen.add(ni);
      queue.push(ni);
    }
  }
  return nbrs.some((n) => !seen.has(n));
}

interface CandidateSpace {
  byStep: Map<string, Candidate[]>;
  rejections: Map<string, RejectionReason[]>;
}

/**
 * Enumerate feasible object placements. An object may only sit on a walkable
 * cell with at least one standable cell inside the interaction radius; place
 * objects in a one-cell corridor only when the corridor stays connected.
 */
function buildCandidateSpace(level: LevelDef, grid: NavGrid): CandidateSpace {
  const byStep = new Map<string, Candidate[]>();
  const rejections = new Map<string, RejectionReason[]>();

  const gateCells = new Set<number>();
  for (const list of grid.gateCells.values()) for (const i of list) gateCells.add(i);

  const occupancy = new Set<number>(); // only static: gate cells

  for (const step of level.steps) {
    const list: Candidate[] = [];
    const rejects: RejectionReason[] = [];
    const pushReject = (reason: string) => {
      const r = rejects.find((x) => x.reason === reason);
      if (r) r.count++;
      else rejects.push({ reason, count: 1 });
    };

    for (let idx = 0; idx < grid.cells.length; idx++) {
      const c = grid.cells[idx];
      if (!c || !c.walkable) continue;
      if (c.zoneId === null) continue;
      if (gateCells.has(idx)) {
        pushReject('object cell lies on a gate threshold');
        continue;
      }
      if (occupancy.has(idx)) continue;
      if (step.requiredKind) {
        const zone = level.zones.find((z) => z.id === c.zoneId);
        if (!zone || zone.kind !== step.requiredKind) {
          pushReject(`zone kind is not the hard-required “${step.requiredKind}”`);
          continue;
        }
      }
      const pos: Vec3 = [c.x, c.y, c.z];
      const approach = findApproach(level, grid, c, step, gateCells);
      if (!approach) {
        pushReject('no standable cell inside the interaction radius with line of sight');
        continue;
      }
      const interactionDistance = dist3(pos, cellPos(grid, approach.idx));
      const los = approach.los;
      const parts: ScorePart[] = [];
      const zone = level.zones.find((z) => z.id === c.zoneId);

      if (zone) {
        if (step.requiredKind) {
          parts.push({ label: 'hard zone kind', value: 0, weight: 0, note: `${zone.name} is a ${zone.kind} zone` });
        } else {
          const preferred = step.preferredZone === c.zoneId;
          const kindMatch = zone.kind === step.zoneHint;
          if (preferred) {
            parts.push({ label: 'preferred zone', value: 0, weight: 0, note: `${zone.name} matches the pinned zone` });
          } else if (kindMatch) {
            parts.push({ label: 'zone kind', value: 0, weight: 0, note: `${zone.name} is ${zone.kind}, matching the hint` });
          } else {
            parts.push({
              label: 'zone hint miss',
              value: 4,
              weight: 1,
              note: `${zone.name} is ${zone.kind}, hint was ${step.zoneHint}`,
            });
          }
        }
      }

      const approachZone = grid.cells[approach.idx]?.zoneId;
      if (approachZone && c.zoneId && approachZone !== c.zoneId) {
        parts.push({
          label: 'approach in another zone',
          value: 1.5,
          weight: 1,
          note: `the character must stand in ${approachZone} to interact`,
        });
      }

      const critical = isCritical(grid, idx, occupancy);
      if (critical) {
        parts.push({
          label: 'chokepoint',
          value: 8,
          weight: 1,
          note: 'the object would block the only route through this cell',
        });
      }
      const freeNeighbours = countNeighbours(grid, idx);
      if (freeNeighbours <= 2) {
        parts.push({
          label: 'tight approach',
          value: (3 - freeNeighbours) * 1.2,
          weight: 1,
          note: `only ${freeNeighbours} walkable neighbours; cramped interaction`,
        });
      }
      // Interaction cells with a wide apron make the animation/physics safer.
      if (interactionDistance > step.interaction.radius - 0.15) {
        parts.push({
          label: 'at interaction edge',
          value: 1,
          weight: 1,
          note: `stand-off ${interactionDistance.toFixed(2)} m is near the ${step.interaction.radius.toFixed(1)} m limit`,
        });
      }

      const baseScore = parts.reduce((a, p) => a + p.value * p.weight, 0);
      list.push({
        zoneId: c.zoneId,
        cell: [c.cx, c.cz],
        objectIdx: idx,
        approach: [grid.cells[approach.idx]!.cx, grid.cells[approach.idx]!.cz],
        approachIdx: approach.idx,
        pos,
        approachPos: cellPos(grid, approach.idx),
        interactionDistance,
        lineOfSight: los,
        parts,
        baseScore,
        critical,
        reject: [],
      });
    }
    list.sort((a, b) => a.baseScore - b.baseScore);
    byStep.set(step.id, list);
    rejections.set(step.id, rejects);
  }
  return { byStep, rejections };
}

function countNeighbours(grid: NavGrid, idx: number): number {
  const c = grid.cells[idx];
  if (!c) return 0;
  let n = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = c.cx + dx;
    const nz = c.cz + dz;
    if (nx < 0 || nz < 0 || nx >= grid.cols || nz >= grid.rows) continue;
    const nc = grid.cells[nz * grid.cols + nx];
    if (nc && nc.walkable && Math.abs(nc.y - c.y) <= grid.maxStep + 1e-6) n++;
  }
  return n;
}

function findApproach(
  level: LevelDef,
  grid: NavGrid,
  objectCell: NonNullable<NavGrid['cells'][number]>,
  step: QuestStepDef,
  gateCells: ReadonlySet<number>
): { idx: number; los: boolean } | null {
  const radius = step.interaction.radius;
  const r = Math.ceil(radius) + 1;
  const candidates: Array<{ idx: number; los: boolean; score: number }> = [];
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dz === 0) continue;
      const cx = objectCell.cx + dx;
      const cz = objectCell.cz + dz;
      if (cx < 0 || cz < 0 || cx >= grid.cols || cz >= grid.rows) continue;
      const idx = cz * grid.cols + cx;
      const c = grid.cells[idx];
      if (!c || !c.walkable) continue;
      if (gateCells.has(idx)) continue;
      const d = Math.hypot(c.x - objectCell.x, c.y - objectCell.y, c.z - objectCell.z);
      if (d > radius + 1e-6) continue;
      if (step.interaction.requiresLineOfSight && !lineOfSight(grid, [c.x, c.y, c.z], [objectCell.x, objectCell.y, objectCell.z])) {
        continue;
      }
      const los = !step.interaction.requiresLineOfSight
        ? lineOfSight(grid, [c.x, c.y, c.z], [objectCell.x, objectCell.y, objectCell.z])
        : true;
      // Prefer a cell with room to stand and a comfortable (not edge) distance.
      const nb = countNeighbours(grid, idx);
      const distScore = Math.abs(d - Math.min(radius * 0.7, radius - 0.2)) * 0.4;
      candidates.push({ idx, los, score: -nb * 0.3 + distScore });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  return { idx: candidates[0].idx, los: candidates[0].los };
}

// --------------------------------------------------------------- collisions

interface StepEvalContext {
  sig: string;
}

const pairConstraintCache = new WeakMap<LevelDef, Map<string, string[]>>();

function constraintsBetween(level: LevelDef, a: string, b: string): Array<LevelDef['constraints'][number]> {
  const out: Array<LevelDef['constraints'][number]> = [];
  for (const c of level.constraints) {
    if (c.a === a && c.b === b) out.push(c);
    else if (c.a === b && c.b === a) out.push(c);
  }
  return out;
}

function isImpossibleWindow(c: LevelDef['constraints'][number]): boolean {
  return c.minDist !== undefined && c.maxDist !== undefined && c.minDist > c.maxDist;
}

function pairCost(
  level: LevelDef,
  a: { id: string; pos: Vec3 },
  b: { id: string; pos: Vec3 }
): { soft: number; hard: number; notes: string[] } {
  let soft = 0;
  let hard = 0;
  const notes: string[] = [];
  const d = dist3(a.pos, b.pos);
  for (const c of constraintsBetween(level, a.id, b.id)) {
    if (isImpossibleWindow(c)) continue; // reported as a static conflict
    if (c.minDist !== undefined && d < c.minDist - 1e-6) {
      const v = (c.minDist - d) * (c.weight ?? 1);
      if (c.hard) {
        hard += 1;
        notes.push(`hard min ${c.minDist}: ${d.toFixed(1)} m`);
      } else {
        soft += v * SOFT_CONSTRAINT_WEIGHT;
        notes.push(`soft min ${c.minDist}: ${d.toFixed(1)} m`);
      }
    }
    if (c.maxDist !== undefined && d > c.maxDist + 1e-6) {
      const v = (d - c.maxDist) * (c.weight ?? 1);
      if (c.hard) {
        hard += 1;
        notes.push(`hard max ${c.maxDist}: ${d.toFixed(1)} m`);
      } else {
        soft += v * SOFT_CONSTRAINT_WEIGHT;
        notes.push(`soft max ${c.maxDist}: ${d.toFixed(1)} m`);
      }
    }
  }
  return { soft, hard, notes };
}

// ------------------------------------------------------------- key hiding

interface ReachInfo {
  /** For each reachable key mask, the walkable cells reachable from the entry. */
  cellsByMask: Map<number, Set<number>>;
  reachableMasks: number[];
  reachableCells: Set<number>;
  closureNotes: string[];
}

/**
 * Compute key placement safety from movement state, not geometric distance.
 * A key may only be hidden in a cell reachable in some state where that key has
 * not yet been collected (otherwise the key would be behind its own gate).
 *
 * The item-set enumeration is only sound if a mask transition is taken for a
 * key that is actually collectable in the current state. Expanding every key
 * unconditionally fabricates states such as "hold A and B" even when A is
 * behind B's gate and B behind A's gate; that over-approximation then labels a
 * mutually locked hiding cell as safe. We therefore expand a key only when at
 * least one of its allowed cells is reachable with the gates currently open.
 */
function reachabilityForKeys(level: LevelDef, grid: NavGrid): ReachInfo {
  const cellsByMask = new Map<number, Set<number>>();
  const reachableMasks: number[] = [];
  const reachableCells = new Set<number>();
  const closureNotes: string[] = [];
  const seenMasks = new Set<number>();
  const queue: Array<{ mask: number; note: string }> = [{ mask: 0, note: 'entry, all gates closed' }];

  const gateCells = new Set<number>();
  for (const list of grid.gateCells.values()) for (const i of list) gateCells.add(i);

  const allowedFor = (key: KeyDef, idx: number): boolean => {
    const c = grid.cells[idx];
    if (!c || !c.walkable || !c.zoneId) return false;
    if (gateCells.has(idx)) return false;
    const forced = level.config?.forcedKeyZones?.[key.id];
    if (forced && c.zoneId !== forced) return false;
    // Collectable means reachable *and* standable: a cell with no approach
    // inside the key's radius can never actually yield the key, so taking that
    // state transition would again over-approximate the item set.
    return findKeyApproach(grid, c, key.radius, gateCells) !== null;
  };

  while (queue.length) {
    const { mask, note } = queue.shift()!;
    if (seenMasks.has(mask)) continue;
    seenMasks.add(mask);
    const open = keyOpenGates(level, mask);
    const closed = closedGateSet(grid, open);
    const cells = new Set<number>();
    const stack = [grid.entryCell];
    const seen = new Set<number>([grid.entryCell]);
    if (grid.cells[grid.entryCell]?.walkable) cells.add(grid.entryCell);
    while (stack.length) {
      const cur = stack.pop()!;
      const cc = grid.cells[cur]!;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cc.cx + dx;
        const nz = cc.cz + dz;
        if (nx < 0 || nz < 0 || nx >= grid.cols || nz >= grid.rows) continue;
        const ni = nz * grid.cols + nx;
        const nc = grid.cells[ni];
        if (!nc || !nc.walkable || seen.has(ni) || closed.has(ni)) continue;
        if (Math.abs(nc.y - cc.y) > grid.maxStep + 1e-6) continue;
        seen.add(ni);
        cells.add(ni);
        stack.push(ni);
      }
    }
    cellsByMask.set(mask, cells);
    reachableMasks.push(mask);
    for (const c of cells) reachableCells.add(c);
    closureNotes.push(`with ${keyMaskLabel(level, mask)}: ${cells.size} walkable cells`);

    for (let i = 0; i < level.keys.length; i++) {
      if (mask & (1 << i)) continue;
      const key = level.keys[i];
      // Only take a transition that the level can actually make: at least one
      // legal hiding cell for this key must be walkable right now.
      let collectable = false;
      for (const idx of cells) {
        if (allowedFor(key, idx)) {
          collectable = true;
          break;
        }
      }
      if (!collectable) continue;
      queue.push({ mask: mask | (1 << i), note: `after ${key.label}` });
    }
  }

  return { cellsByMask, reachableMasks, reachableCells, closureNotes };
}

function keyMaskLabel(level: LevelDef, mask: number): string {
  const names: string[] = [];
  for (let i = 0; i < level.keys.length; i++) {
    if (mask & (1 << i)) names.push(level.keys[i].label);
  }
  return names.length ? names.join(' + ') : 'no keys';
}

interface KeyCandidateSpace {
  byKey: Map<string, KeyCandidate[]>;
  safeCells: Set<number>;
  unsafeCells: Set<number>;
  closureNotes: string[];
  reachInfo: ReachInfo;
}

function buildKeySpace(level: LevelDef, grid: NavGrid): KeyCandidateSpace {
  const reach = reachabilityForKeys(level, grid);
  // Safe = reachable in some state before the key is collected. We cannot know
  // the collection moment per key analytically, so conservative safe set is the
  // union of reachable cells across all masks. Unsafe = cells only reachable
  // when *all* gates are closed... Actually unsafe for key K = any cell whose
  // only reachable masks include K. Compute per key below.
  const byKey = new Map<string, KeyCandidate[]>();
  const allCells = new Set<number>();
  for (const c of reach.cellsByMask.values()) for (const i of c) allCells.add(i);

  const safeCells = new Set<number>();
  const unsafeCells = new Set<number>();

  const gateCells = new Set<number>();
  for (const list of grid.gateCells.values()) for (const i of list) gateCells.add(i);

  for (let ki = 0; ki < level.keys.length; ki++) {
    const key = level.keys[ki];
    const list: KeyCandidate[] = [];
    const forcedZone = level.config?.forcedKeyZones?.[key.id];
    const otherCells = new Set<number>();
    for (const [mask, cells] of reach.cellsByMask) {
      if (mask & (1 << ki)) continue;
      for (const c of cells) otherCells.add(c);
    }
    const ownGateCells = new Set<number>();
    for (const gate of key.unlocks) {
      for (const c of grid.gateCells.get(gate) ?? []) ownGateCells.add(c);
    }
    const exitZones = new Set(level.zones.filter((z) => z.exit).map((z) => z.id));

    for (let idx = 0; idx < grid.cells.length; idx++) {
      const c = grid.cells[idx];
      if (!c || !c.walkable || !c.zoneId) continue;
      if (gateCells.has(idx)) continue;
      if (forcedZone && c.zoneId !== forcedZone) continue;
      const safe = otherCells.has(idx);
      if (safe) safeCells.add(idx);
      else unsafeCells.add(idx);
      if (!safe) {
        const onlyBehind = key.unlocks.some((g) => (grid.gateCells.get(g) ?? []).length > 0);
        if (!onlyBehind) {
          // Not reachable even with every gate closed: unreachable spawn.
        }
      }
      const approach = findKeyApproach(grid, c, key.radius, gateCells);
      if (!approach) continue;
      const pos: Vec3 = [c.x, c.y, c.z];
      const distanceToExit = dist3(pos, level.exitPoint);
      let score = 0;
      const notes: string[] = [];
      if (!safe) {
        score += 120;
        notes.push('cell is only reachable after this key’s own gate opens — self-locked');
      }
      const zone = level.zones.find((z) => z.id === c.zoneId);
      if (key.preferredZone && c.zoneId === key.preferredZone) {
        notes.push(`pinned to ${zone?.name ?? c.zoneId}`);
      } else if (key.hideHint && zone?.kind === key.hideHint) {
        score += 1;
        notes.push(`matches the ${key.hideHint} hiding hint`);
      } else {
        score += 7;
        notes.push(`not the preferred hiding ground (${key.hideHint ?? 'any'})`);
      }
      if (exitZones.has(c.zoneId)) {
        score += 60;
        notes.push('inside the one-way exit zone');
      }
      if (c.zoneId === 'hub') {
        score += 4;
        notes.push('visible from the entry plaza; too obvious for a hiding spot');
      }
      if (isCritical(grid, idx, new Set())) {
        score += 20;
        notes.push('would block a chokepoint');
      }
      if (countNeighbours(grid, idx) <= 1) {
        score += 1;
        notes.push('tucked into a dead end');
      }
      // A key should be a detour, not a doorstep.
      const gateDist = minGateDistance(grid, key, c);
      if (gateDist !== null) {
        if (gateDist < 4) {
          score += (4 - gateDist) * 2;
          notes.push(`only ${gateDist.toFixed(1)} m from the gate it opens; no search`);
        } else if (gateDist > 6) {
          score -= 0.6;
          notes.push(`hiding ${gateDist.toFixed(1)} m from the gate it opens`);
        }
      }
      list.push({
        keyId: key.id,
        zoneId: c.zoneId,
        cell: [c.cx, c.cz],
        approach: [grid.cells[approach.idx]!.cx, grid.cells[approach.idx]!.cz],
        pos,
        approachPos: cellPos(grid, approach.idx),
        reachStateNote: safe
          ? `reachable before this key is collected (state: ${describeReachState(level, reach, idx, ki)})`
          : `only reachable after opening ${key.unlocks.join(', ')} — rejected`,
        safe,
        score,
        reject: [],
        distanceToExit,
      });
    }
    list.sort((a, b) => a.score - b.score || a.distanceToExit - b.distanceToExit);
    byKey.set(key.id, list);
  }
  return { byKey, safeCells, unsafeCells, closureNotes: reach.closureNotes, reachInfo: reach };
}

function describeReachState(level: LevelDef, reach: ReachInfo, idx: number, keyIndex: number): string {
  const masks: string[] = [];
  for (const [mask, cells] of reach.cellsByMask) {
    // A state that already holds this key cannot be the state in which it is
    // picked up; including it would overstate the basis for the placement.
    if (mask & (1 << keyIndex)) continue;
    if (cells.has(idx)) masks.push(keyMaskLabel(level, mask));
  }
  if (!masks.length) return 'unreachable before collection';
  return `cell reachable under {${masks.join(' / ')}}`;
}

function minGateDistance(grid: NavGrid, key: KeyDef, c: NonNullable<NavGrid['cells'][number]>): number | null {
  let best: number | null = null;
  for (const gate of key.unlocks) {
    const list = grid.gateCells.get(gate);
    if (!list?.length) continue;
    for (const idx of list) {
      const gc = grid.cells[idx];
      if (!gc) continue;
      const d = Math.hypot(gc.x - c.x, gc.z - c.z);
      if (best === null || d < best) best = d;
    }
  }
  return best;
}

function findKeyApproach(
  grid: NavGrid,
  objectCell: NonNullable<NavGrid['cells'][number]>,
  radius: number,
  gateCells: ReadonlySet<number>
): { idx: number } | null {
  const r = Math.ceil(radius) + 1;
  let best: { idx: number; score: number } | null = null;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dz === 0) continue;
      const cx = objectCell.cx + dx;
      const cz = objectCell.cz + dz;
      if (cx < 0 || cz < 0 || cx >= grid.cols || cz >= grid.rows) continue;
      const idx = cz * grid.cols + cx;
      const c = grid.cells[idx];
      if (!c || !c.walkable || gateCells.has(idx)) continue;
      const d = Math.hypot(c.x - objectCell.x, c.y - objectCell.y, c.z - objectCell.z);
      if (d > radius + 1e-6) continue;
      const score = -countNeighbours(grid, idx) * 0.2 + Math.abs(d - radius * 0.75);
      if (!best || score < best.score) best = { idx, score };
    }
  }
  return best;
}

// --------------------------------------------------------------- selection

function stepOrder(level: LevelDef): string[] {
  const topo = topoOrder(level.steps);
  if (topo) return topo;
  return [...level.steps].sort((a, b) => a.seq - b.seq).map((s) => s.id);
}

function softObjective(
  level: LevelDef,
  placed: Map<string, Candidate>,
  step: QuestStepDef,
  cand: Candidate
): { cost: number; hard: number; notes: string[] } {
  let soft = cand.baseScore;
  let hard = 0;
  const notes: string[] = [];
  for (const [id, other] of placed) {
    const otherDef = level.steps.find((s) => s.id === id)!;
    const pc = pairCost(level, { id: step.id, pos: cand.pos }, { id, pos: other.pos });
    soft += pc.soft;
    hard += pc.hard;
    notes.push(...pc.notes);
    // Branch separation: side branches should not pile on top of each other,
    // unless a soft constraint explicitly wants them close.
    if (step.role === 'side' && otherDef.role === 'side') {
      const d = dist3(cand.pos, other.pos);
      const linked = constraintsBetween(level, step.id, id).length > 0;
      if (!linked && d < 4) soft += (4 - d) * 0.8;
    }
    if (step.role === 'main' && otherDef.role === 'main') {
      const d = dist3(cand.pos, other.pos);
      const linked = constraintsBetween(level, step.id, id).length > 0;
      // Narrative pacing: consecutive main beats feel better as a short trek.
      const gap = Math.abs(step.seq - otherDef.seq);
      if (gap <= 1) {
        if (d > 24) soft += (d - 24) * 0.15;
        if (d < 2.5) soft += (2.5 - d) * 0.5;
      }
      if (!linked && d < 1.5) soft += 3;
    }
  }
  // Anchor constraints against fixed scene points (entry / exit) must shape the
  // search too, not just the post-hoc conflict report.
  for (const fixed of [
    { id: 'entry', pos: level.entry },
    { id: 'exit', pos: level.exitPoint },
  ]) {
    const pc = pairCost(level, { id: step.id, pos: cand.pos }, fixed);
    soft += pc.soft;
    hard += pc.hard;
    notes.push(...pc.notes);
  }
  // Deps stay reasonably close so the branch reads as one errand.
  for (const r of step.requires) {
    const other = placed.get(r);
    if (!other) continue;
    const d = dist3(cand.pos, other.pos);
    if (d > 26 && step.role === 'side') soft += (d - 26) * 0.1;
  }
  return { cost: soft, hard, notes };
}

function attemptPlacement(
  level: LevelDef,
  grid: NavGrid,
  space: CandidateSpace,
  keySpace: KeyCandidateSpace,
  seed: number
): Attempt {
  const rng = mulberry32(seed);
  const order = stepOrder(level);
  const placed = new Map<string, Candidate>();
  const used = new Set<number>();

  for (const id of order) {
    const step = level.steps.find((s) => s.id === id)!;
    const cands = space.byStep.get(id) ?? [];
    let best: { cand: Candidate; cost: number; hard: number } | null = null;
    // Explore the full list but weight by jitter to get genuinely different seeds.
    for (const cand of cands) {
      if (used.has(cand.objectIdx) || used.has(cand.approachIdx)) continue;
      const ev = softObjective(level, placed, step, cand);
      const jitter = rng() * 2.2;
      const total = ev.cost + jitter + ev.hard * HARD_CONSTRAINT_WEIGHT;
      if (!best || total < best.cost) best = { cand, cost: total, hard: ev.hard };
    }
    if (best) {
      placed.set(id, best.cand);
      used.add(best.cand.objectIdx);
      used.add(best.cand.approachIdx);
    }
  }

  // Keys after steps: their safety is independent of step positions, but they
  // must not collide with step objects.
  const keyPlaced = new Map<string, KeyCandidate>();
  for (const key of level.keys) {
    const cands = keySpace.byKey.get(key.id) ?? [];
    let best: { cand: KeyCandidate; score: number } | null = null;
    for (const cand of cands) {
      const idx = worldToIndex(grid, cand.pos[0], cand.pos[2]);
      if (used.has(idx)) continue;
      if (cand.approachPos) {
        const aidx = worldToIndex(grid, cand.approachPos[0], cand.approachPos[2]);
        if (used.has(aidx)) continue;
      }
      const score = cand.score + rng() * 1.5;
      if (!best || score < best.score) best = { cand, score };
    }
    if (best) {
      keyPlaced.set(key.id, best.cand);
      used.add(worldToIndex(grid, best.cand.pos[0], best.cand.pos[2]));
    }
  }

  // Objective over the final set.
  let soft = 0;
  let hard = 0;
  const subjects = new Map<string, { id: string; pos: Vec3 }>();
  for (const [id, cand] of placed) {
    const step = level.steps.find((s) => s.id === id)!;
    soft += cand.baseScore;
    subjects.set(id, { id, pos: cand.pos });
  }
  for (const [id, cand] of keyPlaced) subjects.set(id, { id, pos: cand.pos });
  subjects.set('entry', { id: 'entry', pos: level.entry });
  subjects.set('exit', { id: 'exit', pos: level.exitPoint });

  for (let i = 0; i < level.constraints.length; i++) {
    const c = level.constraints[i];
    if (isImpossibleWindow(c)) continue;
    const a = subjects.get(c.a);
    const b = subjects.get(c.b);
    if (!a || !b) continue;
    const d = dist3(a.pos, b.pos);
    const check = (violated: boolean, amount: number, label: string) => {
      if (!violated) return;
      if (c.hard) hard += 1;
      else soft += amount * (c.weight ?? 1) * SOFT_CONSTRAINT_WEIGHT;
    };
    if (c.minDist !== undefined) check(d < c.minDist - 1e-6, c.minDist - d, c.note);
    if (c.maxDist !== undefined) check(d > c.maxDist + 1e-6, d - c.maxDist, c.note);
  }

  // Side-branch spread.
  const sides = [...placed.entries()].filter(([id]) => level.steps.find((s) => s.id === id)?.role === 'side');
  for (let i = 0; i < sides.length; i++) {
    for (let j = i + 1; j < sides.length; j++) {
      const d = dist3(sides[i][1].pos, sides[j][1].pos);
      if (d < 3) soft += (3 - d) * 0.5;
    }
  }

  return { steps: placed, keys: keyPlaced, softCost: soft, hardViolations: hard, conflicts: [] };
}

// ------------------------------------------------------------------ facade

export interface PlaceOptions {
  seeds?: number;
  /** Extra attempts keep searching after the first fully valid plan. */
  extraAttemptsWhenValid?: number;
  /** Re-run exactly this seed (used when a designer clicks a seed row). */
  onlySeed?: number;
}

export interface ManualOverride {
  stepId: string;
  /** World x/z of the clicked cell; the zone is inferred from the nav grid. */
  x: number;
  z: number;
}

export function placeLevel(level: LevelDef, opts: PlaceOptions = {}): PlacementResult {
  const t0 = performance.now();
  const grid = buildGrid(level);
  const staticList = [...staticConflicts(level), ...keyGateOrderConflicts(level)];
  const space = buildCandidateSpace(level, grid);
  const keySpace = buildKeySpace(level, grid);
  const seedCount = Math.max(1, opts.seeds ?? 8);
  const attempts: Array<{ attempt: Attempt; seed: number; result: ReturnType<typeof evaluateAttempt> }> = [];
  let attemptsRun = 0;

  for (let seed = 1; seed <= seedCount; seed++) {
    if (opts.onlySeed !== undefined && seed !== opts.onlySeed) continue;
    const attempt = attemptPlacement(level, grid, space, keySpace, seed);
    attemptsRun++;
    const result = evaluateAttempt(level, grid, attempt, space, keySpace);
    attempts.push({ attempt, seed, result });
    const extra = opts.extraAttemptsWhenValid ?? 0;
    if (result.ok && seed >= seedCount - extra) break;
  }

  attempts.sort((a, b) => {
    if (a.result.ok !== b.result.ok) return a.result.ok ? -1 : 1;
    const ca = a.result.metrics.hardViolations * 1e6 + a.result.metrics.softCost + a.result.metrics.routeLength * 0.05;
    const cb = b.result.metrics.hardViolations * 1e6 + b.result.metrics.softCost + b.result.metrics.routeLength * 0.05;
    return ca - cb;
  });

  const winner = attempts[0];
  const seeds: SeedSummary[] = attempts.map(({ attempt, seed, result }) => ({
    seed,
    ok: result.ok,
    softCost: round(attempt.softCost),
    hardViolations: attempt.hardViolations,
    routeLength: round(result.metrics.routeLength),
    placementSignature: signature(attempt),
    note: result.ok
      ? 'walk-only proof complete'
      : result.conflicts.find((c) => c.severity === 'hard')?.message ?? 'no complete walk-only route',
  }));

  if (!winner) {
    return emptyResult(level, grid, staticList, t0, attemptsRun);
  }

  const final = winner.result;
  const conflicts = [...staticList, ...final.conflicts, ...constraintConflicts(level, final.placements, final.keys)];
  const ok = final.ok && conflicts.every((c) => c.severity !== 'hard');

  return {
    ok,
    level,
    placements: final.placements,
    keys: final.keys,
    proof: final.proof,
    conflicts: dedupeConflicts(conflicts),
    metrics: {
      ...final.metrics,
      searchMs: Math.round(performance.now() - t0),
      attempts: attemptsRun,
    },
    seeds,
    staticConflicts: staticList,
  };
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

function signature(a: Attempt): string {
  const parts: string[] = [];
  for (const [id, c] of [...a.steps.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    parts.push(`${id}@${c.cell[0]},${c.cell[1]}`);
  }
  for (const [id, c] of [...a.keys.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    parts.push(`${id}@${c.cell[0]},${c.cell[1]}`);
  }
  return parts.join('|');
}

function emptyResult(level: LevelDef, grid: NavGrid, staticList: Conflict[], t0: number, attempts: number): PlacementResult {
  return {
    ok: false,
    level,
    placements: [],
    keys: [],
    proof: {
      ok: false,
      mode: 'walk',
      entries: [],
      route: { stops: [], legs: [], totalDistance: 0, mode: 'walk' },
      visitedSteps: [],
      collectedKeys: [],
      openedGates: [],
      issues: ['No candidate placement could be generated.'],
    },
    conflicts: staticList,
    metrics: {
      softCost: 0,
      hardViolations: 1,
      routeLength: 0,
      searchMs: Math.round(performance.now() - t0),
      attempts,
      candidatesExamined: 0,
    },
    seeds: [],
    staticConflicts: staticList,
  };
}

interface EvalResult {
  ok: boolean;
  placements: Placement[];
  keys: KeyPlacement[];
  proof: ReturnType<typeof planRoute>['proof'];
  conflicts: Conflict[];
  metrics: Omit<PlacementResult['metrics'], 'searchMs' | 'attempts'>;
}

function evaluateAttempt(
  level: LevelDef,
  grid: NavGrid,
  attempt: Attempt,
  space: CandidateSpace,
  keySpace: KeyCandidateSpace
): EvalResult {
  const placements: Placement[] = [];
  const keys: KeyPlacement[] = [];
  const conflicts: Conflict[] = [];
  let candidatesExamined = 0;

  const delivered = new Set<string>();

  for (const step of level.steps) {
    const cand = attempt.steps.get(step.id);
    const rejects = space.rejections.get(step.id) ?? [];
    candidatesExamined += (space.byStep.get(step.id) ?? []).length;
    if (!cand) {
      conflicts.push({
        code: 'NO_CELL_FOR_STEP',
        severity: 'hard',
        subjects: [step.id],
        message: `No valid placement exists for “${step.label}” (${rejects.map((r) => r.reason).slice(0, 2).join('; ') || 'no walkable candidate'}).`,
        suggestion: 'Relax the hard zone requirement, widen the interaction radius, or move blocking props.',
      });
      continue;
    }
    delivered.add(step.id);
    placements.push({
      stepId: step.id,
      zoneId: cand.zoneId,
      objectCell: cand.cell,
      objectPos: cand.pos,
      approachCell: cand.approach,
      approachPos: cand.approachPos,
      interactionDistance: cand.interactionDistance,
      lineOfSight: cand.lineOfSight,
      score: cand.baseScore,
      scoreParts: cand.parts,
      rejections: rejects,
      reachState: 'resolved at proof time',
      candidates: (space.byStep.get(step.id) ?? []).length,
      notes: [
        `object at (${cand.pos[0].toFixed(1)}, ${cand.pos[1].toFixed(1)}, ${cand.pos[2].toFixed(1)})`,
        `character stands at (${cand.approachPos[0].toFixed(1)}, ${cand.approachPos[1].toFixed(1)}, ${cand.approachPos[2].toFixed(1)})`,
        `interaction ${cand.interactionDistance.toFixed(2)} m of ${step.interaction.radius.toFixed(1)} m`,
      ],
    });
  }

  for (const key of level.keys) {
    const cand = attempt.keys.get(key.id);
    candidatesExamined += (keySpace.byKey.get(key.id) ?? []).length;
    if (!cand) {
      conflicts.push({
        code: 'NO_CELL_FOR_KEY',
        severity: 'hard',
        subjects: [key.id],
        message: `No reachable hiding cell exists for key “${key.label}”.`,
        suggestion: 'Allow the key in a zone reachable before its gate, or remove the pin to the exit zone.',
      });
      continue;
    }
    if (!cand.safe) {
      conflicts.push({
        code: 'KEY_BEHIND_GATE',
        severity: 'hard',
        subjects: [key.id, key.preferredZone ?? cand.zoneId],
        message: `Key “${key.label}” is hidden in ${cand.zoneId}, which is only reachable after ${key.unlocks.join(', ')} opens. The key is behind its own gate; geometric distance to the exit is irrelevant.`,
        suggestion: 'Hide the key in a zone reachable with the gate closed (e.g. tunnel, gallery, garden).',
        at: [cand.pos],
      });
    }
    delivered.add(key.id);
    keys.push({
      keyId: key.id,
      zoneId: cand.zoneId,
      cell: cand.cell,
      pos: cand.pos,
      approachCell: cand.approach,
      approachPos: cand.approachPos,
      gates: [...key.unlocks],
      reachStateNote: cand.reachStateNote,
      distanceToExit: cand.distanceToExit,
      candidates: (keySpace.byKey.get(key.id) ?? []).length,
      rejections: [],
      notes: [
        `hidden in ${cand.zoneId} at (${cand.pos[0].toFixed(1)}, ${cand.pos[2].toFixed(1)})`,
        `straight-line distance to the one-way exit: ${cand.distanceToExit.toFixed(1)} m (not used as a safety test)`,
        cand.reachStateNote,
      ],
    });
  }

  const plan = planRoute(level, grid, placements, keys);

  for (const s of plan.stuck) {
    const placement = placements.find((p) => p.stepId === s.id);
    const key = keys.find((k) => k.keyId === s.id);
    const zoneId = s.zoneId ?? placement?.zoneId ?? key?.zoneId ?? '?';
    const code = classifyStuck(level, grid, s, placements, keys);
    conflicts.push({
      code,
      severity: 'hard',
      subjects: [s.id],
      message: `“${s.id}” can never be completed: ${s.reason} (zone ${zoneId}).`,
      suggestion:
        code === 'KEY_SELF_LOCKED'
          ? `Move “${s.id}” to a zone reachable before the gate opens; the exit-side zone is only reachable after the gate.`
          : code === 'OBJECT_SEALS_PATH'
            ? 'An object that stays in the world blocks the only corridor. Use a consumable pickup there, widen the corridor, or place the object on a cell that is not a cut vertex.'
            : code === 'STEP_UNREACHABLE'
              ? 'Place the object with a reachable approach cell, or widen the interaction radius; check that props do not seal the room.'
              : 'The dependency order and open-gate state never line up. Check keys and requires together.',
      at: [placement?.objectPos, key?.pos].filter(Boolean) as Vec3[],
    });
  }
  if (!plan.ok && !plan.stuck.length) {
    conflicts.push({
      code: 'PROOF_INCOMPLETE',
      severity: 'hard',
      subjects: [],
      message: plan.proof.issues[0] ?? 'The walk-only proof is incomplete.',
      suggestion: 'Inspect the proof trace for the first failing stop.',
    });
  }

  // Failures of interaction range are hard too.
  for (const e of plan.proof.entries) {
    if (e.status !== 'ok') {
      conflicts.push({
        code: 'INTERACTION_FAIL',
        severity: 'hard',
        subjects: [e.id],
        message: `${e.label}: ${e.why}`,
        suggestion: 'Increase the interaction radius or place the object with clearance.',
      });
    }
  }

  // Attach the reach state to each placement based on the proof arrival.
  for (const p of placements) {
    const stop = plan.proof.route.stops.find((s) => s.id === p.stepId);
    if (stop) p.reachState = stop.reachState;
  }

  const ls = localitySummary(level, placements, keys);

  return {
    ok: plan.ok && conflicts.every((c) => c.severity !== 'hard'),
    placements,
    keys,
    proof: plan.proof,
    conflicts,
    metrics: {
      softCost: round(attempt.softCost + ls.penalty),
      hardViolations: attempt.hardViolations + conflicts.filter((c) => c.severity === 'hard').length,
      routeLength: round(plan.proof.route.totalDistance),
      candidatesExamined,
    },
  };
}

function localitySummary(
  level: LevelDef,
  placements: Placement[],
  keys: KeyPlacement[]
): { penalty: number } {
  const byId = new Map<string, Vec3>();
  for (const p of placements) byId.set(p.stepId, p.objectPos);
  for (const k of keys) byId.set(k.keyId, k.pos);
  byId.set('entry', level.entry);
  byId.set('exit', level.exitPoint);
  let penalty = 0;
  for (const c of level.constraints) {
    if (isImpossibleWindow(c) || c.hard) continue;
    const a = byId.get(c.a);
    const b = byId.get(c.b);
    if (!a || !b) continue;
    const d = dist3(a, b);
    if (c.minDist !== undefined && d < c.minDist) penalty += (c.minDist - d) * (c.weight ?? 1);
    if (c.maxDist !== undefined && d > c.maxDist) penalty += (d - c.maxDist) * (c.weight ?? 1);
  }
  return { penalty: round(penalty) };
}

/**
 * Name the real cause of a stuck stop instead of falling back to a catch-all.
 * - KEY_SELF_LOCKED: the stop is a key and the diagnosis found its gate.
 * - ROUTE_STATE: every object clears, but the dependency/gate order never lines
 *   up (e.g. exit requires a corridor stop that requires the exit).
 * - OBJECT_SEALS_PATH: the approach is reachable ignoring object bodies under a
 *   gate state the level can actually reach, but an object that never clears
 *   sits on the only route. This is the permanent half of the pickup-then-block
 *   vs block-then-pickup comparison.
 * - STEP_UNREACHABLE: not reachable even with all objects removed.
 */
function classifyStuck(
  level: LevelDef,
  grid: NavGrid,
  stuck: { id: string; gate?: string; reason: string },
  placements: Placement[],
  keys: KeyPlacement[]
): string {
  if (stuck.gate) return 'KEY_SELF_LOCKED';
  if (/dependencies never become satisfiable/.test(stuck.reason)) return 'ROUTE_STATE';
  const placement = placements.find((p) => p.stepId === stuck.id);
  const key = keys.find((k) => k.keyId === stuck.id);
  const target = placement
    ? worldToIndex(grid, placement.approachPos[0], placement.approachPos[2])
    : key
      ? worldToIndex(grid, key.approachPos[0], key.approachPos[2])
      : -1;
  if (target < 0) return 'STEP_UNREACHABLE';

  // States the level can actually reach when object bodies are ignored. Using
  // "all gates open" as the only probe would blame an object for a stop that is
  // really behind a gate no reachable key state ever opens.
  const reachableMasks = reachableKeyMasks(level, grid);
  for (const mask of reachableMasks) {
    if (floodCells(grid, keyOpenGates(level, mask)).has(target)) return 'OBJECT_SEALS_PATH';
  }
  const allGates = keyOpenGates(level, (1 << level.keys.length) - 1);
  if (floodCells(grid, allGates).has(target)) return 'ROUTE_STATE';
  return 'STEP_UNREACHABLE';
}

/** Key masks reachable from the entry when object bodies are ignored. */
function reachableKeyMasks(level: LevelDef, grid: NavGrid): number[] {
  const gateCells = new Set<number>();
  for (const list of grid.gateCells.values()) for (const i of list) gateCells.add(i);
  const allowedFor = (key: KeyDef, idx: number): boolean => {
    const c = grid.cells[idx];
    if (!c || !c.walkable || !c.zoneId || gateCells.has(idx)) return false;
    const forced = level.config?.forcedKeyZones?.[key.id];
    if (forced && c.zoneId !== forced) return false;
    return findKeyApproach(grid, c, key.radius, gateCells) !== null;
  };
  const seen = new Set<number>();
  const out: number[] = [];
  const queue = [0];
  while (queue.length) {
    const mask = queue.pop()!;
    if (seen.has(mask)) continue;
    seen.add(mask);
    out.push(mask);
    const cells = floodCells(grid, keyOpenGates(level, mask));
    for (let i = 0; i < level.keys.length; i++) {
      if (mask & (1 << i)) continue;
      const key = level.keys[i];
      for (const idx of cells) {
        if (allowedFor(key, idx)) {
          queue.push(mask | (1 << i));
          break;
        }
      }
    }
  }
  return out;
}

function floodCells(grid: NavGrid, openGates: ReadonlySet<string>): Set<number> {
  const closed = closedGateSet(grid, openGates);
  const out = new Set<number>();
  const queue = [grid.entryCell];
  out.add(grid.entryCell);
  while (queue.length) {
    const cur = queue.pop()!;
    const cc = grid.cells[cur];
    if (!cc) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
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

function constraintConflicts(level: LevelDef, placements: Placement[], keys: KeyPlacement[]): Conflict[] {
  const out: Conflict[] = [];
  const byId = new Map<string, Vec3>();
  for (const p of placements) byId.set(p.stepId, p.objectPos);
  for (const k of keys) byId.set(k.keyId, k.pos);
  byId.set('entry', level.entry);
  byId.set('exit', level.exitPoint);
  for (const c of level.constraints) {
    const a = byId.get(c.a);
    const b = byId.get(c.b);
    if (!a || !b) continue;
    const d = dist3(a, b);
    if (c.minDist !== undefined && c.minDist > c.maxDist! && c.maxDist !== undefined) continue;
    if (c.minDist !== undefined && d < c.minDist - 1e-6) {
      out.push({
        code: c.hard ? 'HARD_MIN_DISTANCE' : 'SOFT_MIN_DISTANCE',
        severity: c.hard ? 'hard' : 'soft',
        subjects: [c.a, c.b],
        message: `${c.a} ↔ ${c.b} are ${d.toFixed(2)} m apart; ${c.hard ? 'hard' : 'preference'} minimum is ${c.minDist} m (${c.note}).`,
        suggestion: c.hard ? 'Move one of the objects to satisfy the minimum separation.' : 'Accepted with a soft penalty if geometry allows.',
        at: [a, b],
      });
    }
    if (c.maxDist !== undefined && d > c.maxDist + 1e-6) {
      out.push({
        code: c.hard ? 'HARD_MAX_DISTANCE' : 'SOFT_MAX_DISTANCE',
        severity: c.hard ? 'hard' : 'soft',
        subjects: [c.a, c.b],
        message: `${c.a} ↔ ${c.b} are ${d.toFixed(2)} m apart; ${c.hard ? 'hard' : 'preference'} maximum is ${c.maxDist} m (${c.note}).`,
        suggestion: c.hard ? 'Move one of the objects closer.' : 'Accepted with a soft penalty if geometry allows.',
        at: [a, b],
      });
    }
  }
  return out;
}

function dedupeConflicts(list: Conflict[]): Conflict[] {
  const seen = new Set<string>();
  const out: Conflict[] = [];
  for (const c of list) {
    const key = `${c.code}|${c.subjects.join(',')}|${c.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ------------------------------------------------------------ manual edits

export function locateCell(level: LevelDef, grid: NavGrid, x: number, z: number): { zoneId: string; cell: [number, number] } | null {
  const idx = nearestWalkable(grid, x, z, 2);
  if (idx < 0) return null;
  const c = grid.cells[idx];
  if (!c || !c.zoneId) return null;
  return { zoneId: c.zoneId, cell: [c.cx, c.cz] };
}

/** Explain why a clicked cell cannot host the step, for the editor's conflict panel. */
function manualRejectReason(
  level: LevelDef,
  grid: NavGrid,
  step: QuestStepDef,
  idx: number,
  gateCells: ReadonlySet<number>
): string | null {
  const c = grid.cells[idx];
  if (!c) return 'the click is outside the nav grid';
  if (!c.walkable) return 'the clicked cell is not walkable (prop, wall, or closed threshold)';
  if (c.zoneId === null) return 'the clicked cell is outside every zone';
  if (gateCells.has(idx)) return 'the object cannot sit on a gate threshold';
  const zone = level.zones.find((z) => z.id === c.zoneId);
  if (step.requiredKind && zone?.kind !== step.requiredKind) {
    return `the task hard-requires a “${step.requiredKind}” zone; this is “${zone?.kind ?? 'unknown'}”`;
  }
  const approach = findApproach(level, grid, c, step, gateCells);
  if (!approach) {
    return `no standable cell within the ${step.interaction.radius.toFixed(1)} m interaction radius${
      step.interaction.requiresLineOfSight ? ' with line of sight' : ''
    }`;
  }
  return 'the cell did not enter the candidate space';
}

export interface ManualResult {
  ok: boolean;
  placements: Placement[];
  keys: KeyPlacement[];
  proof: ReturnType<typeof planRoute>['proof'];
  conflicts: Conflict[];
}

/** Re-run reachability for designer-adjusted object positions. */
export function evaluateManual(
  level: LevelDef,
  overrides: Record<string, { x: number; z: number }>,
  base?: { placements?: Placement[]; keys?: KeyPlacement[] }
): ManualResult {
  const grid = buildGrid(level);
  const space = buildCandidateSpace(level, grid);
  const keySpace = buildKeySpace(level, grid);
  const attempt: Attempt = { steps: new Map(), keys: new Map(), softCost: 0, hardViolations: 0, conflicts: [] };
  const manualConflicts: Conflict[] = [];
  const gateCells = new Set<number>();
  for (const list of grid.gateCells.values()) for (const i of list) gateCells.add(i);

  for (const step of level.steps) {
    const ov = overrides[step.id];
    if (ov) {
      const idx = nearestWalkable(grid, ov.x, ov.z, 2);
      const match = idx >= 0 ? (space.byStep.get(step.id) ?? []).find((d) => d.objectIdx === idx) : undefined;
      if (match) {
        attempt.steps.set(step.id, match);
        continue;
      }
      const reason = idx < 0
        ? 'no walkable cell within 2 cells of the click; the point may be inside a prop or outside the level'
        : manualRejectReason(level, grid, step, idx, gateCells);
      manualConflicts.push({
        code: 'MANUAL_CELL_REJECTED',
        severity: 'hard',
        subjects: [step.id, `cell:${idx >= 0 ? grid.cells[idx]!.cx : Math.round(ov.x)},${idx >= 0 ? grid.cells[idx]!.cz : Math.round(ov.z)}`],
        message: `Manual placement for “${step.label}” at (${ov.x.toFixed(1)}, ${ov.z.toFixed(1)}) is not usable: ${reason}. The task keeps its previous spot so the rest of the plan can still be inspected.`,
        suggestion: 'Click a walkable cell inside an allowed zone with an interaction apron; the rejection reason above names the hard constraint that blocked it.',
        at: idx >= 0 ? [cellWorld(grid, idx)] : [[ov.x, 0, ov.z]],
      });
    }
    // Keep the generated placement where possible, else take the top candidate.
    if (base?.placements) {
      const prior = base.placements.find((p) => p.stepId === step.id);
      if (prior) {
        const idx = worldToIndex(grid, prior.objectPos[0], prior.objectPos[2]);
        const match = (space.byStep.get(step.id) ?? []).find((d) => d.objectIdx === idx);
        if (match) {
          attempt.steps.set(step.id, match);
          continue;
        }
      }
    }
    const top = (space.byStep.get(step.id) ?? [])[0];
    if (top) attempt.steps.set(step.id, top);
  }
  for (const key of level.keys) {
    const prior = base?.keys?.find((k) => k.keyId === key.id);
    const list = keySpace.byKey.get(key.id) ?? [];
    if (prior) {
      const idx = worldToIndex(grid, prior.pos[0], prior.pos[2]);
      const match = list.find((d) => worldToIndex(grid, d.pos[0], d.pos[2]) === idx);
      if (match) {
        attempt.keys.set(key.id, match);
        continue;
      }
    }
    const top = list[0];
    if (top) attempt.keys.set(key.id, top);
  }

  // A manual object can land next to another object whose body seals the only
  // standable approach cell. Name that collision explicitly instead of leaving
  // the designer with a generic unreachable-route message.
  const objectOwner = new Map<number, string>();
  const approachOwner = new Map<number, string>();
  for (const [id, cand] of attempt.steps) {
    objectOwner.set(cand.objectIdx, id);
    approachOwner.set(cand.approachIdx, id);
  }
  for (const [id, cand] of attempt.keys) {
    const oi = worldToIndex(grid, cand.pos[0], cand.pos[2]);
    const ai = worldToIndex(grid, cand.approachPos[0], cand.approachPos[2]);
    objectOwner.set(oi, id);
    approachOwner.set(ai, id);
  }
  for (const id of Object.keys(overrides)) {
    if (!overrides[id]) continue;
    const cand = attempt.steps.get(id);
    if (!cand) continue;
    const blockingObject = objectOwner.get(cand.approachIdx);
    const blockingApproach = approachOwner.get(cand.approachIdx);
    const objectOnApproach = blockingObject && blockingObject !== id ? blockingObject : null;
    const approachOnApproach = blockingApproach && blockingApproach !== id ? blockingApproach : null;
    if (objectOnApproach || approachOnApproach) {
      const blocker = objectOnApproach ?? approachOnApproach!;
      const label = level.steps.find((s) => s.id === blocker)?.label ?? level.keys.find((k) => k.id === blocker)?.label ?? blocker;
      const blockerCell = objectOnApproach
        ? ((attempt.steps.get(blocker)?.cell ?? attempt.keys.get(blocker)?.cell))
        : (attempt.steps.get(blocker)?.approach ?? attempt.keys.get(blocker)?.approach);
      manualConflicts.push({
        code: 'MANUAL_APPROACH_BLOCKED',
        severity: 'hard',
        subjects: [id, blocker],
        message: `Manual placement for “${level.steps.find((s) => s.id === id)?.label ?? id}” is reachable in principle, but its only standable approach cell (${cand.approach[0]}, ${cand.approach[1]}) is occupied by ${objectOnApproach ? 'the object' : 'the approach cell'} of “${label}”. The walk-only planner cannot stand there.`,
        suggestion: `Move “${id}” to a cell with a free interaction apron, or move “${blocker}” first. Cells are used by one object and one approach only.`,
        at: [cand.approachPos, blockerCell ? cellWorld(grid, idxOfCell(grid, blockerCell)) : cand.pos],
      });
    }
  }

  const ev = evaluateAttempt(level, grid, attempt, space, keySpace);
  const staticList = [...staticConflicts(level), ...keyGateOrderConflicts(level)];
  const conflicts = dedupeConflicts([
    ...manualConflicts,
    ...staticList,
    ...ev.conflicts,
    ...constraintConflicts(level, ev.placements, ev.keys),
  ]);
  return {
    ok: ev.ok && conflicts.every((c) => c.severity !== 'hard'),
    placements: ev.placements,
    keys: ev.keys,
    proof: ev.proof,
    conflicts,
  };
}
