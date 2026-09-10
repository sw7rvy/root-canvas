import * as THREE from 'three';
import { Emitter, type Unsubscribe } from './Emitter';
import { disposeScene } from './Disposal';
import { ResourceTracker } from './ResourceTracker';
import { ViewComposer, type EffectsOptions } from './Effects';
import type { RendererCore } from './RendererCore';
import type { PointerPayload } from './PointerPipeline';

export interface ViewRect {
  left: number;
  bottom: number;
  width: number;
  height: number;
  top: number;
  right: number;
}

export interface ViewEvents {
  pointermove: PointerPayload;
  pointerdown: PointerPayload;
  pointerup: PointerPayload;
  pointerenter: PointerPayload;
  pointerleave: PointerPayload;
  click: PointerPayload;
  wheel: PointerPayload;
  resize: { width: number; height: number; view: View };
  visibility: { onScreen: boolean; view: View };
  dispose: { view: View };
}

export interface ViewOptions {
  element: HTMLElement;
  scene?: THREE.Scene;
  camera?: THREE.Camera;
  priority?: number;
  interactive?: boolean;
  clearColor?: THREE.ColorRepresentation | null;
  clearAlpha?: number;
  renderOnlyWhenOnScreen?: boolean;
  disposeSceneOnDestroy?: boolean;
  effects?: EffectsOptions;
  onUpdate?: (delta: number, elapsed: number, view: View) => void;
  onRender?: (renderer: THREE.WebGLRenderer, view: View, delta: number) => void;
}

let viewId = 0;

export class View {
  readonly id = ++viewId;
  readonly element: HTMLElement;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly events = new Emitter<ViewEvents>();
  readonly resources = new ResourceTracker();
  readonly rect: ViewRect = { left: 0, bottom: 0, width: 0, height: 0, top: 0, right: 0 };

  priority: number;
  interactive: boolean;
  enabled = true;
  onScreen = false;

  readonly clearColor: THREE.Color | null;
  readonly clearAlpha: number;
  readonly renderOnlyWhenOnScreen: boolean;

  private readonly disposeSceneOnDestroy: boolean;
  private readonly effectsOptions: EffectsOptions | null;
  private viewComposer: ViewComposer | null = null;
  private readonly updateHook?: ViewOptions['onUpdate'];
  private readonly renderHook?: ViewOptions['onRender'];
  private lastWidth = 0;
  private lastHeight = 0;
  private disposed = false;

  constructor(options: ViewOptions) {
    this.element = options.element;
    this.scene = options.scene ?? new THREE.Scene();
    this.camera = options.camera ?? new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.priority = options.priority ?? 0;
    this.interactive = options.interactive ?? true;
    this.clearColor = options.clearColor == null ? null : new THREE.Color(options.clearColor);
    this.clearAlpha = options.clearAlpha ?? 1;
    this.renderOnlyWhenOnScreen = options.renderOnlyWhenOnScreen ?? true;
    this.disposeSceneOnDestroy = options.disposeSceneOnDestroy ?? true;
    this.effectsOptions = options.effects ?? null;
    this.updateHook = options.onUpdate;
    this.renderHook = options.onRender;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get composer(): ViewComposer | null {
    return this.viewComposer;
  }

  get usesEffects(): boolean {
    return this.effectsOptions !== null;
  }

  on<K extends keyof ViewEvents>(type: K, handler: (payload: ViewEvents[K]) => void): Unsubscribe {
    return this.events.on(type, handler);
  }

  add<T extends THREE.Object3D>(object: T): T {
    this.scene.add(object);
    return this.resources.track(object);
  }

  measure(canvasHeight: number, canvasWidth: number): boolean {
    const box = this.element.getBoundingClientRect();
    this.rect.left = box.left;
    this.rect.top = box.top;
    this.rect.right = box.right;
    this.rect.width = box.width;
    this.rect.height = box.height;
    this.rect.bottom = canvasHeight - box.bottom;

    const visible =
      box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < canvasHeight && box.right > 0 && box.left < canvasWidth;

    if (visible !== this.onScreen) {
      this.onScreen = visible;
      this.events.emit('visibility', { onScreen: visible, view: this });
    }

    if (box.width !== this.lastWidth || box.height !== this.lastHeight) {
      this.lastWidth = box.width;
      this.lastHeight = box.height;
      this.syncCamera(box.width, box.height);
      this.events.emit('resize', { width: box.width, height: box.height, view: this });
    }

    return visible;
  }

  update(delta: number, elapsed: number): void {
    this.updateHook?.(delta, elapsed, this);
  }

  render(renderer: THREE.WebGLRenderer, delta: number, pixelRatio: number): void {
    if (this.renderHook) {
      this.renderHook(renderer, this, delta);
      return;
    }

    if (!this.effectsOptions) {
      renderer.render(this.scene, this.camera);
      return;
    }

    if (!this.viewComposer) this.viewComposer = new ViewComposer(this, renderer, this.effectsOptions);
    this.viewComposer.sync(this.rect.width, this.rect.height, pixelRatio);
    this.viewComposer.render(delta);
  }

  invalidateEffects(): void {
    this.viewComposer?.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.events.emit('dispose', { view: this });
    this.viewComposer?.dispose();
    this.viewComposer = null;
    this.resources.dispose();
    if (this.disposeSceneOnDestroy) disposeScene(this.scene);
    this.events.clear();
  }

  private syncCamera(width: number, height: number): void {
    if (height === 0) return;
    const perspective = this.camera as THREE.PerspectiveCamera;
    if (perspective.isPerspectiveCamera) {
      perspective.aspect = width / height;
      perspective.updateProjectionMatrix();
      return;
    }
    const ortho = this.camera as THREE.OrthographicCamera;
    if (ortho.isOrthographicCamera) {
      const halfHeight = (ortho.top - ortho.bottom) / 2;
      const halfWidth = halfHeight * (width / height);
      ortho.left = -halfWidth;
      ortho.right = halfWidth;
      ortho.updateProjectionMatrix();
    }
  }
}

export class ViewRegistry {
  private views: View[] = [];
  private sortDirty = false;

  add(view: View): View {
    this.views.push(view);
    this.sortDirty = true;
    return view;
  }

  remove(view: View, dispose = true): void {
    const index = this.views.indexOf(view);
    if (index === -1) return;
    this.views.splice(index, 1);
    if (dispose) view.dispose();
  }

  get all(): readonly View[] {
    return this.views;
  }

  hitTest(clientX: number, clientY: number): View | null {
    let match: View | null = null;
    for (const view of this.views) {
      if (!view.enabled || !view.interactive || !view.onScreen) continue;
      const { left, top, right } = view.rect;
      if (clientX < left || clientX > right || clientY < top || clientY > top + view.rect.height) continue;
      if (!match || view.priority >= match.priority) match = view;
    }
    return match;
  }

  measure(core: RendererCore): void {
    const { x: width, y: height } = core.size;
    for (const view of this.views) {
      if (!view.enabled) continue;
      view.measure(height, width);
    }
  }

  render(core: RendererCore, delta: number, elapsed: number): void {
    if (!core.drawable) return;

    if (this.sortDirty) {
      this.views.sort((a, b) => a.priority - b.priority);
      this.sortDirty = false;
    }

    const { renderer } = core;
    const canvasWidth = core.size.x;
    const canvasHeight = core.size.y;

    this.measure(core);
    core.clearFrame();
    renderer.setScissorTest(true);

    for (const view of this.views) {
      if (!view.enabled) continue;
      if (view.renderOnlyWhenOnScreen && !view.onScreen) continue;

      view.update(delta, elapsed);

      const { left, bottom, width, height } = view.rect;
      const scissorX = Math.max(0, left);
      const scissorY = Math.max(0, bottom);
      const scissorW = Math.min(canvasWidth, left + width) - scissorX;
      const scissorH = Math.min(canvasHeight, bottom + height) - scissorY;
      if (scissorW <= 0 || scissorH <= 0) continue;

      renderer.setViewport(left, bottom, width, height);
      renderer.setScissor(scissorX, scissorY, scissorW, scissorH);

      if (view.clearColor) {
        renderer.setClearColor(view.clearColor, view.clearAlpha);
        renderer.clear(true, true, core.stencil);
      } else if (!view.usesEffects) {
        renderer.clearDepth();
      }

      view.render(renderer, delta, core.pixelRatio);
    }

    renderer.setScissorTest(false);
  }

  dispose(): void {
    for (const view of [...this.views]) view.dispose();
    this.views.length = 0;
  }
}
