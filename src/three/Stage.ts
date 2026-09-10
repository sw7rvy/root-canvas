import * as THREE from 'three';
import { RendererCore, type RendererCoreOptions } from './RendererCore';
import { View, ViewRegistry, type ViewOptions } from './View';
import { PointerPipeline } from './PointerPipeline';
import { EnvironmentManager } from './Environment';
import type { Unsubscribe } from './Emitter';

export interface StageOptions extends RendererCoreOptions {
  autoStart?: boolean;
  pauseWhenHidden?: boolean;
  maxDelta?: number;
}

export type FrameCallback = (delta: number, elapsed: number) => void;

export class Stage {
  readonly core: RendererCore;
  readonly views = new ViewRegistry();
  readonly pointer: PointerPipeline;
  readonly environment: EnvironmentManager;

  private readonly clock = new THREE.Clock(false);
  private readonly maxDelta: number;
  private readonly pauseWhenHidden: boolean;
  private readonly beforeRender = new Set<FrameCallback>();
  private readonly afterRender = new Set<FrameCallback>();
  private unbind: Unsubscribe[] = [];
  private frame = 0;
  private running = false;
  private destroyed = false;

  constructor(options: StageOptions = {}) {
    this.core = RendererCore.init(options);
    this.pointer = new PointerPipeline(this.views);
    this.environment = new EnvironmentManager(this.core);
    this.maxDelta = options.maxDelta ?? 1 / 20;
    this.pauseWhenHidden = options.pauseWhenHidden ?? true;

    this.pointer.attach();

    this.unbind.push(
      this.core.events.on('contextlost', () => this.stop()),
      this.core.events.on('contextrestored', () => {
        for (const view of this.views.all) view.invalidateEffects();
        this.start();
      }),
    );

    if (this.pauseWhenHidden) document.addEventListener('visibilitychange', this.onVisibilityChange);
    if (options.autoStart !== false) this.start();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  createView(options: ViewOptions): View {
    return this.views.add(new View(options));
  }

  removeView(view: View, dispose = true): void {
    this.views.remove(view, dispose);
  }

  onBeforeRender(callback: FrameCallback): Unsubscribe {
    this.beforeRender.add(callback);
    return () => {
      this.beforeRender.delete(callback);
    };
  }

  onAfterRender(callback: FrameCallback): Unsubscribe {
    this.afterRender.add(callback);
    return () => {
      this.afterRender.delete(callback);
    };
  }

  start(): void {
    if (this.running || this.destroyed || this.core.contextLost) return;
    this.running = true;
    this.clock.start();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clock.stop();
    cancelAnimationFrame(this.frame);
  }

  renderOnce(): void {
    this.views.render(this.core, 0, this.clock.elapsedTime);
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    for (const off of this.unbind) off();
    this.unbind = [];
    this.beforeRender.clear();
    this.afterRender.clear();
    this.pointer.dispose();
    this.environment.dispose();
    this.views.dispose();
    this.core.dispose();
  }

  private tick = (): void => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.tick);

    const delta = Math.min(this.clock.getDelta(), this.maxDelta);
    const elapsed = this.clock.elapsedTime;

    for (const callback of this.beforeRender) callback(delta, elapsed);
    this.views.render(this.core, delta, elapsed);
    for (const callback of this.afterRender) callback(delta, elapsed);
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };
}

let active: Stage | null = null;

export function createStage(options: StageOptions = {}): Stage {
  if (!active || active.isDestroyed) active = new Stage(options);
  return active;
}

export function getStage(): Stage {
  if (!active) throw new Error('[Stage] not created - call createStage() first');
  return active;
}

export function destroyStage(): void {
  active?.dispose();
  active = null;
}
