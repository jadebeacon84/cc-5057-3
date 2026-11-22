import type { Conflict, LevelDef, QuestStepDef } from './types.ts';

export function stepMap(level: LevelDef): Map<string, QuestStepDef> {
  return new Map(level.steps.map((s) => [s.id, s]));
}

export function keyMap(level: LevelDef): Map<string, LevelDef['keys'][number]> {
  return new Map(level.keys.map((k) => [k.id, k]));
}

export function allGateIds(level: LevelDef): Set<string> {
  const set = new Set<string>();
  for (const l of level.links) if (l.gate) set.add(l.gate);
  return set;
}

/** Tarjan SCC; returns groups with more than one node or self-loops. */
export function findCycles(steps: QuestStepDef[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const s of steps) adj.set(s.id, [...s.requires]);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  const strong = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!adj.has(w)) continue;
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp.reverse());
      else {
        const only = comp[0];
        if ((adj.get(only) ?? []).includes(only)) out.push(comp);
      }
    }
  };

  for (const s of steps) if (!index.has(s.id)) strong(s.id);
  return out;
}

/** Topological order over requires; returns null on cycle. */
export function topoOrder(steps: QuestStepDef[]): string[] | null {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    indeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const s of steps) {
    for (const r of s.requires) {
      if (!ids.has(r)) continue;
      adj.get(r)!.push(s.id);
      indeg.set(s.id, indeg.get(s.id)! + 1);
    }
  }
  const queue = steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  queue.sort((a, b) => (steps.find((s) => s.id === a)!.seq ?? 0) - (steps.find((s) => s.id === b)!.seq ?? 0));
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const n of adj.get(id)!) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  return out.length === steps.length ? out : null;
}

export function staticConflicts(level: LevelDef): Conflict[] {
  const conflicts: Conflict[] = [];
  const stepIds = new Set<string>();
  const keyIds = new Set<string>();
  const zoneIds = new Set(level.zones.map((z) => z.id));
  const zoneKinds = new Set(level.zones.map((z) => z.kind));
  const gates = allGateIds(level);

  for (const s of level.steps) {
    if (stepIds.has(s.id)) {
      conflicts.push({
        code: 'DUP_ID',
        severity: 'hard',
        subjects: [s.id],
        message: `Duplicate step id “${s.id}”.`,
        suggestion: 'Rename one of the steps so dependencies are unambiguous.',
      });
    }
    stepIds.add(s.id);
    if (s.requiredKind && !zoneKinds.has(s.requiredKind)) {
      conflicts.push({
        code: 'EMPTY_ZONE_KIND',
        severity: 'hard',
        subjects: [s.id],
        message: `Step “${s.label}” requires a ${s.requiredKind} zone, but the scene has none.`,
        suggestion: 'Add a zone of that kind or remove the hard zone requirement.',
      });
    }
    if (s.preferredZone && !zoneIds.has(s.preferredZone)) {
      conflicts.push({
        code: 'UNKNOWN_PREFERRED_ZONE',
        severity: 'warn',
        subjects: [s.id, s.preferredZone],
        message: `Step “${s.id}” prefers unknown zone “${s.preferredZone}”.`,
        suggestion: 'Pick one of the bundled zone ids or drop the preference.',
      });
    }
  }

  for (const k of level.keys) {
    if (keyIds.has(k.id)) {
      conflicts.push({
        code: 'DUP_ID',
        severity: 'hard',
        subjects: [k.id],
        message: `Duplicate key id “${k.id}”.`,
        suggestion: 'Rename one of the keys.',
      });
    }
    keyIds.add(k.id);
    for (const g of k.unlocks) {
      if (!gates.has(g)) {
        conflicts.push({
          code: 'UNKNOWN_GATE_KEY',
          severity: 'hard',
          subjects: [k.id, g],
          message: `Key “${k.label}” unlocks gate “${g}”, but no link defines it.`,
          suggestion: 'Fix the key’s unlocks list or add the gate to a link.',
        });
      }
    }
    if (k.preferredZone && !zoneIds.has(k.preferredZone)) {
      conflicts.push({
        code: 'UNKNOWN_KEY_ZONE',
        severity: 'warn',
        subjects: [k.id, k.preferredZone],
        message: `Key “${k.id}” prefers unknown zone “${k.preferredZone}”.`,
        suggestion: 'Pick a real zone id or let the solver choose.',
      });
    }
  }

  for (const s of level.steps) {
    for (const r of s.requires) {
      if (!stepIds.has(r)) {
        conflicts.push({
          code: 'UNKNOWN_REQUIRE',
          severity: 'hard',
          subjects: [s.id, r],
          message: `Step “${s.id}” requires “${r}”, which does not exist.`,
          suggestion: 'Correct the requires list.',
        });
      }
    }
  }

  for (const cycle of findCycles(level.steps)) {
    conflicts.push({
      code: 'DEPENDENCY_CYCLE',
      severity: 'hard',
      subjects: cycle,
      message: `Dependency cycle: ${cycle.join(' → ')} → ${cycle[0]}. A table can look “connected” but no step can start.`,
      suggestion: 'Break the cycle by removing one requires edge. The checker will not silently drop a branch.',
    });
  }

  for (const c of level.constraints) {
    const bad = [c.a, c.b].filter((id) => !isKnownSubject(level, id));
    if (bad.length) {
      conflicts.push({
        code: 'UNKNOWN_CONSTRAINT_SUBJECT',
        severity: 'hard',
        subjects: [c.a, c.b],
        message: `Distance constraint references unknown subject(s): ${bad.join(', ')}.`,
        suggestion: 'Use a step id, key id, “entry” or “exit”.',
      });
      continue;
    }
    if (c.a === c.b) {
      conflicts.push({
        code: 'SELF_CONSTRAINT',
        severity: 'hard',
        subjects: [c.a],
        message: `Distance constraint “${c.note}” compares ${c.a} with itself.`,
        suggestion: 'Remove the constraint or point it at another subject.',
      });
    }
    if (
      (c.minDist !== undefined && c.minDist < 0) ||
      (c.maxDist !== undefined && c.maxDist < 0)
    ) {
      conflicts.push({
        code: 'NEGATIVE_DISTANCE',
        severity: 'hard',
        subjects: [c.a, c.b],
        message: `Distance constraint “${c.note}” has a negative bound.`,
        suggestion: 'Use non-negative distances.',
      });
    }
    if (c.minDist !== undefined && c.maxDist !== undefined && c.minDist > c.maxDist) {
      conflicts.push({
        code: 'IMPOSSIBLE_DISTANCE_WINDOW',
        severity: 'hard',
        subjects: [c.a, c.b],
        message: `Distance window for “${c.note}” is empty: min ${c.minDist} > max ${c.maxDist}.`,
        suggestion: `Lower the minimum to ≤ ${c.maxDist} or raise the maximum to ≥ ${c.minDist}.`,
      });
    }
  }

  for (const link of level.links) {
    if (!link.gate) continue;
    const unlockedBy = level.keys.filter((k) => k.unlocks.includes(link.gate!));
    if (unlockedBy.length === 0) {
      conflicts.push({
        code: 'GATE_UNLOCKABLE',
        severity: 'hard',
        subjects: [link.gate, link.id],
        message: `Gate “${link.gate}” on ${link.label} has no key that unlocks it.`,
        suggestion: 'Add a key with this gate in its unlocks list, or remove the gate.',
      });
    }
    const zoneA = level.zones.find((z) => z.id === link.a);
    const zoneB = level.zones.find((z) => z.id === link.b);
    if (!zoneA || !zoneB) {
      conflicts.push({
        code: 'LINK_UNKNOWN_ZONE',
        severity: 'hard',
        subjects: [link.id, link.a, link.b],
        message: `Link “${link.label}” connects unknown zone(s).`,
        suggestion: 'Fix the link endpoints.',
      });
    }
  }

  for (const s of level.steps) {
    for (const r of s.requires) {
      const req = level.steps.find((x) => x.id === r);
      if (req && req.seq > s.seq) {
        conflicts.push({
          code: 'STORY_ORDER',
          severity: 'warn',
          subjects: [s.id, r],
          message: `“${s.id}” requires “${r}” but its story seq (${s.seq}) is earlier than the required step (${req.seq}).`,
          suggestion: 'Story order is a preference; the dependency still binds. Adjust seq if the narrative should match.',
        });
      }
    }
  }

  const exits = level.zones.filter((z) => z.exit);
  if (exits.length === 0) {
    conflicts.push({
      code: 'NO_EXIT',
      severity: 'hard',
      subjects: [],
      message: 'The scene has no exit zone; the completion proof would never terminate.',
      suggestion: 'Mark exactly one zone as the single-destination exit.',
    });
  } else if (exits.length > 1) {
    conflicts.push({
      code: 'MULTI_EXIT',
      severity: 'warn',
      subjects: exits.map((z) => z.id),
      message: `Multiple exit zones (${exits.map((z) => z.id).join(', ')}). The runner treats the first as terminal.`,
      suggestion: 'Make the exit single-destination to keep the proof well-defined.',
    });
  }

  if (!level.zones.some((z) => pointInLevel(level, level.entry))) {
    conflicts.push({
      code: 'ENTRY_OUTSIDE',
      severity: 'hard',
      subjects: ['entry'],
      message: 'The entry point is not on any zone floor.',
      suggestion: 'Move the entry into a walkable zone.',
    });
  }

  return conflicts;
}

function pointInLevel(level: LevelDef, p: readonly [number, number, number]): boolean {
  return level.zones.some(
    (z) => p[0] >= z.rect[0] && p[0] <= z.rect[2] && p[2] >= z.rect[1] && p[2] <= z.rect[3]
  );
}

export function isKnownSubject(level: LevelDef, id: string): boolean {
  return (
    id === 'entry' ||
    id === 'exit' ||
    level.steps.some((s) => s.id === id) ||
    level.keys.some((k) => k.id === id)
  );
}

/** Checks only reachability of each gate in the dependency story (ignoring placement). */
export function keyGateOrderConflicts(level: LevelDef): Conflict[] {
  // If every key sits in the same zone as the gate it opens and that zone is only
  // reachable through the gate, the level is self-locked. This static approximation
  // catches obvious forced configs; the solver runs the exact state search.
  const out: Conflict[] = [];
  const exitZones = new Set(level.zones.filter((z) => z.exit).map((z) => z.id));
  for (const key of level.keys) {
    if (key.preferredZone && exitZones.has(key.preferredZone)) {
      out.push({
        code: 'KEY_BEHIND_GATE',
        severity: 'hard',
        subjects: [key.id, key.preferredZone],
        message: `Key “${key.label}” is pinned inside the one-way exit zone “${key.preferredZone}”, which can only be entered after its own gate opens.`,
        suggestion: 'Move the key to a zone reachable before the gate it unlocks (plaza, gallery, garden, tunnel).',
      });
    }
  }
  return out;
}
