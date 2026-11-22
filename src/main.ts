import './styles.css';
import { DEMO_LEVEL, makeInvalidLevel } from './core/demoLevel.ts';
import { placeLevel, evaluateManual } from './core/placement.ts';
import { buildGrid } from './core/nav.ts';
import type { LevelDef, PlacementResult } from './core/types.ts';
import { Viewport } from './viewport.ts';
import { renderTab, type TabId } from './render.ts';
import { stepCard, spatialSvg, clear } from './ui.ts';

class App {
  private level: LevelDef = structuredClone(DEMO_LEVEL);
  private result: PlacementResult | null = null;
  private validResult: PlacementResult | null = null;
  private viewport: Viewport;
  private tab: TabId = 'spot';
  private selected: string | null = null;
  private routeIndex: number | null = null;
  private invalid = false;
  private override: Record<string, { x: number; z: number }> = {};
  private busy = false;

  constructor() {
    const stage = document.getElementById('stage')!;
    this.viewport = new Viewport(stage, {
      onSelectStep: (id) => this.select(id || null, true),
      onPickCell: (x, z) => this.pickCell(x, z),
      onHoverCell: (x, z, zoneId, sx, sy) => this.hoverInfo(x, z, zoneId, sx, sy),
      onHoverOff: () => this.hideTooltip(),
    });
    this.viewport.buildScene(this.level);
    this.bindChrome();
    this.renderLeft();
    this.render();
    this.generate();
  }

  // --------------------------------------------------------------- chrome
  private bindChrome() {
    document.getElementById('btn-generate')!.addEventListener('click', () => this.generate());
    document.getElementById('btn-invalid')!.addEventListener('click', () => this.toggleInvalid());
    document.getElementById('btn-reset')!.addEventListener('click', () => this.resetOverrides());
    const tabs = document.getElementById('result-tabs')!;
    tabs.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.tab');
      if (!btn) return;
      this.tab = btn.dataset.tab as TabId;
      for (const b of tabs.querySelectorAll('.tab')) b.classList.toggle('active', b === btn);
      this.render();
    });
  }

  private resetOverrides() {
    if (!Object.keys(this.override).length) {
      this.setStatus('没有手动调整；当前就是求解器生成的落位。');
      return;
    }
    this.override = {};
    this.generate();
    this.setStatus('已清除手动调整，恢复求解器落位。');
  }

  private toggleInvalid() {
    this.invalid = !this.invalid;
    this.level = this.invalid ? makeInvalidLevel() : structuredClone(DEMO_LEVEL);
    this.override = {};
    this.validResult = null;
    this.selected = null;
    this.routeIndex = null;
    this.viewport.buildScene(this.level);
    const btn = document.getElementById('btn-invalid')!;
    btn.textContent = this.invalid ? '返回合法场景' : '载入故意不合法配置';
    btn.classList.toggle('danger', this.invalid);
    this.renderLeft();
    this.generate();
  }

  private generate() {
    if (this.busy) return;
    this.busy = true;
    this.setStatus(this.invalid ? '求解故意不合法配置…' : '求解落位与可走证明…');
    // Let the status paint before the synchronous solver runs.
    setTimeout(() => {
      try {
        const res = placeLevel(this.level, { seeds: 8 });
        if (this.invalid) {
          this.result = res;
        } else {
          this.result = this.override && Object.keys(this.override).length
            ? this.applyOverrides(res)
            : res;
          this.validResult = this.result;
        }
        this.viewport.showResult(this.result, this.selected, this.routeIndex);
        const manual = this.result.conflicts.find((c) => c.code.startsWith('MANUAL_'));
        this.setStatus(
          this.result.ok
            ? `落位成立：${this.result.proof.route.stops.length} 站，${this.result.proof.route.totalDistance.toFixed(0)} m 步行${Object.keys(this.override).length ? '（含手动调整）' : ''}`
            : manual
              ? `手动落位被拒绝：${
                  manual.code === 'MANUAL_APPROACH_BLOCKED' ? '交互站位已被其它对象占用' : '该格不满足硬条件'
                }（详见「异常」页）`
              : `未成立：${this.result.conflicts.filter((c) => c.severity === 'hard').length} 条硬冲突`
        );
        const m = this.result.metrics;
        const manualCount = this.result.conflicts.filter((c) => c.code.startsWith('MANUAL_')).length;
        document.getElementById('status-metrics')!.textContent =
          `${m.attempts} attempts · ${m.candidatesExamined} candidates · ${m.searchMs} ms · soft ${m.softCost.toFixed(1)}${manualCount ? ` · 手动拒绝 ${manualCount}` : ''}`;
        this.renderLeft();
        this.render();
      } catch (err) {
        console.error(err);
        this.setStatus(`求解失败：${(err as Error).message}`);
      } finally {
        this.busy = false;
      }
    }, 16);
  }

  private applyOverrides(base: PlacementResult): PlacementResult {
    const manual = evaluateManual(this.level, this.override, {
      placements: base.placements,
      keys: base.keys,
    });
    return {
      ...base,
      ok: manual.ok,
      placements: manual.placements,
      keys: manual.keys,
      proof: manual.proof,
      conflicts: manual.conflicts,
      metrics: {
        ...base.metrics,
        softCost: base.metrics.softCost,
        hardViolations: manual.conflicts.filter((c) => c.severity === 'hard').length,
        routeLength: manual.proof.route.totalDistance,
      },
    };
  }

  private pickCell(x: number, z: number) {
    if (this.invalid) {
      this.setStatus('不合法场景只用于演示冲突，不会接受手动落位调整。');
      return;
    }
    if (!this.selected) {
      this.setStatus('先在左侧或场景里选中一个任务点，再点击地面移动它。');
      return;
    }
    const id = this.selected;
    const step = this.level.steps.find((s) => s.id === id);
    if (!step) {
      this.setStatus('钥匙为自动选址；选择任务点可手动落位。');
      return;
    }
    this.override[id] = { x, z };
    this.generate();
  }

  private select(id: string | null, focus: boolean) {
    this.selected = id;
    this.viewport.setSelected(id);
    if (id && focus && this.result) {
      const p = this.result.placements.find((x) => x.stepId === id);
      const k = this.result.keys.find((x) => x.keyId === id);
      const pos = p?.objectPos ?? k?.pos;
      if (pos) this.viewport.focusOn(pos);
    }
    if (this.tab === 'spot' || this.tab === 'basis') this.tab = 'basis';
    this.syncTabs();
    this.renderLeft();
    this.render();
  }

  private focusStep(id: string) {
    if (!id) return;
    const p = this.result?.placements.find((x) => x.stepId === id);
    const k = this.result?.keys.find((x) => x.keyId === id);
    const pos = p?.objectPos ?? k?.pos;
    if (pos) this.viewport.focusOn(pos);
  }

  private hoverInfo(x: number, z: number, zoneId: string | null, sx: number, sy: number) {
    const tip = document.getElementById('tooltip')!;
    clear(tip);
    const zone = this.level.zones.find((zz) => zz.id === zoneId);
    tip.append(
      Object.assign(document.createElement('div'), { className: 't-title', textContent: zone ? zone.name : '场景外' }),
      Object.assign(document.createElement('div'), { className: 't-sub', textContent: zone ? zone.notes ?? '' : '单击不会落位' }),
      Object.assign(document.createElement('div'), { className: 't-row', textContent: `x ${x.toFixed(1)}  z ${z.toFixed(1)}` })
    );
    tip.classList.remove('hidden');
    tip.style.left = `${sx + 16}px`;
    tip.style.top = `${sy + 14}px`;
  }

  private hideTooltip() {
    document.getElementById('tooltip')!.classList.add('hidden');
  }

  private setStatus(text: string) {
    document.getElementById('status-text')!.textContent = text;
  }

  private syncTabs() {
    const tabs = document.getElementById('result-tabs')!;
    for (const b of tabs.querySelectorAll('.tab')) {
      b.classList.toggle('active', b.getAttribute('data-tab') === this.tab);
    }
  }

  // ---------------------------------------------------------------- render
  private renderLeft() {
    const list = document.getElementById('step-list')!;
    clear(list);
    for (const s of this.level.steps) {
      list.append(stepCard(this.level, s.id, {
        selected: this.selected === s.id,
        onSelect: (id) => this.select(id, true),
      }));
    }
    const keys = document.getElementById('key-list')!;
    clear(keys);
    for (const k of this.level.keys) {
      const card = document.createElement('div');
      card.className = 'key-card';
      const order = this.result?.proof.route.stops.find((s) => s.id === k.id)?.order;
      card.innerHTML = `
        <div class="name">${order ? `${order}. ` : ''}${k.label} <span class="chip" style="color:var(--key);border-color:#3b2a52">钥匙</span></div>
        <div class="unlocks">打开：${k.unlocks.join(', ')}</div>
        ${k.note ? `<div class="unlocks">${k.note}</div>` : ''}
      `;
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => this.select(k.id, true));
      keys.append(card);
    }

    const cons = document.getElementById('constraint-list')!;
    clear(cons);
    for (const c of this.level.constraints) {
      const card = document.createElement('div');
      card.className = 'constraint-card';
      const bounds = [
        c.minDist !== undefined ? `≥ ${c.minDist} m` : '',
        c.maxDist !== undefined ? `≤ ${c.maxDist} m` : '',
      ].filter(Boolean).join(' · ');
      const impossible = c.minDist !== undefined && c.maxDist !== undefined && c.minDist > c.maxDist;
      card.innerHTML = `
        <div class="top">
          <span class="type ${c.hard ? 'hard' : 'soft'}">${c.hard ? '硬条件' : '偏好'}</span>
          <code>${bounds}</code>
        </div>
        <div>${c.a} ↔ ${c.b}${impossible ? ' <span class="bad-text">（窗口为空）</span>' : ''}</div>
        <div class="dim">${c.note}</div>
      `;
      cons.append(card);
    }

    const badge = document.getElementById('scene-badge')!;
    badge.textContent = this.invalid ? '故意不合法' : 'Amber Reach';
    badge.classList.toggle('fail', this.invalid);
    const note = document.getElementById('scene-note')!;
    note.textContent = this.invalid
      ? '该配置包含：依赖环、硬区域冲突、空距离窗口、钥匙自锁。工具会逐条命名，而不是丢掉支线。'
      : this.level.notes?.[0] ?? '';
  }

  private render() {
    const body = document.getElementById('tab-body')!;
    renderTab(this.tab, body, {
      level: this.level,
      result: this.result,
      selected: this.selected,
      routeIndex: this.routeIndex,
      onSelect: (id) => this.select(id, true),
      onFocus: (id) => {
        this.focusStep(id);
        if (this.tab !== 'basis') {
          this.tab = 'basis';
          this.selected = id;
          this.syncTabs();
          this.renderLeft();
          this.render();
          this.viewport.setSelected(id);
        }
      },
      onRouteIndex: (i) => {
        this.routeIndex = i;
        this.viewport.showResult(this.result, this.selected, this.routeIndex);
        this.render();
      },
      onSeed: (seed) => {
        if (this.invalid) {
          this.setStatus('不合法场景没有成立的种子。');
          return;
        }
        const res = placeLevel(this.level, { seeds: 8, onlySeed: seed });
        this.result = res;
        this.override = {};
        this.selected = null;
        this.viewport.showResult(res, null, null);
        this.renderLeft();
        this.render();
        this.setStatus(`已切换到种子 #${seed}：${res.ok ? '成立' : '失败'}`);
      },
      miniMap: (points, focusZone) => spatialSvg(this.level, points, focusZone),
    });

    const hud = document.getElementById('viewport-hud')!;
    const g = buildGrid(this.level);
    const walkable = g.cells.filter((c) => c?.walkable).length;
    clear(hud);
    hud.innerHTML = `
      <div>场景 <b>${this.level.name.split('—')[0].trim()}</b></div>
      <div>可行走格 <span class="k">${walkable}</span> · 区域 <span class="k">${this.level.zones.length}</span></div>
      <div>出口 <span class="k">单向</span> · 移动 <span class="k">walk only</span></div>
      <div>${this.result ? (this.result.ok ? '证明 <b style="color:#59c98a">成立</b>' : '证明 <b style="color:#ef6b6b">未成立</b>') : '待求解'}</div>
    `;
  }
}

new App();
