import type { LevelDef, NavLink, PropDef, ZoneDef, Vec3 } from './types.ts';

// Bundled scene: a multi-tier reach with three parallel branches. Zones are
// separated by real gaps; every connection is an explicit link. That makes
// gates meaningful (no walking around a gate along a shared border) and makes
// stairs/ramps the only height transitions.

const zones: ZoneDef[] = [
  {
    id: 'plaza',
    name: 'Entry Plaza',
    kind: 'hub',
    rect: [-5, -5, 5, 5],
    floorY: 0,
    notes: 'Flat arrival terrace. The only entry point for the character.',
  },
  {
    id: 'gallery',
    name: 'Hall of Echoes',
    kind: 'hall',
    rect: [-19, -5, -7, 5],
    floorY: 0,
    notes: 'Long hall west of the plaza. Ledger shelf sits against the north wall.',
  },
  {
    id: 'shrine',
    name: 'Sunken Shrine',
    kind: 'shrine',
    rect: [-19, -19, -7, -11],
    floorY: -1.2,
    notes: 'Lower tier; the sunken stair from the gallery is the only way down.',
  },
  {
    id: 'garden',
    name: 'Amber Garden',
    kind: 'garden',
    rect: [7, -5, 21, 5],
    floorY: 0,
    notes: 'Open terraces east of the plaza, split by hedge rows.',
  },
  {
    id: 'tunnel',
    name: 'Service Tunnel',
    kind: 'tunnel',
    rect: [7, 7, 19, 12],
    floorY: 0,
    notes: 'Narrow service corridor behind the garden, sealed by a vine-locked hatch.',
  },
  {
    id: 'cliff',
    name: 'Wind Cliff',
    kind: 'cliff',
    rect: [7, -21, 21, -11],
    floorY: 2.4,
    notes: 'Upper tier ledge; stair from the garden, keyed ramp down to the vault.',
  },
  {
    id: 'vault',
    name: 'Deep Vault',
    kind: 'vault',
    rect: [7, -33, 21, -27],
    floorY: -1.2,
    exit: true,
    notes: 'Exit chamber. The vault grate is one-way: arriving ends the level.',
  },
];

const links: NavLink[] = [
  {
    id: 'arch-west',
    a: 'plaza',
    b: 'gallery',
    label: 'West arch',
    kind: 'door',
    polyline: [
      [-5, 0, 0],
      [-7, 0, 0],
    ],
    width: 3,
  },
  {
    id: 'arch-east',
    a: 'plaza',
    b: 'garden',
    label: 'East arch',
    kind: 'door',
    polyline: [
      [5, 0, 0],
      [7, 0, 0],
    ],
    width: 3,
  },
  {
    id: 'gallery-stair',
    a: 'gallery',
    b: 'shrine',
    label: 'Sunken stair',
    kind: 'stairs',
    polyline: [
      [-13, 0, -5],
      [-13, -1.2, -11],
    ],
    width: 3,
  },
  {
    id: 'garden-stair',
    a: 'garden',
    b: 'cliff',
    label: 'Windward stair',
    kind: 'stairs',
    polyline: [
      [13, 0, -5],
      [13, 2.4, -11],
    ],
    width: 3,
  },
  {
    id: 'vault-ramp',
    a: 'cliff',
    b: 'vault',
    label: 'Vault ramp (keyed)',
    kind: 'ramp',
    polyline: [
      [13, 2.4, -21],
      [13, -1.2, -27],
    ],
    width: 3,
    gate: 'vault-gate',
  },
  {
    id: 'tunnel-hatch',
    a: 'garden',
    b: 'tunnel',
    label: 'Service hatch (vine-locked)',
    kind: 'hatch',
    polyline: [
      [12, 0, 5],
      [12, 0, 7],
    ],
    width: 2,
    gate: 'tunnel-gate',
  },
];

const props: PropDef[] = [
  { id: 'hedge-a', kind: 'wall', rect: [10, -2, 18, -1], height: 1.2 },
  { id: 'hedge-b', kind: 'wall', rect: [10, 2, 18, 3], height: 1.2 },
  { id: 'pillar-a', kind: 'pillar', rect: [-15, 1, -14, 2], height: 3 },
  { id: 'pillar-b', kind: 'pillar', rect: [-11, -2, -10, -1], height: 3 },
  { id: 'shrine-pillar', kind: 'pillar', rect: [-14, -16, -13, -15], height: 2.4 },
  { id: 'cliff-cairn', kind: 'rubble', rect: [18, -16, 19, -15], height: 1.1 },
  { id: 'tunnel-rubble', kind: 'rubble', rect: [15, 9, 16, 10], height: 1.1 },
  { id: 'vault-seal-wall', kind: 'wall', rect: [17, -31, 18, -28], height: 2.6, door: { at: 0.5, width: 0.4 } },
  { id: 'garden-beam', kind: 'beam', rect: [18, -4, 21, -3], height: 0.4 },
];

export const EXIT_POINT: Vec3 = [14, -1.2, -31];

export const DEMO_LEVEL: LevelDef = {
  name: 'Amber Reach — relic escort, three branches',
  grid: 1,
  character: { radius: 0.4, walkSpeed: 4, maxStep: 0.8, interactionReach: 0.9 },
  zones,
  links,
  props,
  keys: [
    {
      id: 'sun-key',
      label: 'Sun Key',
      unlocks: ['vault-gate'],
      radius: 1.3,
      hideHint: 'tunnel',
      note: 'Opens the vault ramp gate. Must be collected before the ramp.',
    },
    {
      id: 'vine-key',
      label: 'Vine Key',
      unlocks: ['tunnel-gate'],
      radius: 1.3,
      hideHint: 'garden',
      preferredZone: 'garden',
      note: 'Opens the service hatch. The tunnel also holds the sun key, so the hatch must open first.',
    },
  ],
  steps: [
    {
      id: 'greet',
      label: 'Speak with the porter at the arrival arch',
      role: 'main',
      zoneHint: 'hub',
      seq: 0,
      depth: 0,
      requires: [],
      interaction: { kind: 'talk', radius: 2.4, requiresLineOfSight: true },
      rationale: 'The porter starts the main chain and is the only NPC at the entry terrace.',
    },
    {
      id: 'ledger',
      label: 'Read the ledger in the Hall of Echoes',
      role: 'main',
      zoneHint: 'hall',
      seq: 1,
      depth: 1,
      requires: ['greet'],
      interaction: { kind: 'read', radius: 1.8 },
      rationale: 'The ledger unlocks all three branches and must be a real trip from the porter.',
    },
    {
      id: 'bell',
      label: 'Inspect the shrine bell',
      role: 'main',
      zoneHint: 'shrine',
      seq: 2,
      depth: 2,
      requires: ['ledger'],
      interaction: { kind: 'inspect', radius: 2.0, requiresLineOfSight: true },
      rationale: 'Main-chain resonance clue, physically separated in the sunken shrine.',
    },
    {
      id: 'sun-shard',
      label: 'Recover the sun shard from the cliff',
      role: 'side',
      zoneHint: 'cliff',
      seq: 3,
      depth: 2,
      requires: ['ledger'],
      interaction: { kind: 'pickup', radius: 1.3, requiresLineOfSight: true },
      rationale: 'Side branch A. Its reward gates the vault seal, so the branch cannot be dropped.',
    },
    {
      id: 'hermit',
      label: 'Convince the hermit at the garden edge',
      role: 'side',
      zoneHint: 'garden',
      seq: 4,
      depth: 2,
      requires: ['ledger'],
      interaction: { kind: 'talk', radius: 2.2 },
      rationale: 'Side branch B start. Refuses to talk if the sun shard is within sight range.',
    },
    {
      id: 'herb',
      label: 'Gather moon-herb beside the hermit',
      role: 'side',
      zoneHint: 'garden',
      seq: 5,
      depth: 3,
      requires: ['hermit'],
      interaction: { kind: 'pickup', radius: 1.2 },
      rationale: 'Side branch B payoff. Must be close to the hermit and after the conversation.',
    },
    {
      id: 'cache',
      label: 'Open the service cache in the tunnel',
      role: 'side',
      zoneHint: 'tunnel',
      seq: 6,
      depth: 2,
      requires: ['ledger'],
      interaction: { kind: 'chest', radius: 1.6 },
      rationale: 'Side branch C. Reaching it needs the vine key, but the cache is a separate stop.',
    },
    {
      id: 'seal',
      label: 'Place the sun shard on the vault seal',
      role: 'main',
      zoneHint: 'vault',
      seq: 7,
      depth: 4,
      requires: ['bell', 'sun-shard'],
      interaction: { kind: 'place', radius: 2.0, requiresLineOfSight: true },
      rationale: 'Main chain gate: needs both branch A and the shrine clue, then opens the vault.',
    },
    {
      id: 'escape',
      label: 'Take the one-way vault grate',
      role: 'main',
      zoneHint: 'vault',
      seq: 8,
      depth: 5,
      requires: ['seal'],
      interaction: { kind: 'switch', radius: 2.0 },
      rationale: 'Single-destination exit. Reaching the grate ends the level; there is no return path.',
    },
  ],
  constraints: [
    {
      a: 'greet',
      b: 'ledger',
      minDist: 7,
      hard: true,
      note: 'The porter sends the player across the arch; ledger cannot be in earshot.',
    },
    {
      a: 'sun-shard',
      b: 'hermit',
      minDist: 5,
      hard: true,
      note: 'Hermit will not speak while the shard is within sight range.',
    },
    {
      a: 'hermit',
      b: 'herb',
      maxDist: 4,
      hard: false,
      weight: 3,
      note: 'Moon-herb should grow within the hermit’s view.',
    },
    {
      a: 'cache',
      b: 'sun-key',
      maxDist: 6,
      hard: false,
      weight: 2,
      note: 'The sun key should be found while searching the service cache.',
    },
    {
      a: 'seal',
      b: 'exit',
      maxDist: 4,
      hard: true,
      note: 'The seal is the vault door mechanism; it must sit inside the exit chamber.',
    },
    {
      a: 'greet',
      b: 'entry',
      maxDist: 7,
      hard: true,
      note: 'The porter should be visible from the arrival point.',
    },
  ],
  entry: [0, 0, 3.5],
  exitPoint: EXIT_POINT,
  notes: [
    'All movement is walkable: no flight, no teleport. The ramp from the cliff to the vault is the only route into the exit chamber.',
    'The sun key is hidden in the tunnel, behind the vine-locked hatch. The vine key must therefore be found first.',
    'Zone borders are gaps; gates cannot be bypassed by walking around them.',
  ],
};

// ------------------------------------------------------------ invalid scene

function cloneLevel(level: LevelDef): LevelDef {
  return JSON.parse(JSON.stringify(level)) as LevelDef;
}

export function makeInvalidLevel(): LevelDef {
  const bad = cloneLevel(DEMO_LEVEL);
  bad.name = 'Amber Reach — deliberately invalid config';
  bad.notes = [
    'This scene is intentionally unsolvable. Each seeded fault must be named by the checker.',
    'Fault 1: hermit/herb require each other (dependency cycle).',
    'Fault 2: the seal is hard-pinned to the Hall kind, but a hard constraint requires it within 4 m of the vault exit — no cell satisfies both.',
    'Fault 3: a distance window demands bell/seal both at least 6 and at most 3 apart.',
    'Fault 4: the sun key is forced into the vault, behind the gate it opens.',
  ];
  bad.steps = bad.steps.map((s) => {
    if (s.id === 'hermit') return { ...s, requires: ['herb'] };
    if (s.id === 'herb') return { ...s, requires: ['hermit'] };
    if (s.id === 'seal') return { ...s, requiredKind: 'hall', preferredZone: 'gallery' };
    return s;
  });
  bad.keys = bad.keys.map((k) =>
    k.id === 'sun-key' ? { ...k, preferredZone: undefined, hideHint: 'vault' } : k
  );
  bad.constraints = [
    ...bad.constraints.filter((c) => !(c.a === 'bell' && c.b === 'seal')),
    {
      a: 'bell',
      b: 'seal',
      minDist: 6,
      maxDist: 3,
      hard: true,
      note: 'Impossible distance window (min > max).',
    },
  ];
  bad.config = {
    forcedKeyZones: { 'sun-key': 'vault' },
    intendedProblems: ['CYCLE', 'FORCED_ZONE', 'IMPOSSIBLE_WINDOW', 'KEY_BEHIND_GATE'],
  };
  return bad;
}

export function zoneById(level: LevelDef, id: string): ZoneDef | undefined {
  return level.zones.find((z) => z.id === id);
}

export function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    hub: 'Hub',
    hall: 'Hall',
    shrine: 'Shrine',
    cliff: 'Cliff',
    vault: 'Vault',
    garden: 'Garden',
    tunnel: 'Tunnel',
    lab: 'Lab',
  };
  return map[kind] ?? kind;
}
