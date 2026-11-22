import type { Conflict, LevelDef, PlacementResult, ZoneDef, Vec3 } from './core/types.ts';
import { buildGrid } from './core/nav.ts';
import { kindLabel } from './core/demoLevel.ts';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '–';
}

export function vecText(p: Vec3): string {
  return `${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)}`;
}

export function zoneName(level: LevelDef, id: string): string {
  return level.zones.find((z) => z.id === id)?.name ?? id;
}

export function zoneKind(level: LevelDef, id: string): string {
  const z = level.zones.find((zz) => zz.id === id);
  return z ? kindLabel(z.kind) : id;
}

/** Small top-down minimap of the whole scene with one highlighted point. */
export function spatialSvg(
  level: LevelDef,
  points: Array<{ pos: Vec3; color: string; label?: string; ring?: number }>,
  focusZone?: string
): SVGSVGElement {
  const grid = buildGrid(level);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const bx = Math.min(...level.zones.map((z) => z.rect[0])) - 2;
  const bz = Math.min(...level.zones.map((z) => z.rect[1])) - 2;
  const ex = Math.max(...level.zones.map((z) => z.rect[2])) + 2;
  const ez = Math.max(...level.zones.map((z) => z.rect[3])) + 2;
  const w = ex - bx;
  const h = ez - bz;
  svg.setAttribute('viewBox', `${bx} ${bz} ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const zoneColors: Record<string, string> = {
    hub: '#2a3242', hall: '#28303f', shrine: '#302a42', cliff: '#3a3326',
    vault: '#20343a', garden: '#283a2f', tunnel: '#2b2e38', lab: '#2d2938',
  };

  // Walkable floor.
  for (let i = 0; i < grid.cells.length; i++) {
    const c = grid.cells[i];
    if (!c || !c.walkable) continue;
    const zone = c.zoneId ? level.zones.find((z) => z.id === c.zoneId) : null;
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', String(c.x - 0.5));
    r.setAttribute('y', String(c.z - 0.5));
    r.setAttribute('width', '1');
    r.setAttribute('height', '1');
    r.setAttribute('fill', zone ? zoneColors[zone.kind] ?? '#2a3242' : '#242c3a');
    if (c.linkId) r.setAttribute('fill', '#3a4557');
    if (focusZone && c.zoneId === focusZone) r.setAttribute('fill', '#3d4a63');
    svg.appendChild(r);
  }

  // Zone outlines + names.
  for (const zone of level.zones) {
    const [x0, z0, x1, z1] = zone.rect;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(x0));
    rect.setAttribute('y', String(z0));
    rect.setAttribute('width', String(x1 - x0));
    rect.setAttribute('height', String(z1 - z0));
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', zone.exit ? '#6ad3c4' : focusZone === zone.id ? '#8fa3c7' : '#39455c');
    rect.setAttribute('stroke-width', focusZone === zone.id ? '0.35' : '0.18');
    svg.appendChild(rect);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', String(x0 + (x1 - x0) / 2));
    text.setAttribute('y', String(z0 + 0.9));
    text.setAttribute('fill', zone.exit ? '#6ad3c4' : '#7d8aa3');
    text.setAttribute('font-size', '0.7');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-family', 'ui-monospace, monospace');
    text.textContent = zone.name;
    svg.appendChild(text);
  }

  // Route line.
  const route = points.filter((p) => p.label === '__route');
  if (route.length > 1) {
    const path = document.createElementNS(ns, 'polyline');
    path.setAttribute('points', route.map((p) => `${p.pos[0]},${p.pos[2]}`).join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#f0b35a');
    path.setAttribute('stroke-width', '0.22');
    path.setAttribute('stroke-dasharray', '0.6 0.4');
    path.setAttribute('opacity', '0.9');
    svg.appendChild(path);
  }

  for (const p of points) {
    if (p.label === '__route') continue;
    if (p.ring) {
      const ring = document.createElementNS(ns, 'circle');
      ring.setAttribute('cx', String(p.pos[0]));
      ring.setAttribute('cy', String(p.pos[2]));
      ring.setAttribute('r', String(p.ring));
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', p.color);
      ring.setAttribute('stroke-width', '0.08');
      ring.setAttribute('opacity', '0.5');
      svg.appendChild(ring);
    }
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', String(p.pos[0]));
    c.setAttribute('cy', String(p.pos[2]));
    c.setAttribute('r', '0.42');
    c.setAttribute('fill', p.color);
    c.setAttribute('stroke', '#0b0d12');
    c.setAttribute('stroke-width', '0.1');
    svg.appendChild(c);
  }
  void w;
  void h;
  return svg;
}

export function severityRank(c: Conflict): number {
  return c.severity === 'hard' ? 0 : c.severity === 'soft' ? 1 : 2;
}

export function resultBanner(level: LevelDef, res: PlacementResult): HTMLElement {
  const hard = res.conflicts.filter((c) => c.severity === 'hard').length;
  const soft = res.conflicts.filter((c) => c.severity === 'soft').length;
  const banner = el('div', { class: `result-banner ${res.ok ? 'ok' : 'bad'}` });
  banner.append(
    el('div', { class: 'title' }, [res.ok ? '✓ 落位成立 — 可走通关证明已生成' : '✕ 落位不成立 — 见异常页签']),
    el('div', { class: 'sub' }, [
      res.ok
        ? `${level.steps.length} 个任务点、${level.keys.length} 把钥匙全部落位；${res.proof.route.stops.length} 站路线，全程步行，无传送。`
        : `发现 ${hard} 条硬冲突${soft ? `、${soft} 条偏好未满足` : ''}。没有任何支线被静默丢弃。`,
    ])
  );
  return banner;
}

export function stepCard(
  level: LevelDef,
  id: string,
  opts: { selected?: boolean; onSelect?: (id: string) => void }
): HTMLElement {
  const step = level.steps.find((s) => s.id === id)!;
  const card = el('div', {
    class: `step-card ${step.role} ${opts.selected ? 'selected' : ''}`,
    'data-step': id,
  });
  const row = el('div', { class: 'row1' }, [
    el('span', { class: `chip ${step.role}` }, [step.role === 'main' ? '主线' : '支线']),
    el('span', { class: 'name' }, [step.label]),
  ]);
  card.append(row);
  const meta = el('div', { class: 'meta' });
  meta.append(
    el('span', { class: 'zone' }, [`期望 ${kindLabel(step.zoneHint)}`]),
    el('span', {}, [`seq ${step.seq}`]),
    el('span', {}, [step.requires.length ? `需 ${step.requires.join('+')}` : '无前置'])
  );
  card.append(meta);
  if (step.rationale) card.append(el('div', { class: 'reason' }, [step.rationale]));
  card.addEventListener('click', () => opts.onSelect?.(id));
  return card;
}

export function zoneListText(zones: ZoneDef[]): string {
  return zones.map((z) => `${z.name}(${kindLabel(z.kind)})`).join(' · ');
}
