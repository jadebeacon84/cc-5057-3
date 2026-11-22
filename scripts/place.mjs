#!/usr/bin/env node
// Optional CLI mirror of the GUI's solver. The graphical editor is the primary
// entry point; this exists for CI and headless proof capture.
import { writeFileSync } from 'node:fs';
import { DEMO_LEVEL, makeInvalidLevel } from '../src/core/demoLevel.ts';
import { placeLevel } from '../src/core/placement.ts';

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (flag) => args.includes(flag);

const invalid = has('--invalid');
const seeds = Number(get('--seeds', '8'));
const out = get('--out', '');
const quiet = has('--quiet');
const level = invalid ? makeInvalidLevel() : structuredClone(DEMO_LEVEL);

const res = placeLevel(level, { seeds });

const lines = [];
lines.push(`scene: ${level.name}`);
lines.push(`result: ${res.ok ? 'VALID' : 'INVALID'}`);
lines.push(`search: ${res.metrics.attempts} attempts, ${res.metrics.candidatesExamined} candidates, ${res.metrics.searchMs} ms`);
lines.push(`proof mode: ${res.proof.mode} (walk-only; no teleport transitions exist)`);
lines.push('');
lines.push('placements:');
for (const p of res.placements) {
  lines.push(
    `  ${p.stepId.padEnd(11)} zone=${p.zoneId.padEnd(8)} obj=(${p.objectCell}) stand=(${p.approachCell}) d=${p.interactionDistance.toFixed(2)}m score=${p.score.toFixed(2)}`
  );
}
lines.push('');
lines.push('keys:');
for (const k of res.keys) {
  lines.push(`  ${k.keyId.padEnd(11)} zone=${k.zoneId.padEnd(8)} cell=(${k.cell}) gates=${k.gates.join(',')} exitDist=${k.distanceToExit.toFixed(1)}m`);
  lines.push(`    ${k.reachStateNote}`);
}
lines.push('');
lines.push('completion proof:');
for (const e of res.proof.entries) {
  lines.push(`  ${String(e.order).padStart(2)}. [${e.kind}] ${e.id.padEnd(11)} ${e.status} :: ${e.why}`);
}
lines.push('');
lines.push(`route: ${res.proof.route.stops.length} stops, ${res.proof.route.totalDistance.toFixed(1)} m, ${res.proof.route.legs.length} legs`);
for (const [i, leg] of res.proof.route.legs.entries()) {
  lines.push(`  leg ${i + 1}: ${leg.distance.toFixed(1)} m, ${leg.points.length} grid points`);
}
if (res.conflicts.length) {
  lines.push('');
  lines.push('conflicts:');
  for (const c of res.conflicts) {
    lines.push(`  [${c.severity}] ${c.code}: ${c.message}`);
    lines.push(`         -> ${c.suggestion}`);
  }
}
lines.push('');
lines.push('seeds:');
for (const s of res.seeds) {
  lines.push(`  #${s.seed} ${s.ok ? 'ok  ' : 'fail'} soft=${s.softCost.toFixed(2)} route=${s.routeLength.toFixed(0)}m ${s.placementSignature}`);
}

const text = lines.join('\n');
if (!quiet) console.log(text);
if (out) {
  writeFileSync(out, text + '\n');
  if (!quiet) console.log(`\nwrote ${out}`);
}
process.exitCode = res.ok ? 0 : 1;
