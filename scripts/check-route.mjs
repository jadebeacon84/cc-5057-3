import { DEMO_LEVEL } from '../src/core/demoLevel.ts';
import { buildGrid, cellWorld } from '../src/core/nav.ts';
import { placeLevel } from '../src/core/placement.ts';
import { planRoute } from '../src/core/route.ts';

const level = DEMO_LEVEL;
const res = placeLevel(level, { seeds: 8 });
console.log('ok', res.ok, 'route', res.proof.route.totalDistance.toFixed(1));

for (const leg of res.proof.route.legs) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of leg.points) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const climbs = leg.points.filter((p, i) => i > 0 && Math.abs(p[1] - leg.points[i - 1][1]) > 1e-6).length;
  console.log(
    `leg ${leg.distance.toFixed(1)}m y=[${minY.toFixed(2)},${maxY.toFixed(2)}] slopeSteps=${climbs} points=${leg.points.length}`
  );
}

// Simulate the plan step by step using the real execution semantics.
const grid = buildGrid(level);
const p2 = planRoute(level, grid, res.placements, res.keys);
console.log('\nproof ok', p2.ok, 'entries', p2.proof.entries.length, 'stuck', p2.stuck.length);

// Verify every position in every leg is walkable and height-adjacent.
let bad = 0;
for (const leg of res.proof.route.legs) {
  for (let i = 0; i < leg.points.length; i++) {
    const p = leg.points[i];
    const cx = Math.floor((p[0] - grid.minX) / grid.cellSize);
    const cz = Math.floor((p[2] - grid.minZ) / grid.cellSize);
    const c = grid.cells[cz * grid.cols + cx];
    if (!c || !c.walkable) bad++;
    if (i > 0) {
      const q = leg.points[i - 1];
      if (Math.hypot(p[0] - q[0], p[2] - q[2]) > 1.5 + 1e-6) bad++;
      if (Math.abs(p[1] - q[1]) > grid.maxStep + 1e-6) bad++;
    }
  }
}
console.log('illegal leg positions/steps:', bad);
