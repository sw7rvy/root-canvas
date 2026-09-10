import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { disposeScene } from './Disposal';
import type { RendererCore } from './RendererCore';

export interface ApplyEnvironmentOptions {
  background?: boolean;
  intensity?: number;
  backgroundBlurriness?: number;
}

const ROOM_KEY = 'internal:room';

export class EnvironmentManager {
  private pmrem: THREE.PMREMGenerator;
  private targets = new Map<string, THREE.WebGLRenderTarget>();
  private pending = new Map<string, Promise<THREE.Texture>>();
  private consumers = new Map<THREE.Scene, { key: string; options: ApplyEnvironmentOptions }>();
  private unbindRestore: () => void;

  constructor(private readonly core: RendererCore) {
    this.pmrem = this.createGenerator();
    this.unbindRestore = core.events.on('contextrestored', () => this.rebuild());
  }

  room(sigma = 0.04): THREE.Texture {
    const cached = this.targets.get(ROOM_KEY);
    if (cached) return cached.texture;

    const scene = new RoomEnvironment();
    const target = this.pmrem.fromScene(scene, sigma);
    disposeScene(scene);
    this.targets.set(ROOM_KEY, target);
    return target.texture;
  }

  async hdr(url: string): Promise<THREE.Texture> {
    const cached = this.targets.get(url);
    if (cached) return cached.texture;

    const inflight = this.pending.get(url);
    if (inflight) return inflight;

    const request = new RGBELoader()
      .loadAsync(url)
      .then((source) => {
        source.mapping = THREE.EquirectangularReflectionMapping;
        const target = this.pmrem.fromEquirectangular(source);
        source.dispose();
        this.targets.set(url, target);
        this.pending.delete(url);
        return target.texture;
      })
      .catch((error: unknown) => {
        this.pending.delete(url);
        throw error;
      });

    this.pending.set(url, request);
    return request;
  }

  apply(scene: THREE.Scene, texture: THREE.Texture, options: ApplyEnvironmentOptions = {}): void {
    scene.environment = texture;
    scene.environmentIntensity = options.intensity ?? 1;

    if (options.background) {
      scene.background = texture;
      scene.backgroundBlurriness = options.backgroundBlurriness ?? 0;
    }

    const key = this.keyOf(texture);
    if (key) this.consumers.set(scene, { key, options });
  }

  release(scene: THREE.Scene): void {
    scene.environment = null;
    if (scene.background && (scene.background as THREE.Texture).isTexture) scene.background = null;
    this.consumers.delete(scene);
  }

  dispose(): void {
    this.unbindRestore();
    for (const scene of [...this.consumers.keys()]) this.release(scene);
    this.consumers.clear();
    this.disposeTargets();
    this.pending.clear();
    this.pmrem.dispose();
  }

  private createGenerator(): THREE.PMREMGenerator {
    const generator = new THREE.PMREMGenerator(this.core.renderer);
    generator.compileEquirectangularShader();
    return generator;
  }

  private keyOf(texture: THREE.Texture): string | null {
    for (const [key, target] of this.targets) {
      if (target.texture === texture) return key;
    }
    return null;
  }

  private disposeTargets(): void {
    for (const target of this.targets.values()) {
      target.texture.dispose();
      target.dispose();
    }
    this.targets.clear();
  }

  private rebuild(): void {
    const bindings = [...this.consumers.entries()];
    this.disposeTargets();
    this.pmrem.dispose();
    this.pmrem = this.createGenerator();

    for (const [scene, binding] of bindings) {
      if (binding.key === ROOM_KEY) {
        this.apply(scene, this.room(), binding.options);
      } else {
        void this.hdr(binding.key).then((texture) => this.apply(scene, texture, binding.options));
      }
    }
  }
}
