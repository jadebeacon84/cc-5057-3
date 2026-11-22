import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LevelDef, Placement, PlacementResult, Vec3 } from './core/types.ts';
import { buildGrid, cellWorld, worldToIndex } from './core/nav.ts';

export interface ViewportCallbacks {
  onPickCell?: (x: number, z: number, zoneId: string | null) => void;
  onHoverCell?: (x: number, z: number, zoneId: string | null, screenX: number, screenY: number) => void;
  onHoverOff?: () => void;
  onSelectStep?: (stepId: string) => void;
}

const KIND_COLORS: Record<string, number> = {
  hub: 0x2b3345,
  hall: 0x2a3040,
  shrine: 0x332b45,
  cliff: 0x3a3326,
  vault: 0x22353a,
  garden: 0x283a2f,
  tunnel: 0x2c2f3a,
  lab: 0x2f2a3a,
};

const ROLE_COLOR: Record<string, number> = {
  main: 0xf0b35a,
  side: 0x74a9ff,
  key: 0xc88bff,
  exit: 0x6ad3c4,
};

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private host: HTMLElement;
  private walkGroup = new THREE.Group();
  private routeGroup = new THREE.Group();
  private markerGroup = new THREE.Group();
  private overlayGroup = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private walkMeshByIndex = new Map<number, THREE.Mesh>();
  private markerMeshes: Array<{ mesh: THREE.Object3D; stepId?: string; kind: string }> = [];
  private routeLines: THREE.Line[] = [];
  private labelLayer: HTMLDivElement;
  private labels: Array<{ el: HTMLDivElement; pos: THREE.Vector3; group: 'world' | 'markers' }> = [];
  private level: LevelDef | null = null;
  private grid: ReturnType<typeof buildGrid> | null = null;
  private hoverCell: THREE.Mesh | null = null;
  private dragCell: THREE.Mesh | null = null;
  private dragTarget: ((x: number, z: number) => void) | null = null;
  private cameraTarget = new THREE.Vector3();
  private clock = new THREE.Clock();
  private callbacks: ViewportCallbacks;
  private animId = 0;
  private lastHover: { x: number; z: number } | null = null;
  private selected: string | null = null;

  constructor(host: HTMLElement, callbacks: ViewportCallbacks = {}) {
    this.host = host;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'label-layer';
    host.appendChild(this.labelLayer);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090b10);
    this.scene.fog = new THREE.FogExp2(0x090b10, 0.0065);

    this.camera = new THREE.PerspectiveCamera(42, host.clientWidth / host.clientHeight, 0.1, 520);
    this.camera.position.set(0, 62, 52);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 18;
    this.controls.maxDistance = 170;
    this.controls.target.set(0, -0.2, -8);
    this.cameraTarget.set(0, -0.2, -8);
    this.controls.update();

    this.scene.add(this.walkGroup);
    this.scene.add(this.routeGroup);
    this.scene.add(this.markerGroup);
    this.scene.add(this.overlayGroup);

    this.setupLights();
    this.setupGround();
    this.setupEvents();
    this.animate();

    window.addEventListener('resize', () => this.resize());
  }

  private setupLights() {
    const hemi = new THREE.HemisphereLight(0x9fb4d8, 0x1a1712, 0.85);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffe6c0, 1.5);
    key.position.set(-28, 46, 22);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -50;
    key.shadow.camera.right = 50;
    key.shadow.camera.top = 50;
    key.shadow.camera.bottom = -50;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 140;
    key.shadow.bias = -0.0004;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x5a82c8, 0.55);
    rim.position.set(30, 18, -34);
    this.scene.add(rim);
    const warm = new THREE.PointLight(0xffb366, 0.5, 90, 2);
    warm.position.set(14, 8, -30);
    this.scene.add(warm);
  }

  private setupGround() {
    const gridHelper = new THREE.GridHelper(260, 130, 0x1a2232, 0x121822);
    gridHelper.position.y = -2.6;
    this.scene.add(gridHelper);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(260, 260),
      new THREE.MeshStandardMaterial({ color: 0x07090d, roughness: 1, metalness: 0 })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -2.65;
    plane.receiveShadow = true;
    this.scene.add(plane);
  }

  private setupEvents() {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    el.addEventListener('pointerleave', () => {
      this.clearHover();
      this.callbacks.onHoverOff?.();
    });
    let downAt: { x: number; y: number; moved: boolean } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      downAt = { x: e.clientX, y: e.clientY, moved: false };
      const hit = this.pick(e);
      if (!hit) return;
      // Only a marker click changes selection; clicking the floor must not clear
      // the step the designer is about to move.
      if (hit.stepId) this.callbacks.onSelectStep?.(hit.stepId);
      if (this.dragTarget) {
        this.dragCell = this.makeDragCell(hit.x, hit.z);
        this.overlayGroup.add(this.dragCell);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!downAt) return;
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) downAt.moved = true;
    });
    el.addEventListener('pointerup', (e) => {
      const wasClick = downAt !== null && !downAt.moved;
      if (this.dragTarget && this.dragCell) {
        const hit = this.pick(e);
        if (hit) this.dragTarget(hit.x, hit.z);
        this.overlayGroup.remove(this.dragCell);
        this.dragCell.geometry.dispose();
        (this.dragCell.material as THREE.Material).dispose();
        this.dragCell = null;
        this.dragTarget = null;
      } else if (wasClick) {
        // Orbit-control drags must never be reinterpreted as a placement click.
        const hit = this.pick(e);
        if (hit && !hit.stepId) this.callbacks.onPickCell?.(hit.x, hit.z, hit.zoneId);
      }
      downAt = null;
    });
    el.addEventListener('pointercancel', () => {
      if (this.dragCell) {
        this.overlayGroup.remove(this.dragCell);
        this.dragCell.geometry.dispose();
        (this.dragCell.material as THREE.Material).dispose();
        this.dragCell = null;
        this.dragTarget = null;
      }
      downAt = null;
    });
  }

  private makeDragCell(x: number, z: number): THREE.Mesh {
    const geo = new THREE.BoxGeometry(1.1, 0.1, 1.1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xf0b35a, transparent: true, opacity: 0.5 });
    const mesh = new THREE.Mesh(geo, mat);
    const y = this.groundHeightAt(x, z);
    mesh.position.set(x, y + 0.35, z);
    return mesh;
  }

  private groundHeightAt(x: number, z: number): number {
    if (!this.grid) return 0;
    const idx = worldToIndex(this.grid, x, z);
    return this.grid.cells[idx]?.y ?? 0;
  }

  private pick(e: PointerEvent): { x: number; z: number; zoneId: string | null; stepId?: string } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const markerHits = this.raycaster.intersectObjects(this.markerMeshes.map((m) => m.mesh), true);
    if (markerHits.length) {
      let obj: THREE.Object3D | null = markerHits[0].object;
      while (obj && !this.markerMeshes.find((m) => m.mesh === obj)) obj = obj.parent;
      const entry = this.markerMeshes.find((m) => m.mesh === obj);
      if (entry) {
        const p = markerHits[0].point;
        return { x: p.x, z: p.z, zoneId: null, stepId: entry.stepId };
      }
    }

    const walkHits = this.raycaster.intersectObjects([...this.walkMeshByIndex.values()], false);
    if (walkHits.length) {
      const mesh = walkHits[0].object as THREE.Mesh;
      const idx = (mesh.userData.index as number) ?? -1;
      const cell = idx >= 0 ? this.grid?.cells[idx] : null;
      const p = walkHits[0].point;
      return { x: cell?.x ?? p.x, z: cell?.z ?? p.z, zoneId: cell?.zoneId ?? null };
    }
    return null;
  }

  private pickGroundPlane(e: PointerEvent): { x: number; z: number; zoneId: string | null; stepId?: string } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, point)) return null;
    return { x: point.x, z: point.z, zoneId: null };
  }

  private onPointerMove(e: PointerEvent) {
    const hit = this.pick(e) ?? this.pickGroundPlane(e);
    this.clearHover();
    if (!hit) {
      this.renderer.domElement.style.cursor = 'default';
      this.callbacks.onHoverOff?.();
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.callbacks.onHoverCell?.(
      hit.x,
      hit.z,
      hit.zoneId,
      e.clientX - rect.left,
      e.clientY - rect.top
    );
    if (hit.stepId) {
      this.renderer.domElement.style.cursor = 'pointer';
      return;
    }
    this.renderer.domElement.style.cursor = 'crosshair';
    if (this.grid) {
      const idx = worldToIndex(this.grid, hit.x, hit.z);
      const cell = this.grid.cells[idx];
      if (cell && cell.walkable) {
        const geo = new THREE.BoxGeometry(1, 0.04, 1);
        const mat = new THREE.MeshBasicMaterial({
          color: cell.zoneId ? 0x6ad3c4 : 0x4a5a78,
          transparent: true,
          opacity: 0.35,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(cell.x, cell.y + 0.03, cell.z);
        this.overlayGroup.add(mesh);
        this.hoverCell = mesh;
      }
    }
  }

  private clearHover() {
    if (this.hoverCell) {
      this.overlayGroup.remove(this.hoverCell);
      this.hoverCell.geometry.dispose();
      (this.hoverCell.material as THREE.Material).dispose();
      this.hoverCell = null;
    }
  }

  beginDrag(x: number, z: number, onDrop: (x: number, z: number) => void) {
    this.dragTarget = onDrop;
    const cell = this.makeDragCell(x, z);
    this.overlayGroup.add(cell);
    this.dragCell = cell;
  }

  resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate() {
    this.animId = requestAnimationFrame(() => this.animate());
    const t = this.clock.getElapsedTime();
    this.controls.update();
    // Gentle marker float.
    this.markerGroup.children.forEach((g) => {
      if (g.userData.float) {
        g.position.y = g.userData.baseY + Math.sin(t * 1.7 + (g.userData.phase ?? 0)) * 0.14;
      }
    });
    for (const line of this.routeLines) {
      const mat = line.material as THREE.LineDashedMaterial;
      if (mat.dashSize) {
        (mat as unknown as { dashOffset?: number }).dashOffset = -t * 1.2;
      }
    }
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
  }

  private addLabel(pos: Vec3, text: string, color: string, group: 'world' | 'markers', cls: string) {
    const el = document.createElement('div');
    el.className = `scene-label ${cls}`;
    el.textContent = text;
    el.style.color = color;
    this.labelLayer.appendChild(el);
    this.labels.push({ el, pos: new THREE.Vector3(pos[0], pos[1], pos[2]), group });
  }

  private clearLabels(group: 'world' | 'markers') {
    this.labels = this.labels.filter((l) => {
      if (l.group === group) {
        l.el.remove();
        return false;
      }
      return true;
    });
  }

  private updateLabels() {
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    const v = new THREE.Vector3();
    for (const label of this.labels) {
      v.copy(label.pos).project(this.camera);
      if (v.z > 1 || v.z < -1) {
        label.el.style.display = 'none';
        continue;
      }
      label.el.style.display = '';
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      label.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  dispose() {
    cancelAnimationFrame(this.animId);
    this.renderer.dispose();
    this.host.removeChild(this.renderer.domElement);
  }

  // ------------------------------------------------------------ scene build

  buildScene(level: LevelDef) {
    this.level = level;
    this.grid = buildGrid(level);
    this.clearGroup(this.walkGroup);
    this.clearLabels('world');
    this.walkMeshByIndex.clear();

    const walkMat = new THREE.MeshStandardMaterial({
      color: 0x2b3446,
      roughness: 0.95,
      metalness: 0.05,
    });
    const byZone = new Map<string, THREE.Mesh[]>();
    const zonesById = new Map(level.zones.map((z) => [z.id, z]));

    // Batched floor cells per zone.
    const cellGeos = new Map<number, THREE.BoxGeometry>();
    for (let i = 0; i < this.grid.cells.length; i++) {
      const c = this.grid.cells[i];
      if (!c || !c.walkable) continue;
      const geo = new THREE.BoxGeometry(0.98, 0.3, 0.98);
      const zone = c.zoneId ? zonesById.get(c.zoneId) : null;
      const color = zone ? KIND_COLORS[zone.kind] ?? 0x2b3446 : 0x2b3446;
      const mat = walkMat.clone();
      mat.color.setHex(color);
      // Slight per-zone noise so the floor isn't a flat slab.
      mat.color.offsetHSL(0, 0, ((i * 7919) % 100) / 100 * 0.02 - 0.01);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(c.x, c.y - 0.15, c.z);
      mesh.receiveShadow = true;
      mesh.userData.index = i;
      this.walkGroup.add(mesh);
      this.walkMeshByIndex.set(i, mesh);
      if (c.zoneId) {
        if (!byZone.has(c.zoneId)) byZone.set(c.zoneId, []);
        byZone.get(c.zoneId)!.push(mesh);
      }
      if (c.linkId) {
        // Tint links (stairs/ramps) subtly so the height transition reads.
        const lmat = mesh.material as THREE.MeshStandardMaterial;
        lmat.color.setHex(0x3b4555);
      }
      void geo;
    }
    void cellGeos;

    // Zone outlines + labels.
    for (const zone of level.zones) {
      const [x0, z0, x1, z1] = zone.rect;
      const w = x1 - x0;
      const d = z1 - z0;
      const shape = new THREE.Shape([
        new THREE.Vector2(x0, z0),
        new THREE.Vector2(x1, z0),
        new THREE.Vector2(x1, z1),
        new THREE.Vector2(x0, z1),
      ]);
      for (const cut of zone.cuts ?? []) {
        const hole = new THREE.Path([
          new THREE.Vector2(cut[0], cut[1]),
          new THREE.Vector2(cut[2], cut[1]),
          new THREE.Vector2(cut[2], cut[3]),
          new THREE.Vector2(cut[0], cut[3]),
        ]);
        shape.holes.push(hole);
      }
      const lineGeo = new THREE.BufferGeometry().setFromPoints(
        shape.getPoints(8).map((p) => new THREE.Vector3(p.x, zone.floorY + 0.02, p.y))
      );
      const lineMat = new THREE.LineBasicMaterial({
        color: zone.exit ? 0x6ad3c4 : 0x3c4a63,
        transparent: true,
        opacity: zone.exit ? 0.85 : 0.5,
      });
      const outline = new THREE.LineLoop(lineGeo, lineMat);
      this.walkGroup.add(outline);

      this.addLabel(
        [x0 + w * 0.5, zone.floorY + 1.1, z0 + 0.5],
        zone.name,
        zone.exit ? '#6ad3c4' : '#8e9bb3',
        'world',
        'zone-label'
      );

      if (zone.exit) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(2.6, 0.09, 8, 48),
          new THREE.MeshBasicMaterial({ color: 0x6ad3c4, transparent: true, opacity: 0.75 })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(x0 + w / 2, zone.floorY + 0.15, z0 + d * 0.5);
        this.walkGroup.add(ring);
      }
    }

    // Links as ribbons that show the real slope.
    for (const link of level.links) {
      const pts = link.polyline.map((p) => new THREE.Vector3(p[0], p[1] + 0.12, p[2]));
      if (pts.length >= 2) {
        const curve = new THREE.CatmullRomCurve3(pts);
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(curve, Math.max(8, pts.length * 6), 0.07, 6, false),
          new THREE.MeshBasicMaterial({
            color: link.gate ? 0xc88bff : 0x6ad3c4,
            transparent: true,
            opacity: 0.5,
          })
        );
        this.walkGroup.add(tube);
      }
      if (link.gate) {
        const n = link.polyline.length;
        const mid = link.polyline[Math.floor(n / 2)];
        const a = link.polyline[0];
        const bpt = link.polyline[n - 1];
        const dx = bpt[0] - a[0];
        const dz = bpt[2] - a[2];
        const len = Math.hypot(dx, dz) || 1;
        this.addLabel(
          [mid[0] + (-dz / len) * 3.4, mid[1] + 0.8, mid[2] + (dx / len) * 3.4],
          link.gate,
          '#c88bff',
          'world',
          'gate-label'
        );
      }
    }

    // Props.
    for (const prop of level.props) {
      const [x0, z0, x1, z1] = prop.rect;
      const w = Math.max(0.1, x1 - x0);
      const d = Math.max(0.1, z1 - z0);
      const h = prop.height;
      const color =
        prop.kind === 'pillar' ? 0x384253 :
        prop.kind === 'rubble' ? 0x3a3733 :
        prop.kind === 'lava' ? 0x8a3b1f :
        prop.kind === 'water' ? 0x21455a :
        prop.kind === 'beam' ? 0x4a4030 :
        0x333c4d;
      const y = this.avFloorY(x0, z0, x1, z1);
      if (prop.kind === 'pillar') {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(Math.min(w, d) * 0.42, Math.min(w, d) * 0.5, h, 10),
          new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
        );
        mesh.position.set((x0 + x1) / 2, y + h / 2, (z0 + z1) / 2);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.walkGroup.add(mesh);
      } else if (prop.door) {
        // Two wall segments around a doorway.
        const horizontal = w >= d;
        if (horizontal) {
          const mid = x0 + w * prop.door.at;
          const half = w * prop.door.width * 0.5;
          this.addBox(x0, z0, mid - half, z1, h, y, color);
          this.addBox(mid + half, z0, x1, z1, h, y, color);
        } else {
          const mid = z0 + d * prop.door.at;
          const half = d * prop.door.width * 0.5;
          this.addBox(x0, z0, x1, mid - half, h, y, color);
          this.addBox(x0, mid + half, x1, z1, h, y, color);
        }
      } else {
        this.addBox(x0, z0, x1, z1, h, y, color);
      }
    }

    // Gate bars, closed by default and visually explicit.
    for (const link of level.links) {
      if (!link.gate) continue;
      const mid = link.polyline[Math.floor(link.polyline.length / 2)];
      const bars = new THREE.Group();
      for (let i = -2; i <= 2; i++) {
        const bar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.06, 2.2, 6),
          new THREE.MeshStandardMaterial({
            color: 0xc88bff,
            emissive: 0x5a2c8a,
            emissiveIntensity: 0.6,
            metalness: 0.5,
            roughness: 0.4,
          })
        );
        bar.position.set(mid[0] + i * 0.35, mid[1] + 1.1, mid[2]);
        bars.add(bar);
      }
      this.walkGroup.add(bars);
    }

    // Entry marker.
    const entryRing = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.15, 32),
      new THREE.MeshBasicMaterial({ color: 0xe8ecf4, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    entryRing.rotation.x = -Math.PI / 2;
    entryRing.position.set(level.entry[0], level.entry[2] * 0 + this.groundHeightAt(level.entry[0], level.entry[2]) + 0.1, level.entry[2]);
    this.walkGroup.add(entryRing);
    this.addLabel(
      [level.entry[0], this.groundHeightAt(level.entry[0], level.entry[2]) + 1.2, level.entry[2]],
      'ENTRY',
      '#cfd7e6',
      'world',
      'entry-label'
    );

    // Camera framing: fit the bounding sphere of all zone corners so nothing
    // is cropped, in a 3/4 overhead view.
    const b = this.sceneBounds(level);
    this.controls.target.set(b.cx, -0.4, b.cz);
    const radius = Math.sqrt(b.width * b.width + b.depth * b.depth) * 0.475 + 4;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = Math.max(0.6, this.camera.aspect);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const fitFov = Math.min(vFov, hFov);
    const dist = (radius / Math.sin(fitFov / 2)) * 1.06;
    const dir = new THREE.Vector3(0.62, 1.15, 0.86).normalize();
    this.camera.position.set(
      b.cx + dir.x * dist,
      -0.4 + dir.y * dist,
      b.cz + dir.z * dist
    );
    this.controls.minDistance = Math.max(16, radius * 0.5);
    this.controls.maxDistance = Math.max(240, dist * 2.6);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private sceneBounds(level: LevelDef): { cx: number; cz: number; depth: number; width: number } {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const z of level.zones) {
      x0 = Math.min(x0, z.rect[0]); z0 = Math.min(z0, z.rect[1]);
      x1 = Math.max(x1, z.rect[2]); z1 = Math.max(z1, z.rect[3]);
    }
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, depth: z1 - z0, width: x1 - x0 };
  }

  private avFloorY(x0: number, z0: number, x1: number, z1: number): number {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    return this.groundHeightAt(cx, cz);
  }

  private addBox(x0: number, z0: number, x1: number, z1: number, h: number, y: number, color: number) {
    const w = Math.max(0.08, x1 - x0);
    const d = Math.max(0.08, z1 - z0);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.05 })
    );
    mesh.position.set((x0 + x1) / 2, y + h / 2, (z0 + z1) / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.walkGroup.add(mesh);
  }

  // -------------------------------------------------------------- overlays

  /**
   * Rebuild quest objects + route. Results come from the solver; this method
   * never computes placement itself, so the visible layout is always the one
   * that was verified.
   */
  showResult(result: PlacementResult | null, highlight?: string | null, routeIndex?: number | null) {
    this.clearGroup(this.markerGroup);
    this.clearGroup(this.routeGroup);
    this.clearLabels('markers');
    this.markerMeshes = [];
    this.routeLines = [];
    if (!result || !this.grid) return;

    const level = result.level;
    const grid = this.grid;

    const visitOrder = new Map<string, number>();
    const visitZone = new Map<string, string>();
    const visitState = new Map<string, string>();
    result.proof.route.stops.forEach((s, i) => {
      visitOrder.set(s.id, i + 1);
      visitZone.set(s.id, s.zoneId);
      visitState.set(s.id, s.reachState);
    });

    // Step markers.
    for (const p of result.placements) {
      const step = level.steps.find((s) => s.id === p.stepId);
      if (!step) continue;
      const isExitStep = level.zones.find((z) => z.id === p.zoneId)?.exit;
      const color = isExitStep ? ROLE_COLOR.exit : ROLE_COLOR[step.role];
      const marker = this.makeMarker(p.objectPos, color, step.role === 'side' ? 0.5 : 0.62);
      marker.userData = {
        float: true,
        baseY: p.objectPos[1] + 1.5,
        phase: (visitOrder.get(p.stepId) ?? 0) * 0.7,
      };
      marker.position.y = p.objectPos[1] + 1.5;
      const order = visitOrder.get(p.stepId) ?? '?';
      this.addLabel(
        [p.objectPos[0], p.objectPos[1] + 2.05, p.objectPos[2]],
        `${order}. ${step.id}`,
        step.role === 'main' ? '#f0b35a' : '#74a9ff',
        'markers',
        `marker-label ${step.role}`
      );
      // Interaction radius ring (hard constraint visual).
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(step.interaction.radius - 0.04, step.interaction.radius, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.objectPos[0], p.objectPos[1] + 0.04, p.objectPos[2]);
      marker.add(ring);
      // Approach cell link.
      const link = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(p.objectPos[0], p.objectPos[1] + 0.06, p.objectPos[2]),
          new THREE.Vector3(p.approachPos[0], p.approachPos[1] + 0.06, p.approachPos[2]),
        ]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 })
      );
      marker.add(link);
      if (highlight === p.stepId) {
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(1.2, 1.55, 40),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
        );
        halo.rotation.x = -Math.PI / 2;
        halo.position.y = 0.06;
        marker.add(halo);
      }
      this.markerGroup.add(marker);
      this.markerMeshes.push({ mesh: marker, stepId: p.stepId, kind: 'step' });
    }

    // Key markers.
    for (const k of result.keys) {
      const marker = this.makeMarker(k.pos, ROLE_COLOR.key, 0.45);
      marker.userData = { float: true, baseY: k.pos[1] + 1.2, phase: 2 };
      marker.position.y = k.pos[1] + 1.2;
      const order = visitOrder.get(k.keyId) ?? '?';
      this.addLabel(
        [k.pos[0], k.pos[1] + 1.7, k.pos[2]],
        `${order}. ${k.keyId}`,
        '#c88bff',
        'markers',
        'marker-label key'
      );
      this.markerGroup.add(marker);
      this.markerMeshes.push({ mesh: marker, stepId: k.keyId, kind: 'key' });
    }

    // Exit marker.
    const exitStop = result.proof.route.stops.find((s) => s.kind === 'exit');
    const exitPos = exitStop ? exitStop.pos : level.exitPoint;
    const exitMarker = this.makeMarker(exitPos, ROLE_COLOR.exit, 0.7);
    this.addLabel(
      [exitPos[0], exitPos[1] + 2.0, exitPos[2]],
      'EXIT · one-way',
      '#6ad3c4',
      'markers',
      'marker-label exit'
    );
    this.markerGroup.add(exitMarker);
    this.markerMeshes.push({ mesh: exitMarker, kind: 'exit' });

    // Route polyline, drawn from the verified legs.
    const legs = result.proof.route.legs;
    const showLegs = routeIndex === null || routeIndex === undefined ? legs.length : Math.min(legs.length, routeIndex + 1);
    for (let i = 0; i < showLegs; i++) {
      const leg = legs[i];
      if (leg.points.length < 2) continue;
      const pts = leg.points.map((p) => new THREE.Vector3(p[0], p[1] + 0.22, p[2]));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineDashedMaterial({
        color: 0xf0b35a,
        dashSize: 0.7,
        gapSize: 0.35,
        transparent: true,
        opacity: 0.85,
      });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      this.routeGroup.add(line);
      this.routeLines.push(line);

      // Ground footprint shadow of the route.
      const shadowPts = leg.points.map((p) => new THREE.Vector3(p[0], p[1] + 0.05, p[2]));
      const sgeo = new THREE.BufferGeometry().setFromPoints(shadowPts);
      const shadow = new THREE.Line(
        sgeo,
        new THREE.LineBasicMaterial({ color: 0xf0b35a, transparent: true, opacity: 0.16 })
      );
      this.routeGroup.add(shadow);
    }

    // Stop dots on the route.
    for (const stop of result.proof.route.stops) {
      if (stop.kind === 'exit') continue;
      const color =
        stop.kind === 'key' ? ROLE_COLOR.key : stop.role === 'side' ? ROLE_COLOR.side : ROLE_COLOR.main;
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 12, 10),
        new THREE.MeshBasicMaterial({ color })
      );
      dot.position.set(stop.standPos[0], stop.standPos[1] + 0.25, stop.standPos[2]);
      this.routeGroup.add(dot);
    }

    void visitZone;
    void visitState;
    void grid;
  }

  setSelected(stepId: string | null) {
    this.selected = stepId;
    for (const entry of this.markerMeshes) {
      entry.mesh.scale.setScalar(entry.stepId && entry.stepId === stepId ? 1.45 : 1);
    }
  }

  focusOn(pos: Vec3) {
    const target = new THREE.Vector3(pos[0], pos[1], pos[2]);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const distance = 34;
    this.controls.target.copy(target);
    this.camera.position.copy(target.clone().add(dir.multiplyScalar(distance)));
    this.controls.update();
  }

  private makeMarker(pos: Vec3, color: number, size: number): THREE.Group {
    const group = new THREE.Group();
    group.position.set(pos[0], pos[1], pos[2]);
    const geo = new THREE.OctahedronGeometry(size, 0);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.55,
      metalness: 0.3,
      roughness: 0.25,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    group.add(mesh);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 1, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 })
    );
    stem.position.y = -0.5;
    group.add(stem);
    const base = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.34, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = -size - 0.9;
    group.add(base);
    return group;
  }

  private clearGroup(group: THREE.Group) {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i];
      group.remove(child);
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    }
  }
}
