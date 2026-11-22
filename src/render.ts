import type {
  Conflict,
  LevelDef,
  PlacementResult,
  ProofEntry,
  RouteStop,
  SeedSummary,
  Vec3,
} from './core/types.ts';
import { kindLabel } from './core/demoLevel.ts';

export type TabId = 'spot' | 'proof' | 'basis' | 'issues' | 'seeds';

const ROLE_COLOR: Record<string, string> = {
  main: '#f0b35a',
  side: '#74a9ff',
  key: '#c88bff',
  exit: '#6ad3c4',
};

interface RenderCtx {
  level: LevelDef;
  result: PlacementResult | null;
  selected: string | null;
  routeIndex: number | null;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onRouteIndex: (i: number | null) => void;
  onSeed: (seed: number) => void;
  miniMap: (points: MiniPoint[], focusZone?: string) => SVGSVGElement;
}

export interface MiniPoint {
  pos: Vec3;
  color: string;
  label?: string;
  ring?: number;
}

export function renderTab(tab: TabId, body: HTMLElement, ctx: RenderCtx) {
  body.replaceChildren();
  switch (tab) {
    case 'spot':
      renderSpot(body, ctx);
      break;
    case 'proof':
      renderProof(body, ctx);
      break;
    case 'basis':
      renderBasis(body, ctx);
      break;
    case 'issues':
      renderIssues(body, ctx);
      break;
    case 'seeds':
      renderSeeds(body, ctx);
      break;
  }
}

// ------------------------------------------------------------------ helpers

function el<K extends keyof HTMLElementTagNameMap>(
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
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

function banner(ctx: RenderCtx): HTMLElement {
  const res = ctx.result;
  const wrap = el('div');
  if (!res) {
    wrap.append(el('div', { class: 'result-banner' }, [
      el('div', { class: 'title' }, ['尚未生成']),
      el('div', { class: 'sub' }, ['点击右上角“生成落位”，工具会把任务对象放进场景并验证路线。']),
    ]));
    return wrap;
  }
  const hard = res.conflicts.filter((c) => c.severity === 'hard').length;
  const soft = res.conflicts.filter((c) => c.severity === 'soft').length;
  wrap.append(el('div', { class: `result-banner ${res.ok ? 'ok' : 'bad'}` }, [
    el('div', { class: 'title' }, [res.ok ? '✓ 落位成立 · walk-only 通关证明已生成' : '✕ 落位不成立']),
    el('div', { class: 'sub' }, [
      res.ok
        ? `${res.proof.route.stops.length} 站 · ${res.proof.route.totalDistance.toFixed(0)} m · 全部步行`
        : `${hard} 条硬冲突${soft ? `，${soft} 条偏好未满足` : ''}；支线仍在结果中，等待你处理冲突。`,
    ]),
  ]));
  return wrap;
}

function stats(ctx: RenderCtx): HTMLElement {
  const res = ctx.result;
  const grid = el('div', { class: 'stat-grid' });
  const route = res?.proof.route.totalDistance ?? 0;
  const steps = res?.placements.length ?? 0;
  const keys = res?.keys.length ?? 0;
  const ms = res?.metrics.searchMs ?? 0;
  const add = (k: string, v: string, small?: string) => {
    grid.append(el('div', { class: 'stat' }, [
      el('div', { class: 'k' }, [k]),
      el('div', { class: 'v' }, [v, ...(small ? [el('small', {}, [` ${small}`])] : [])]),
    ]));
  };
  add('任务点 / 钥匙', `${steps}/${keys}`);
  add('路线长度', route.toFixed(0), 'm');
  add('证明站数', String(res?.proof.entries.length ?? 0));
  add('求解耗时', String(ms), 'ms');
  return grid;
}

function zoneColor(level: LevelDef, zoneId: string): string {
  const zone = level.zones.find((zz) => zz.id === zoneId);
  if (!zone) return '#2a3242';
  const colors: Record<string, string> = {
    hub: '#2a3242', hall: '#28303f', shrine: '#302a42', cliff: '#3a3326',
    vault: '#20343a', garden: '#283a2f', tunnel: '#2b2e38', lab: '#2d2938',
  };
  return colors[zone.kind] ?? '#2a3242';
}

function routePoints(ctx: RenderCtx): MiniPoint[] {
  const res = ctx.result;
  if (!res) return [];
  const pts: MiniPoint[] = [];
  for (const p of res.placements) {
    const stop = res.proof.route.stops.find((s) => s.id === p.stepId);
    const role = ctx.level.steps.find((s) => s.id === p.stepId)?.role ?? 'main';
    pts.push({ pos: p.objectPos, color: ROLE_COLOR[role], ring: 0.8 });
    void stop;
  }
  for (const k of res.keys) pts.push({ pos: k.pos, color: ROLE_COLOR.key, ring: 0.8 });
  for (const leg of res.proof.route.legs) {
    for (const p of leg.points) pts.push({ pos: p, color: '#f0b35a', label: '__route' });
  }
  return pts;
}

// --------------------------------------------------------------------- spot

function renderSpot(body: HTMLElement, ctx: RenderCtx) {
  body.append(banner(ctx), stats(ctx));
  const res = ctx.result;
  if (!res) {
    body.append(el('div', { class: 'empty' }, ['生成后，每个任务点的落位坐标、交互站位和评分依据会出现在这里。']));
    return;
  }

  body.append(el('div', { class: 'section-title' }, ['场景区域']));
  const zoneChips = el('div', { class: 'pill-row' });
  for (const z of ctx.level.zones) {
    const chip = el('span', { class: 'pill' }, [`${z.name} · ${kindLabel(z.kind)}`]);
    chip.style.borderColor = zoneColor(ctx.level, z.id);
    if (z.exit) chip.style.color = '#6ad3c4';
    zoneChips.append(chip);
  }
  body.append(zoneChips);

  body.append(el('div', { class: 'section-title' }, ['任务对象落位']));
  for (const p of res.placements) {
    const step = ctx.level.steps.find((s) => s.id === p.stepId)!;
    const isSelected = ctx.selected === p.stepId;
    const card = el('div', { class: 'spot-card' });
    if (isSelected) card.style.borderColor = 'var(--accent)';
    const visit = res.proof.route.stops.find((s) => s.id === p.stepId);
    const head = el('div', { class: 'head' }, [
      el('span', { class: 'idx' }, [String(visit?.order ?? '·')]),
      el('span', { class: 'name' }, [step.label]),
      el('span', { class: `chip ${step.role}` }, [step.role === 'main' ? '主线' : '支线']),
    ]);
    head.addEventListener('click', () => ctx.onSelect(p.stepId));
    card.append(head);

    const bodyEl = el('div', { class: 'body' });
    const kv = el('div', { class: 'kv' });
    const row = (k: string, v: string) => {
      kv.append(el('span', { class: 'k' }, [k]), el('span', { class: 'v' }, [v]));
    };
    row('区域', `${p.zoneId} · ${kindLabel(ctx.level.zones.find((z) => z.id === p.zoneId)?.kind ?? 'hub')}`);
    row('对象格', `(${p.objectCell[0]}, ${p.objectCell[1]})  y=${p.objectPos[1].toFixed(2)}`);
    row('站位格', `(${p.approachCell[0]}, ${p.approachCell[1]})`);
    row('交互距离', `${p.interactionDistance.toFixed(2)} m / 上限 ${step.interaction.radius.toFixed(1)} m`);
    row('视线', p.lineOfSight ? '通视' : '被阻挡');
    row('候选数', String(p.candidates));
    bodyEl.append(kv);
    const pills = el('div', { class: 'pill-row' });
    pills.append(el('span', { class: `pill ${p.interactionDistance <= step.interaction.radius ? 'good' : 'bad'}` }, [
      p.interactionDistance <= step.interaction.radius ? '半径成立' : '半径失败',
    ]));
    pills.append(el('span', { class: `pill ${p.lineOfSight ? 'good' : 'bad'}` }, [p.lineOfSight ? 'LOS 通' : 'LOS 断']));
    for (const part of p.scoreParts.slice(0, 3)) {
      if (part.value > 0) pills.append(el('span', { class: 'pill warn' }, [part.label]));
    }
    bodyEl.append(pills);
    const mini = ctx.miniMap([
      ...routePoints(ctx),
      { pos: p.objectPos, color: '#ffffff', ring: Math.max(1.5, step.interaction.radius) },
    ], p.zoneId);
    bodyEl.append(mini);
    card.append(bodyEl);
    card.addEventListener('mouseenter', () => ctx.onFocus(p.stepId));
    body.append(card);
  }

  if (res.keys.length) {
    body.append(el('div', { class: 'section-title' }, ['钥匙落位（按可达状态选址）']));
    for (const k of res.keys) {
      const def = ctx.level.keys.find((kk) => kk.id === k.keyId)!;
      const card = el('div', { class: 'spot-card' });
      const visit = res.proof.route.stops.find((s) => s.id === k.keyId);
      const head = el('div', { class: 'head' }, [
        el('span', { class: 'idx' }, [String(visit?.order ?? '·')]),
        el('span', { class: 'name' }, [def.label]),
        el('span', { class: 'chip side' }, ['钥匙']),
      ]);
      head.addEventListener('click', () => ctx.onSelect(k.keyId));
      card.append(head);
      const bodyEl = el('div', { class: 'body' });
      const kv = el('div', { class: 'kv' });
      const row = (key: string, v: string) => {
        kv.append(el('span', { class: 'k' }, [key]), el('span', { class: 'v' }, [v]));
      };
      row('藏点区域', k.zoneId);
      row('藏点格', `(${k.cell[0]}, ${k.cell[1]})`);
      row('开门', k.gates.join(', '));
      row('可达状态', k.reachStateNote);
      row('直线到出口', `${k.distanceToExit.toFixed(1)} m（不用于安全判定）`);
      bodyEl.append(kv);
      const unsafe = /only reachable|自锁/.test(k.reachStateNote);
      const pills = el('div', { class: 'pill-row' });
      pills.append(el('span', { class: `pill ${unsafe ? 'bad' : 'good'}` }, [unsafe ? '不可达于开门前' : '开门前可达']));
      bodyEl.append(pills);
      bodyEl.append(ctx.miniMap(
        [...routePoints(ctx), { pos: k.pos, color: '#ffffff', ring: 1.2 }],
        k.zoneId
      ));
      card.append(bodyEl);
      body.append(card);
    }
  }

  if (ctx.level.notes?.length) {
    body.append(el('div', { class: 'section-title' }, ['场景说明']));
    const box = el('div', { class: 'result-banner' });
    for (const n of ctx.level.notes) box.append(el('div', { class: 'sub', style: 'margin-top:4px' }, [n]));
    body.append(box);
  }
}

// -------------------------------------------------------------------- proof

function renderProof(body: HTMLElement, ctx: RenderCtx) {
  body.append(banner(ctx));
  const res = ctx.result;
  if (!res) {
    body.append(el('div', { class: 'empty' }, ['生成后会出现逐站通关证明，包含拾取顺序、开门时刻和站位。']));
    return;
  }
  const proof = res.proof;

  const strip = el('div', { class: 'route-strip' });
  strip.append(el('span', { class: 'node' }, ['ENTRY']));
  for (const s of proof.route.stops) {
    strip.append(el('span', { class: 'arrow' }, ['→']));
    const role = s.kind === 'exit' ? 'exit' : s.kind === 'key' ? 'key' : s.role === 'side' ? 'side' : 'step';
    strip.append(el('span', { class: `node ${role}` }, [s.id]));
  }
  body.append(strip);

  const meters = el('div', { class: 'stat-grid' });
  meters.append(
    el('div', { class: 'stat' }, [
      el('div', { class: 'k' }, ['总步行距离']),
      el('div', { class: 'v' }, [proof.route.totalDistance.toFixed(0), el('small', {}, [' m'])]),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k' }, ['模式']),
      el('div', { class: 'v' }, ['walk', el('small', {}, [' only'])]),
    ])
  );
  body.append(meters);

  body.append(el('div', { class: 'section-title' }, [
    '逐站证明',
  ]));
  for (const e of proof.entries) {
    body.append(proofEntry(ctx, e));
  }

  body.append(el('div', { class: 'section-title' }, ['路线分段（真实网格路径）']));
  const legs = el('div');
  proof.route.legs.forEach((leg, i) => {
    if (leg.distance < 0.01) return;
    const row = el('div', { class: 'basis-row' });
    const active = ctx.routeIndex === null || ctx.routeIndex >= i;
    row.style.opacity = active ? '1' : '0.4';
    row.append(
      el('span', { class: 'tag' }, [`L${i + 1}`]),
      el('div', { class: 'txt' }, [
        el('b', {}, [`${leg.distance.toFixed(1)} m`]),
        `  (${leg.from[0].toFixed(1)}, ${leg.from[1].toFixed(1)}, ${leg.from[2].toFixed(1)}) → (${leg.to[0].toFixed(1)}, ${leg.to[1].toFixed(1)}, ${leg.to[2].toFixed(1)})`,
        el('span', { class: 'dim' }, [` · ${leg.points.length} 格`]),
      ])
    );
    row.addEventListener('click', () => ctx.onRouteIndex(active && ctx.routeIndex === i ? null : i));
    legs.append(row);
  });
  body.append(legs);

  const slider = el('div', { class: 'pill-row', style: 'margin-top:10px' });
  const allBtn = el('button', { class: 'small' }, ['显示全部']);
  allBtn.addEventListener('click', () => ctx.onRouteIndex(null));
  const stepBtn = el('button', { class: 'small' }, ['逐段播放']);
  stepBtn.addEventListener('click', () => {
    const n = ctx.result?.proof.route.legs.length ?? 0;
    if (!n) return;
    const current = ctx.routeIndex ?? -1;
    ctx.onRouteIndex(current + 1 >= n ? null : current + 1);
  });
  slider.append(allBtn, stepBtn);
  body.append(slider);

  body.append(el('details', { class: 'raw' }, [
    el('summary', {}, ['导出 proof JSON']),
    el('pre', {}, [JSON.stringify({
      mode: proof.mode,
      ok: proof.ok,
      visitedSteps: proof.visitedSteps,
      collectedKeys: proof.collectedKeys,
      openedGates: proof.openedGates,
      stops: proof.route.stops.map((s) => ({
        order: s.order, id: s.id, kind: s.kind, zone: s.zoneId,
        stand: s.standPos.map((n) => Number(n.toFixed(2))), reachState: s.reachState,
      })),
      routeMeters: Number(proof.route.totalDistance.toFixed(2)),
      legs: proof.route.legs.map((l) => ({ distance: Number(l.distance.toFixed(2)), points: l.points.length })),
    }, null, 2)]),
  ]));
}

function proofEntry(ctx: RenderCtx, e: ProofEntry): HTMLElement {
  const row = el('div', { class: `proof-entry ${e.kind === 'exit' ? 'exit' : ''}` });
  row.append(el('div', { class: 'num' }, [String(e.order)]));
  const main = el('div');
  const role =
    e.kind === 'exit' ? 'exit' : e.kind === 'key' ? 'key' : ctx.level.steps.find((s) => s.id === e.id)?.role ?? 'main';
  main.append(
    el('div', { class: 'label' }, [
      el('span', { style: `color:${ROLE_COLOR[role]};margin-right:6px` }, [e.kind === 'key' ? 'KEY' : e.kind === 'exit' ? 'EXIT' : 'STEP']),
      e.label,
    ])
  );
  main.append(el('div', { class: 'why' }, [e.why]));
  main.append(el('div', { class: 'state' }, [`状态: ${e.reachState} │ 站位 (${e.standPos[0].toFixed(1)}, ${e.standPos[1].toFixed(1)}, ${e.standPos[2].toFixed(1)})`]));
  if (e.interactionDistance !== undefined) {
    const step = ctx.level.steps.find((s) => s.id === e.id);
    const lim = step?.interaction.radius ?? 0;
    main.append(el('div', { class: `state ${e.interactionDistance <= lim ? 'ok-text' : 'bad-text'}` }, [
      `交互 ${e.interactionDistance.toFixed(2)} m / ${lim.toFixed(1)} m${e.lineOfSight === false ? ' · LOS 阻断' : ''}`,
    ]));
  }
  row.append(main);
  row.addEventListener('click', () => ctx.onSelect(e.id));
  return row;
}

// -------------------------------------------------------------------- basis

function renderBasis(body: HTMLElement, ctx: RenderCtx) {
  const res = ctx.result;
  if (!res) {
    body.append(el('div', { class: 'empty' }, ['选中一个任务点后，这里会解释它为什么落在这个位置。']));
    return;
  }
  const id = ctx.selected;
  if (!id) {
    body.append(el('div', { class: 'empty' }, ['点击左侧任务、场景中的标记或“空间落位”卡片，查看落位依据。']));
    body.append(el('div', { class: 'section-title' }, ['全局求解摘要']));
    body.append(globalBasis(ctx, res));
    return;
  }

  const step = ctx.level.steps.find((s) => s.id === id);
  if (step) {
    const p = res.placements.find((x) => x.stepId === id);
    if (!p) {
      body.append(el('div', { class: 'empty ok-empty' }, ['该任务没有可用落位，异常页签会给出原因。']));
      return;
    }
    body.append(el('div', { class: 'result-banner' }, [
      el('div', { class: 'title' }, [step.label]),
      el('div', { class: 'sub' }, [`${step.role === 'main' ? '主线' : '支线'} · 期望区域 ${kindLabel(step.zoneHint)} · seq ${step.seq}`]),
    ]));
    if (step.rationale) {
      body.append(el('div', { class: 'section-title' }, ['故事约束']));
      body.append(el('div', { class: 'basis-row' }, [
        el('span', { class: 'tag' }, ['STORY']),
        el('div', { class: 'txt' }, [step.rationale]),
      ]));
    }

    body.append(el('div', { class: 'section-title' }, ['选中的理由']));
    const rows: Array<[string, string, string]> = [
      ['区域', `${p.zoneId}（${kindLabel(ctx.level.zones.find((z) => z.id === p.zoneId)?.kind ?? 'hub')}）`,
        step.requiredKind ? '硬条件：区域类型必须匹配' : step.preferredZone === p.zoneId ? '命中指定区域偏好' : '可用且不违背硬条件'],
      ['对象格', `(${p.objectCell[0]}, ${p.objectCell[1]})`, '可行走、无门闸、不阻断动线'],
      ['站位格', `(${p.approachCell[0]}, ${p.approachCell[1]})`, `在 ${step.interaction.radius.toFixed(1)} m 交互半径内`],
      ['交互距离', `${p.interactionDistance.toFixed(2)} m`, p.interactionDistance <= step.interaction.radius ? '硬条件成立' : '硬条件失败'],
      ['视线', p.lineOfSight ? '通视' : '被静态物体遮挡', step.interaction.requiresLineOfSight ? '该交互要求通视' : '本交互不强制通视'],
      ['求解顺序', p.reachState, '来自实际通关证明，而非表格推演'],
    ];
    for (const [k, v, why] of rows) {
      body.append(el('div', { class: 'basis-row' }, [
        el('span', { class: 'tag' }, [k]),
        el('div', { class: 'txt' }, [el('b', {}, [v]), ' — ', why]),
      ]));
    }

    body.append(el('div', { class: 'section-title' }, ['评分分解（越低越好）']));
    if (!p.scoreParts.length) {
      body.append(el('div', { class: 'basis-row' }, [el('div', { class: 'txt' }, ['没有额外惩罚项，基础分为 0。'])]));
    }
    for (const part of p.scoreParts) {
      body.append(el('div', { class: 'basis-row' }, [
        el('span', { class: 'tag' }, [part.value.toFixed(1)]),
        el('div', { class: 'txt' }, [el('b', {}, [part.label]), ' — ', part.note]),
      ]));
    }

    body.append(el('div', { class: 'section-title' }, ['相关条件']));
    const related = ctx.level.constraints.filter((c) => c.a === id || c.b === id);
    if (!related.length) body.append(el('div', { class: 'basis-row' }, [el('div', { class: 'txt' }, ['无直接距离条件。'])]));
    for (const c of related) {
      const a = nodePos(res, c.a);
      const b = nodePos(res, c.b);
      const d = a && b ? dist3(a, b) : NaN;
      const hard = c.hard ? 'HARD' : 'SOFT';
      body.append(el('div', { class: 'basis-row' }, [
        el('span', { class: 'tag', style: `color:${c.hard ? 'var(--hard)' : 'var(--soft)'}` }, [hard]),
        el('div', { class: 'txt' }, [
          el('b', {}, [`${c.a} ↔ ${c.b} = ${Number.isFinite(d) ? d.toFixed(1) : '?'} m`]),
          `  要求 ${c.minDist !== undefined ? `≥${c.minDist}` : ''}${c.minDist !== undefined && c.maxDist !== undefined ? '，' : ''}${c.maxDist !== undefined ? `≤${c.maxDist}` : ''} m — ${c.note}`,
        ]),
      ]));
    }

    body.append(el('div', { class: 'section-title' }, ['候选与淘汰']));
    body.append(el('div', { class: 'basis-row' }, [
      el('span', { class: 'tag' }, ['CAND']),
      el('div', { class: 'txt' }, [`共 ${p.candidates} 个可行格；选址后排除同格冲突，保留了最近的合规选项。`]),
    ]));
    for (const r of p.rejections.slice(0, 6)) {
      body.append(el('div', { class: 'basis-row' }, [
        el('span', { class: 'tag', style: 'color:var(--bad)' }, ['✕']),
        el('div', { class: 'txt' }, [`${r.count} 格：${r.reason}`]),
      ]));
    }

    const mini = ctx.miniMap([
      { pos: p.objectPos, color: '#ffffff', ring: Math.max(1.5, step.interaction.radius) },
      { pos: p.approachPos, color: '#6ad3c4' },
    ], p.zoneId);
    body.append(mini);
    body.append(el('div', { class: 'spacer' }));
    const focus = el('button', { class: 'small' }, ['在场景中定位']);
    focus.addEventListener('click', () => ctx.onFocus(id));
    body.append(focus);
  } else {
    const k = res.keys.find((x) => x.keyId === id);
    if (k) {
      const def = ctx.level.keys.find((d) => d.id === id)!;
      body.append(el('div', { class: 'result-banner' }, [
        el('div', { class: 'title' }, [def.label]),
        el('div', { class: 'sub' }, ['钥匙藏点按可达状态选址，不按几何距离']),
      ]));
      const rows: Array<[string, string]> = [
        ['藏点区域', k.zoneId],
        ['藏点格', `(${k.cell[0]}, ${k.cell[1]})`],
        ['打开的门', k.gates.join(', ')],
        ['可达状态', k.reachStateNote],
        ['到单向出口', `${k.distanceToExit.toFixed(1)} m`],
        ['候选数', String(k.candidates)],
      ];
      for (const [a, b] of rows) {
        body.append(el('div', { class: 'basis-row' }, [el('span', { class: 'tag' }, [a]), el('div', { class: 'txt' }, [b])]));
      }
      body.append(el('div', { class: 'basis-row' }, [
        el('span', { class: 'tag' }, ['RULE']),
        el('div', { class: 'txt' }, [
          '钥匙必须在“自身门未开”时仍可从入口步行抵达。距离出口再近，只要必须开门才能拿到，就是自锁。',
        ]),
      ]));
      for (const n of k.notes) {
        body.append(el('div', { class: 'basis-row' }, [el('span', { class: 'tag' }, ['NOTE']), el('div', { class: 'txt' }, [n])]));
      }
    } else {
      body.append(el('div', { class: 'empty' }, ['该对象未出现在结果中。']));
    }
  }
}

function globalBasis(ctx: RenderCtx, res: PlacementResult): HTMLElement {
  const wrap = el('div');
  const rows: Array<[string, string]> = [
    ['区域数', String(ctx.level.zones.length)],
    ['硬条件', String(ctx.level.constraints.filter((c) => c.hard).length)],
    ['软偏好', String(ctx.level.constraints.filter((c) => !c.hard).length)],
    ['搜索种子', `${res.seeds.length} 个，${res.seeds.filter((s) => s.ok).length} 个成立`],
    ['候选格', String(res.metrics.candidatesExamined)],
    ['依赖表', res.staticConflicts.some((c) => c.code === 'DEPENDENCY_CYCLE') ? '有环' : '无环'],
  ];
  for (const [k, v] of rows) {
    wrap.append(el('div', { class: 'basis-row' }, [el('span', { class: 'tag' }, [k]), el('div', { class: 'txt' }, [v])]));
  }
  return wrap;
}

function nodePos(res: PlacementResult, id: string): Vec3 | null {
  if (id === 'entry') return res.level.entry;
  if (id === 'exit') return res.level.exitPoint;
  const p = res.placements.find((x) => x.stepId === id);
  if (p) return p.objectPos;
  const k = res.keys.find((x) => x.keyId === id);
  if (k) return k.pos;
  return null;
}

function dist3(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ------------------------------------------------------------------- issues

function renderIssues(body: HTMLElement, ctx: RenderCtx) {
  const res = ctx.result;
  if (!res) {
    body.append(el('div', { class: 'empty' }, ['生成后这里列出硬冲突、软偏好差距和静态依赖问题。']));
    return;
  }
  const hard = res.conflicts.filter((c) => c.severity === 'hard');
  const soft = res.conflicts.filter((c) => c.severity === 'soft');
  const warn = res.conflicts.filter((c) => c.severity === 'warn');

  body.append(el('div', { class: 'result-banner ' + (hard.length ? 'bad' : 'ok') }, [
    el('div', { class: 'title' }, [hard.length ? `${hard.length} 条硬冲突` : '无硬冲突']),
    el('div', { class: 'sub' }, [`${soft.length} 条软偏好未满足 · ${warn.length} 条提示`]),
  ]));

  if (!res.conflicts.length) {
    body.append(el('div', { class: 'empty ok-empty' }, ['没有任何冲突：空间、依赖、开门状态与交互范围同时成立。']));
    return;
  }
  const groups: Array<[string, Conflict[]]> = [
    ['硬冲突 — 阻止通关', hard],
    ['软偏好 — 已接受或需权衡', soft],
    ['提示', warn],
  ];
  for (const [title, list] of groups) {
    if (!list.length) continue;
    body.append(el('div', { class: 'section-title' }, [title]));
    for (const c of list) body.append(issueCard(ctx, c));
  }

  body.append(el('details', { class: 'raw' }, [
    el('summary', {}, ['为什么会这样？']),
    el('pre', {}, [
      [
        '工具不会因为某条支线难放就丢弃它。',
        '如果硬条件互相矛盾（如区域类型 × 距离上限），求解器返回空集并命名冲突。',
        '如果依赖表无环但角色到不了（门、坡、交互范围），可达状态检查会指出具体任务与状态。',
        '钥匙的安全由“门未开时能否步行拿到”判定，而非到出口的直线距离。',
      ].join('\n'),
    ]),
  ]));
}

function issueCard(ctx: RenderCtx, c: Conflict): HTMLElement {
  const card = el('div', { class: `issue-card ${c.severity}` });
  card.append(el('div', { class: 'code' }, [`${c.severity.toUpperCase()} · ${c.code}`]));
  card.append(el('div', { class: 'msg' }, [c.message]));
  card.append(el('div', { class: 'fix' }, [`建议：${c.suggestion}`]));
  if (c.subjects.length) card.append(el('div', { class: 'subj' }, [`涉及：${c.subjects.join(', ')}`]));
  if (c.at?.length) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => ctx.onFocus(c.subjects[0] ?? ''));
  }
  return card;
}

// -------------------------------------------------------------------- seeds

function renderSeeds(body: HTMLElement, ctx: RenderCtx) {
  const res = ctx.result;
  if (!res) {
    body.append(el('div', { class: 'empty' }, ['生成后这里比较不同随机种子的落位结果。']));
    return;
  }
  body.append(el('div', { class: 'result-banner' }, [
    el('div', { class: 'title' }, [`${res.seeds.length} 个种子`]),
    el('div', { class: 'sub' }, [
      `其中 ${res.seeds.filter((s) => s.ok).length} 个得到完整可走证明。点击一行可只看该种子的落位。`,
    ]),
  ]));
  const table = el('table', { class: 'seed-table' });
  const thead = el('thead');
  thead.append(el('tr', {}, [
    el('th', {}, ['种子']),
    el('th', {}, ['结果']),
    el('th', {}, ['软代价']),
    el('th', {}, ['路线']),
    el('th', {}, ['说明']),
  ]));
  table.append(thead);
  const tbody = el('tbody');
  res.seeds.forEach((s, i) => {
    const tr = el('tr', { class: i === 0 ? 'best' : '' });
    tr.append(
      el('td', {}, [`#${s.seed}`]),
      el('td', { class: s.ok ? 'ok' : 'bad' }, [s.ok ? '成立' : '失败']),
      el('td', {}, [s.softCost.toFixed(1)]),
      el('td', {}, [s.ok ? `${s.routeLength.toFixed(0)} m` : '—']),
      el('td', {}, [s.note.length > 34 ? `${s.note.slice(0, 32)}…` : s.note])
    );
    tr.title = s.placementSignature;
    tr.addEventListener('click', () => ctx.onSeed(s.seed));
    tbody.append(tr);
  });
  table.append(tbody);
  body.append(table);

  body.append(el('div', { class: 'section-title' }, ['落位签名']));
  for (const s of res.seeds.slice(0, 4)) {
    body.append(el('div', { class: 'basis-row' }, [
      el('span', { class: 'tag' }, [`#${s.seed}`]),
      el('div', { class: 'txt mono', style: 'font-size:9.5px;word-break:break-all' }, [s.placementSignature]),
    ]));
  }

  body.append(el('div', { class: 'section-title' }, ['如何读这张表']));
  body.append(el('div', { class: 'basis-row' }, [
    el('div', { class: 'txt' }, [
      '软代价 = 区域偏好偏差 + 软距离超出量 × 权重 + 动线惩罚。硬冲突会让“结果”列为失败。',
      '不同种子的签名不同，但都通过同一套可达与证明检查 —— 展示多种落位而不是复制同一个答案。',
    ]),
  ]));
}

export function seedSummaryLine(s: SeedSummary): string {
  return `#${s.seed} ${s.ok ? '✓' : '✕'} cost ${s.softCost.toFixed(1)}`;
}

export function routeStopLine(s: RouteStop): string {
  return `${s.order}. ${s.id} @ ${s.zoneId}`;
}
