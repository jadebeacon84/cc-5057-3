// Core data model for quest placement. Framework-free: runs in the browser UI,
// in headless tests, and in the optional CLI.

export type Vec3 = readonly [number, number, number];

export type ZoneKind =
  | 'hub'
  | 'hall'
  | 'shrine'
  | 'cliff'
  | 'vault'
  | 'garden'
  | 'tunnel'
  | 'lab';

export type Rect2 = readonly [number, number, number, number];

export interface ZoneDef {
  id: string;
  name: string;
  kind: ZoneKind;
  /** Footprint [minX,minZ,maxX,maxZ]. Adjacent footprints share walkable ground. */
  rect: Rect2;
  /** Carved holes in the footprint (used to shape L-shaped rooms). */
  cuts?: readonly Rect2[];
  floorY: number;
  /** Single-destination exit chamber. */
  exit?: boolean;
  notes?: string;
}

export type LinkKind = 'door' | 'stairs' | 'ramp' | 'hatch' | 'bridge';

export interface NavLink {
  id: string;
  a: string;
  b: string;
  label: string;
  kind: LinkKind;
  /** Walked centreline in world space. Height changes are real slopes. */
  polyline: Vec3[];
  width: number;
  /** Gate id; closed until a key that unlocks it is held. */
  gate?: string;
}

export interface PropDef {
  id: string;
  kind: 'wall' | 'pillar' | 'rubble' | 'lava' | 'water' | 'beam';
  rect: Rect2;
  height: number;
  /** Wall opening in the middle rather than a solid block. */
  door?: { at: number; width: number };
}

export type InteractionKind =
  | 'pickup'
  | 'talk'
  | 'inspect'
  | 'place'
  | 'switch'
  | 'read'
  | 'chest';

export interface InteractionDef {
  kind: InteractionKind;
  /** Feet must stand within this distance of the object. Hard constraint. */
  radius: number;
  requiresLineOfSight?: boolean;
}

export type StoryRole = 'main' | 'side';

export interface QuestStepDef {
  id: string;
  label: string;
  role: StoryRole;
  /** Soft zone preference by kind (unless requiredKind is set). */
  zoneHint: ZoneKind;
  /** Story sequence; used for ordering preferences and readable proof. */
  seq: number;
  depth: number;
  requires: readonly string[];
  interaction: InteractionDef;
  /** Soft pin to an exact zone id, e.g. a scene designer's wish. */
  preferredZone?: string;
  /** Hard zone-kind requirement. */
  requiredKind?: ZoneKind;
  /** Narrative note shown in the basis panel. */
  rationale?: string;
}

export interface KeyDef {
  id: string;
  label: string;
  /** Gate ids this key opens. */
  unlocks: string[];
  radius: number;
  hideHint?: ZoneKind;
  /** Soft preferred zone id. */
  preferredZone?: string;
  note?: string;
}

export interface ConstraintDef {
  /** Step id, key id, 'entry' or 'exit'. */
  a: string;
  b: string;
  minDist?: number;
  maxDist?: number;
  hard: boolean;
  weight?: number;
  note: string;
}

export interface LevelDef {
  name: string;
  grid: number;
  character: { radius: number; walkSpeed: number; maxStep: number; interactionReach: number };
  zones: ZoneDef[];
  links: NavLink[];
  props: PropDef[];
  keys: KeyDef[];
  steps: QuestStepDef[];
  constraints: ConstraintDef[];
  entry: Vec3;
  exitPoint: Vec3;
  config?: {
    /** Forced key zones, used by the invalid scene to prove reachability checks. */
    forcedKeyZones?: Record<string, string>;
    /** Designer notes about intentional misconfiguration. */
    intendedProblems?: string[];
  };
  notes?: string[];
}

// ---------------------------------------------------------------- placements

export interface ScorePart {
  label: string;
  value: number;
  weight: number;
  note: string;
}

export interface RejectionReason {
  reason: string;
  count: number;
}

export interface Placement {
  stepId: string;
  zoneId: string;
  /** Cell where the object visually sits. */
  objectCell: readonly [number, number];
  objectPos: Vec3;
  /** Cell where the character must stand to interact. */
  approachCell: readonly [number, number];
  approachPos: Vec3;
  /** Distance from approach position to object centre. */
  interactionDistance: number;
  lineOfSight: boolean;
  score: number;
  scoreParts: ScorePart[];
  rejections: RejectionReason[];
  /** Open gates at the moment the step is first reached. */
  reachState: string;
  /** Number of candidate cells examined. */
  candidates: number;
  notes: string[];
}

export interface KeyPlacement {
  keyId: string;
  zoneId: string;
  cell: readonly [number, number];
  pos: Vec3;
  approachCell: readonly [number, number];
  approachPos: Vec3;
  gates: string[];
  /** Explanation of why this hiding spot survives the reachability-state test. */
  reachStateNote: string;
  distanceToExit: number;
  candidates: number;
  rejections: RejectionReason[];
  notes: string[];
}

// -------------------------------------------------------------------- route

export type StopKind = 'step' | 'key' | 'exit';

export interface RouteStop {
  order: number;
  kind: StopKind;
  id: string;
  label: string;
  role: 'main' | 'side' | 'key' | 'exit';
  /** Object position (marker). */
  pos: Vec3;
  /** Character position when the stop is completed. */
  standPos: Vec3;
  zoneId: string;
  /** Open gates at arrival. */
  reachState: string;
}

export interface RouteLeg {
  from: Vec3;
  to: Vec3;
  points: Vec3[];
  distance: number;
  /** Gates opened by key pickups detected along this leg. */
  openedGates: string[];
}

export interface RoutePlan {
  stops: RouteStop[];
  legs: RouteLeg[];
  totalDistance: number;
  /** Walkable-only plan. There is deliberately no teleport variant. */
  mode: 'walk';
}

export type ProofStatus =
  | 'ok'
  | 'unreachable'
  | 'blocked-gate'
  | 'order-violation'
  | 'interaction-fail';

export interface ProofEntry {
  order: number;
  id: string;
  kind: StopKind;
  status: ProofStatus;
  label: string;
  why: string;
  standPos: Vec3;
  reachState: string;
  interactionDistance?: number;
  lineOfSight?: boolean;
}

export interface RunProof {
  ok: boolean;
  mode: 'walk';
  entries: ProofEntry[];
  route: RoutePlan;
  visitedSteps: string[];
  collectedKeys: string[];
  openedGates: string[];
  issues: string[];
}

export interface Conflict {
  code: string;
  severity: 'hard' | 'soft' | 'warn';
  subjects: string[];
  message: string;
  suggestion: string;
  /** Optional cells/positions to highlight in the viewport. */
  at?: Vec3[];
}

export interface SeedSummary {
  seed: number;
  ok: boolean;
  softCost: number;
  hardViolations: number;
  routeLength: number;
  placementSignature: string;
  note: string;
}

export interface Metrics {
  softCost: number;
  hardViolations: number;
  routeLength: number;
  searchMs: number;
  attempts: number;
  candidatesExamined: number;
}

export interface PlacementResult {
  ok: boolean;
  level: LevelDef;
  placements: Placement[];
  keys: KeyPlacement[];
  proof: RunProof;
  conflicts: Conflict[];
  metrics: Metrics;
  seeds: SeedSummary[];
  /** Static checks that do not depend on placement. */
  staticConflicts: Conflict[];
}

export interface ManualMoveResult {
  ok: boolean;
  placement?: Placement;
  conflicts: Conflict[];
  proof?: RunProof;
}
