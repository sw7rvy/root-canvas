import * as THREE from 'three';
import { Emitter } from './Emitter';
import { detectCapabilities } from './Capabilities';

export interface RendererCoreOptions {
  canvas?: HTMLCanvasElement;
  container?: HTMLElement;
  maxPixelRatio?: number;
  antialias?: boolean;
  alpha?: boolean;
  exposure?: number;
  toneMapping?: THREE.ToneMapping;
  shadows?: boolean;
  shadowType?: THREE.ShadowMapType;
  stencil?: boolean;
  powerPreference?: WebGLPowerPreference;
  zIndex?: number;
}

export interface RendererCoreEvents {
  resize: { width: number; height: number; pixelRatio: number };
  contextlost: { core: RendererCore };
  contextrestored: { core: RendererCore };
  dispose: { core: RendererCore };
}

const DEFAULTS = {
  maxPixelRatio: 2,
  antialias: true,
  alpha: true,
  exposure: 1,
  toneMapping: THREE.ACESFilmicToneMapping,
  shadows: true,
  shadowType: THREE.PCFSoftShadowMap,
  stencil: true,
  powerPreference: 'high-performance' as WebGLPowerPreference,
  zIndex: 0,
};

export class RendererCore {
  private static current: RendererCore | null = null;

  static init(options: RendererCoreOptions = {}): RendererCore {
    if (!RendererCore.current) RendererCore.current = new RendererCore(options);
    return RendererCore.current;
  }

  static get instance(): RendererCore {
    if (!RendererCore.current) throw new Error('[RendererCore] not initialised — call RendererCore.init() first');
    return RendererCore.current;
  }

  static get initialised(): boolean {
    return RendererCore.current !== null;
  }

  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly events = new Emitter<RendererCoreEvents>();
  readonly size = new THREE.Vector2(1, 1);
  readonly stencil: boolean;

  contextLost = false;

  private readonly maxPixelRatio: number;
  private readonly ownsCanvas: boolean;
  private resizeObserver: ResizeObserver | null = null;
  private dprQuery: MediaQueryList | null = null;
  private disposed = false;

  private constructor(options: RendererCoreOptions) {
    const config = { ...DEFAULTS, ...options };
    this.maxPixelRatio = config.maxPixelRatio;
    this.stencil = config.stencil;
    this.container = options.container ?? document.body;

    this.ownsCanvas = !options.canvas;
    this.canvas = options.canvas ?? document.createElement('canvas');

    if (this.ownsCanvas) {
      Object.assign(this.canvas.style, {
        position: 'fixed',
        inset: '0',
        width: '100%',
        height: '100%',
        display: 'block',
        pointerEvents: 'none',
        zIndex: String(config.zIndex),
      } satisfies Partial<CSSStyleDeclaration>);
      this.container.appendChild(this.canvas);
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: config.antialias,
      alpha: config.alpha,
      powerPreference: config.powerPreference,
      stencil: config.stencil,
      depth: true,
      preserveDrawingBuffer: false,
    });

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = config.toneMapping;
    this.renderer.toneMappingExposure = config.exposure;
    this.renderer.shadowMap.enabled = config.shadows;
    this.renderer.shadowMap.type = config.shadowType;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 0);

    detectCapabilities(this.renderer);

    this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    this.applyPixelRatio();
    this.watchPixelRatio();
    this.resize();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.ownsCanvas ? document.documentElement : this.canvas);
    }
    window.addEventListener('resize', this.onWindowResize, { passive: true });
    window.visualViewport?.addEventListener('resize', this.onWindowResize, { passive: true });
  }

  get pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
  }

  get drawable(): boolean {
    return !this.disposed && !this.contextLost;
  }

  setExposure(value: number): void {
    this.renderer.toneMappingExposure = value;
  }

  resize(): void {
    if (this.disposed) return;

    const width = this.ownsCanvas ? window.innerWidth : this.canvas.clientWidth;
    const height = this.ownsCanvas ? window.innerHeight : this.canvas.clientHeight;
    if (width === 0 || height === 0) return;

    this.size.set(width, height);
    this.renderer.setSize(width, height, false);
    this.events.emit('resize', { width, height, pixelRatio: this.pixelRatio });
  }

  clearFrame(): void {
    if (!this.drawable) return;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.size.x, this.size.y);
    this.renderer.setScissor(0, 0, this.size.x, this.size.y);
    this.renderer.clear(true, true, this.stencil);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.events.emit('dispose', { core: this });

    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.dprQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    window.visualViewport?.removeEventListener('resize', this.onWindowResize);

    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();

    if (this.ownsCanvas) this.canvas.remove();
    this.events.clear();

    if (RendererCore.current === this) RendererCore.current = null;
  }

  private applyPixelRatio(): void {
    this.renderer.setPixelRatio(this.pixelRatio);
  }

  private watchPixelRatio(): void {
    if (typeof window.matchMedia !== 'function') return;
    this.dprQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onPixelRatioChange, { once: true });
  }

  private onPixelRatioChange = (): void => {
    if (this.disposed) return;
    this.applyPixelRatio();
    this.watchPixelRatio();
    this.resize();
  };

  private onWindowResize = (): void => this.resize();

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.events.emit('contextlost', { core: this });
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    detectCapabilities(this.renderer);
    this.applyPixelRatio();
    this.renderer.shadowMap.needsUpdate = true;
    this.resize();
    this.events.emit('contextrestored', { core: this });
  };
}
