import type {
  LevelDef,
  ZoneDef,
  PropDef,
  NavLink,
  Vec3,
  Rect2,
} from './types.ts';

export interface NavCellData {
  cx: number;
  cz: number;
  x: number;
  z: number;
  y: number;
  zoneId: string | null;
  linkId: string | null;
  walkable: boolean;
  /** Closed until the associated gate opens. */
  gate: string | null;
  /** Blocks line of sight (tall props / walls). */
  losBlocked: boolean;
}

export type NavCell = NavCellData;
export type { Rect2 };

export interface NavGrid {
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  cellSize: number;
  cells: (NavCellData | null)[];
  entryCell: number;
  maxStep: number;
  /** Cells that belong to each gate, used to block movement. */
  gateCells: Map<string, number[]>;
  /** All cells with their zone attribution changed by link carving, for debugging. */
  links: NavLink[];
}

export function cellIndex(grid: NavGrid, cx: number, cz: number): number {
  return cz * grid.cols + cx;
}

export function cellAt(grid: NavGrid, cx: number, cz: number): NavCellData | null {
  if (cx < 0 || cz < 0 || cx >= grid.cols || cz >= grid.rows) return null;
  return grid.cells[cz * grid.cols + cx] ?? null;
}

export function cellWorld(grid: NavGrid, idx: number): Vec3 {
  const c = grid.cells[idx];
  return c ? [c.x, c.y, c.z] : [0, 0, 0];
}

function inRect(x: number, z: number, r: Rect2): boolean {
  return x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];
}

export function propSolids(prop: PropDef): Rect2[] {
  if (!prop.door) return [prop.rect];
  const [x0, z0, x1, z1] = prop.rect;
  const horizontal = x1 - x0 >= z1 - z0;
  if (horizontal) {
    const mid = x0 + (x1 - x0) * prop.door.at;
    const half = (x1 - x0) * prop.door.width * 0.5;
    return [
      [x0, z0, mid - half, z1],
      [mid + half, z0, x1, z1],
    ];
  }
  const mid = z0 + (z1 - z0) * prop.door.at;
  const half = (z1 - z0) * prop.door.width * 0.5;
  return [
    [x0, z0, x1, mid - half],
    [x0, mid + half, x1, z1],
  ];
}

export function expandRect(r: Rect2, by: number): Rect2 {
  return [r[0] - by, r[1] - by, r[2] + by, r[3] + by];
}

function distancePointSegment2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

export function polylineLength(poly: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    total += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1], poly[i][2] - poly[i - 1][2]);
  }
  return total;
}

function pointOnPolyline(poly: Vec3[], t: number): Vec3 {
  if (poly.length === 0) return [0, 0, 0];
  if (poly.length === 1) return poly[0];
  const total = polylineLength(poly);
  let want = t * total;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (want <= d || i === poly.length - 2) {
      const f = d === 0 ? 0 : Math.min(1, want / d);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    want -= d;
  }
  return poly[poly.length - 1];
}

/**
 * Arc-length position of the closest point on a polyline. Used to place a gate
 * band across the full corridor width regardless of the link's orientation.
 */
export function polylineArcPosition(poly: Vec3[], p: Vec3): { arc: number; distance: number; total: number } {
  if (poly.length === 0) return { arc: 0, distance: Infinity, total: 0 };
  if (poly.length === 1) {
    return { arc: 0, distance: Math.hypot(p[0] - poly[0][0], p[1] - poly[0][1], p[2] - poly[0][2]), total: 0 };
  }
  let bestArc = 0;
  let bestDist = Infinity;
  let walked = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const segLen = Math.hypot(dx, dy, dz);
    const len2 = segLen * segLen;
    let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = a[0] + dx * t;
    const qy = a[1] + dy * t;
    const qz = a[2] + dz * t;
    const d = Math.hypot(p[0] - qx, p[1] - qy, p[2] - qz);
    if (d < bestDist) {
      bestDist = d;
      bestArc = walked + segLen * t;
    }
    walked += segLen;
  }
  return { arc: bestArc, distance: bestDist, total: walked };
}

export function nearestPointOnPolyline(poly: Vec3[], p: Vec3): { point: Vec3; distance: number } {
  let best = poly[0] ?? [0, 0, 0];
  let bestD = Infinity;
  if (poly.length === 1) {
    const d = Math.hypot(p[0] - poly[0][0], p[1] - poly[0][1], p[2] - poly[0][2]);
    return { point: poly[0], distance: d };
  }
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len2 = dx * dx + dy * dy + dz * dz;
    let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const q: Vec3 = [a[0] + dx * t, a[1] + dy * t, a[2] + dz * t];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return { point: best, distance: bestD };
}

/**
 * Build a height-aware walkable grid from zone floors, props and links.
 * Cells are 1-unit; ramps carry their true slope so a "fly to the target"
 * shortcut is never valid: movement is 4-neighbour and limited by maxStep.
 */
export function buildGrid(level: LevelDef): NavGrid {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const z of level.zones) {
    minX = Math.min(minX, z.rect[0]);
    minZ = Math.min(minZ, z.rect[1]);
    maxX = Math.max(maxX, z.rect[2]);
    maxZ = Math.max(maxZ, z.rect[3]);
  }
  const cs = level.grid;
  const pad = 3;
  minX = Math.floor(minX - pad);
  minZ = Math.floor(minZ - pad);
  maxX = Math.ceil(maxX + pad);
  maxZ = Math.ceil(maxZ + pad);
  const cols = Math.max(1, Math.round((maxX - minX) / cs));
  const rows = Math.max(1, Math.round((maxZ - minZ) / cs));
  const cells: (NavCellData | null)[] = new Array(cols * rows).fill(null);

  const get = (cx: number, cz: number): NavCellData => {
    const i = cz * cols + cx;
    let c = cells[i];
    if (!c) {
      c = {
        cx,
        cz,
        x: minX + (cx + 0.5) * cs,
        z: minZ + (cz + 0.5) * cs,
        y: 0,
        zoneId: null,
        linkId: null,
        walkable: false,
        gate: null,
        losBlocked: false,
      };
      cells[i] = c;
    }
    return c;
  };

  // Floors.
  for (const zone of level.zones) {
    const [x0, z0, x1, z1] = zone.rect;
    const cx0 = Math.max(0, Math.floor((x0 - minX) / cs));
    const cx1 = Math.min(cols - 1, Math.ceil((x1 - minX) / cs) - 1);
    const cz0 = Math.max(0, Math.floor((z0 - minZ) / cs));
    const cz1 = Math.min(rows - 1, Math.ceil((z1 - minZ) / cs) - 1);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = get(cx, cz);
        const inside = inRect(c.x, c.z, zone.rect);
        const cut = zone.cuts?.some((r) => inRect(c.x, c.z, r)) ?? false;
        if (!inside || cut) continue;
        // Don't overwrite a lower floor with a higher zone; overlapped zones are
        // separated by props/links in practice.
        if (!c.walkable) {
          c.walkable = true;
          c.zoneId = zone.id;
          c.y = zone.floorY;
        } else if (Math.abs(c.y - zone.floorY) > 0.05) {
          // Two floors at different heights overlapping is a geometry conflict;
          // leave the first zone owning the cell.
        }
      }
    }
  }

  // Props: solid footprint + character radius erosion for movement, raw for LOS.
  const r = level.character.radius;
  for (const prop of level.props) {
    if (prop.kind === 'beam' || prop.kind === 'water') continue;
    for (const rect of propSolids(prop)) {
      const er = expandRect(rect, r);
      const cx0 = Math.max(0, Math.floor((er[0] - minX) / cs));
      const cx1 = Math.min(cols - 1, Math.ceil((er[2] - minX) / cs));
      const cz0 = Math.max(0, Math.floor((er[1] - minZ) / cs));
      const cz1 = Math.min(rows - 1, Math.ceil((er[3] - minZ) / cs));
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = get(cx, cz);
          if (inRect(c.x, c.z, er)) c.walkable = false;
        }
      }
      if (prop.height >= 1.0) {
        const cx2 = Math.max(0, Math.floor((rect[0] - minX) / cs));
        const cx3 = Math.min(cols - 1, Math.ceil((rect[2] - minX) / cs));
        const cz2 = Math.max(0, Math.floor((rect[1] - minZ) / cs));
        const cz3 = Math.min(rows - 1, Math.ceil((rect[3] - minZ) / cs));
        for (let cz = cz2; cz <= cz3; cz++) {
          for (let cx = cx2; cx <= cx3; cx++) {
            const c = get(cx, cz);
            if (inRect(c.x, c.z, rect)) c.losBlocked = true;
          }
        }
      }
    }
  }

  // Links: carve real sloped cells. Do it after floors/props so a stair can
  // punch through a wall footprint.
  for (const link of level.links) {
    carveLink(cells, minX, minZ, cols, rows, cs, link, get);
  }

  // Gate cells: block the doorway while closed. The band is centred on the
  // midpoint of the link and spans the link's full width, measured in the
  // link's own frame (arc along the polyline, lateral offset from it). A fixed
  // x/z window would only seal z-running links and let wide or x-running
  // corridors be skirted around the gate.
  const gateCells = new Map<string, number[]>();
  for (const link of level.links) {
    if (!link.gate) continue;
    const total = polylineLength(link.polyline);
    const halfBand = Math.max(cs * 0.9, link.width * 0.25);
    const lateralReach = link.width / 2 + cs * 0.6;
    const list: number[] = [];
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        const c = cells[cz * cols + cx];
        if (!c || !c.walkable) continue;
        const hit = polylineArcPosition(link.polyline, [c.x, c.y, c.z]);
        if (Math.abs(hit.arc - total * 0.5) > halfBand) continue;
        if (hit.distance > lateralReach) continue;
        c.gate = link.gate;
        list.push(cz * cols + cx);
      }
    }
    gateCells.set(link.gate, list);
  }

  // Entry cell.
  const ecx = Math.floor((level.entry[0] - minX) / cs);
  const ecz = Math.floor((level.entry[2] - minZ) / cs);
  const entryCell = czIndex(cols, rows, ecx, ecz);
  const stdEntry = entryCell >= 0 && cells[entryCell]?.walkable ? entryCell : findNearestWalkable(cells, cols, rows, ecx, ecz, 5);

  return {
    minX,
    minZ,
    cols,
    rows,
    cellSize: cs,
    cells,
    entryCell: stdEntry,
    maxStep: level.character.maxStep,
    gateCells,
    links: level.links,
  };
}

function czIndex(cols: number, rows: number, cx: number, cz: number) {
  if (cx < 0 || cz < 0 || cx >= cols || cz >= rows) return -1;
  return cz * cols + cx;
}

function findNearestWalkable(cells: (NavCellData | null)[], cols: number, rows: number, cx: number, cz: number, maxR: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r <= maxR; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const i = czIndex(cols, rows, cx + dx, cz + dz);
        const c = i >= 0 ? cells[i] : null;
        if (!c || !c.walkable) continue;
        const d = Math.hypot(c.x - (cells[cz * cols + cx]?.x ?? cx), c.z - (cells[cz * cols + cx]?.z ?? cz));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best >= 0) break;
  }
  return best;
}

function carveLink(
  cells: (NavCellData | null)[],
  minX: number,
  minZ: number,
  cols: number,
  rows: number,
  cs: number,
  link: NavLink,
  get: (cx: number, cz: number) => NavCellData
) {
  const half = Math.max(cs * 0.5, link.width / 2);
  const samples = Math.max(16, Math.ceil(polylineLength(link.polyline) / (cs * 0.25)));
  const stamps: Array<{ x: number; z: number; y: number }> = [];
  for (let i = 0; i <= samples; i++) {
    const p = pointOnPolyline(link.polyline, i / samples);
    stamps.push({ x: p[0], z: p[2], y: p[1] });
  }
  for (const s of stamps) {
    const cx0 = Math.max(0, Math.floor((s.x - half - minX) / cs));
    const cx1 = Math.min(cols - 1, Math.floor((s.x + half - minX) / cs));
    const cz0 = Math.max(0, Math.floor((s.z - half - minZ) / cs));
    const cz1 = Math.min(rows - 1, Math.floor((s.z + half - minZ) / cs));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = get(cx, cz);
        const dx = c.x - s.x;
        const dz = c.z - s.z;
        if (Math.hypot(dx, dz) > half + cs * 0.25) continue;
        c.walkable = true;
        c.linkId = link.id;
        // At link ends the real zone floor wins; under the stair we use the
        // interpolated height.
        const onEnd = link.polyline.some(
          (p) => Math.hypot(p[0] - c.x, p[2] - c.z) <= cs * 0.75 && Math.abs(p[1] - c.y) < 0.9
        );
        if (!onEnd || !c.zoneId) c.y = s.y;
        if (!c.zoneId) {
          const zoneGuess = nearestPointOnPolyline(link.polyline, [c.x, 0, c.z]);
          void zoneGuess;
        }
      }
    }
  }
}

export function isWalkableCell(grid: NavGrid, idx: number): boolean {
  return idx >= 0 && idx < grid.cells.length && !!grid.cells[idx]?.walkable;
}

export function closedGateSet(grid: NavGrid, openGates: ReadonlySet<string>): Set<number> {
  const set = new Set<number>();
  for (const [gate, list] of grid.gateCells) {
    if (openGates.has(gate)) continue;
    for (const i of list) set.add(i);
  }
  return set;
}

export interface WalkResult {
  found: boolean;
  cells: number[];
  points: Vec3[];
  distance: number;
}

export function findPath(
  grid: NavGrid,
  from: number,
  to: number,
  openGates: ReadonlySet<string> = new Set(),
  blockedExtra?: ReadonlySet<number>
): WalkResult {
  const total = grid.cols * grid.rows;
  const fromCell = grid.cells[from];
  const toCell = grid.cells[to];
  if (!fromCell || !toCell) return { found: false, cells: [], points: [], distance: 0 };
  if (from === to) return { found: true, cells: [from], points: [cellWorld(grid, from)], distance: 0 };
  const closed = closedGateSet(grid, openGates);
  const prev = new Int32Array(total).fill(-2);
  const dist = new Float64Array(total).fill(Infinity);
  const queue = new Int32Array(total);
  let qh = 0;
  let qt = 0;
  queue[qt++] = from;
  prev[from] = -1;
  dist[from] = 0;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let found = false;
  while (qh < qt) {
    const cur = queue[qh++];
    if (cur === to) {
      found = true;
      break;
    }
    const cc = grid.cells[cur]!;
    for (const [dx, dz] of dirs) {
      const nx = cc.cx + dx;
      const nz = cc.cz + dz;
      const ni = czIndex(grid.cols, grid.rows, nx, nz);
      if (ni < 0) continue;
      const nc = grid.cells[ni];
      if (!nc || !nc.walkable) continue;
      if (closed.has(ni)) continue;
      if (blockedExtra?.has(ni)) continue;
      if (Math.abs(nc.y - cc.y) > grid.maxStep + 1e-6) continue;
      if (prev[ni] !== -2) continue;
      prev[ni] = cur;
      dist[ni] = dist[cur] + 1;
      queue[qt++] = ni;
    }
  }
  if (!found) return { found: false, cells: [], points: [], distance: 0 };
  const path: number[] = [];
  let at = to;
  while (at !== -1) {
    path.push(at);
    at = prev[at];
  }
  path.reverse();
  const points = path.map((i) => cellWorld(grid, i));
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
      points[i][2] - points[i - 1][2]
    );
  }
  return { found: true, cells: path, points, distance };
}

/** BFS distances in cell hops; gate-aware and height-aware. */
export function distanceField(
  grid: NavGrid,
  from: number,
  openGates: ReadonlySet<string> = new Set(),
  blockedExtra?: ReadonlySet<number>
): Float64Array {
  const total = grid.cols * grid.rows;
  const dist = new Float64Array(total).fill(Infinity);
  const start = grid.cells[from];
  if (!start || !start.walkable) return dist;
  const closed = closedGateSet(grid, openGates);
  const queue = new Int32Array(total);
  let qh = 0;
  let qt = 0;
  dist[from] = 0;
  queue[qt++] = from;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (qh < qt) {
    const cur = queue[qh++];
    const cc = grid.cells[cur]!;
    for (const [dx, dz] of dirs) {
      const nx = cc.cx + dx;
      const nz = cc.cz + dz;
      const ni = czIndex(grid.cols, grid.rows, nx, nz);
      if (ni < 0) continue;
      const nc = grid.cells[ni];
      if (!nc || !nc.walkable) continue;
      if (closed.has(ni)) continue;
      if (blockedExtra?.has(ni)) continue;
      if (Math.abs(nc.y - cc.y) > grid.maxStep + 1e-6) continue;
      if (dist[ni] !== Infinity) continue;
      dist[ni] = dist[cur] + 1;
      queue[qt++] = ni;
    }
  }
  return dist;
}

export function worldToIndex(grid: NavGrid, x: number, z: number): number {
  const cx = Math.floor((x - grid.minX) / grid.cellSize);
  const cz = Math.floor((z - grid.minZ) / grid.cellSize);
  return czIndex(grid.cols, grid.rows, cx, cz);
}

export function indexToLocal(grid: NavGrid, idx: number): { cx: number; cz: number } {
  return { cx: idx % grid.cols, cz: Math.floor(idx / grid.cols) };
}

export function nearestWalkable(
  grid: NavGrid,
  x: number,
  z: number,
  maxR = 4,
  filter?: (c: NavCellData) => boolean
): number {
  const cx = Math.floor((x - grid.minX) / grid.cellSize);
  const cz = Math.floor((z - grid.minZ) / grid.cellSize);
  let best = -1;
  let bestD = Infinity;
  const baseX = grid.minX + (cx + 0.5) * grid.cellSize;
  const baseZ = grid.minZ + (cz + 0.5) * grid.cellSize;
  for (let r = 0; r <= maxR; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const i = czIndex(grid.cols, grid.rows, cx + dx, cz + dz);
        const c = i >= 0 ? grid.cells[i] : null;
        if (!c || !c.walkable) continue;
        if (filter && !filter(c)) continue;
        const d = Math.hypot(c.x - baseX, c.z - baseZ);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best >= 0) break;
  }
  return best;
}

export function lineOfSight(grid: NavGrid, from: Vec3, to: Vec3): boolean {
  const steps = Math.ceil(Math.max(Math.abs(to[0] - from[0]), Math.abs(to[2] - from[2])) / (grid.cellSize * 0.2)) + 1;
  let last = -1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from[0] + (to[0] - from[0]) * t;
    const z = from[2] + (to[2] - from[2]) * t;
    const idx = worldToIndex(grid, x, z);
    if (idx === last) continue;
    last = idx;
    const c = grid.cells[idx];
    if (c?.losBlocked) return false;
  }
  return true;
}

export function hasLosBetweenCells(grid: NavGrid, a: number, b: number): boolean {
  return lineOfSight(grid, cellWorld(grid, a), cellWorld(grid, b));
}
