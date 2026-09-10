import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SavePass } from 'three/examples/jsm/postprocessing/SavePass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { TAAPass, type TAAOptions } from './TAAPass';
import { clampSamples, preferredTargetType } from './Capabilities';
import type { View } from './View';

const AlphaRestoreShader = {
  name: 'AlphaRestoreShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tSource: { value: null as THREE.Texture | null },
    spill: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tSource;
    uniform float spill;
    varying vec2 vUv;
    void main() {
      vec4 post = texture2D( tDiffuse, vUv );
      vec4 source = texture2D( tSource, vUv );
      float added = max( 0.0, dot( post.rgb - source.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) );
      gl_FragColor = vec4( post.rgb, clamp( source.a + added * spill, 0.0, 1.0 ) );
    }
  `,
};

export interface EffectPassContext {
  view: View;
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  renderPass: RenderPass;
  width: number;
  height: number;
  useSceneDepth: (consumer: DepthConsumer) => void;
}

export type DepthConsumer = (depthTexture: THREE.DepthTexture) => void;

export interface FrameHooks {
  onBeforeComposerRender?: (renderer: THREE.WebGLRenderer, delta: number) => void;
  onAfterComposerRender?: (renderer: THREE.WebGLRenderer, delta: number) => void;
  reset?: () => void;
}

export type EffectPassFactory = (context: EffectPassContext) => Pass | Pass[] | void;

export interface EffectsOptions {
  passes?: EffectPassFactory;
  output?: boolean;
  blend?: boolean;
  preserveAlpha?: boolean;
  alphaSpill?: number;
  samples?: number;
  type?: THREE.TextureDataType;
  depthTexture?: boolean;
  stencil?: boolean;
  taa?: boolean | TAAOptions;
  resolutionScale?: number;
}

interface MaterialCarrier {
  material?: THREE.Material;
}

export class ViewComposer {
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly outputPass: OutputPass | null;
  readonly savePass: SavePass | null;
  readonly alphaPass: ShaderPass | null;
  readonly taaPass: TAAPass | null;

  private readonly target: THREE.WebGLRenderTarget;
  private readonly owned: Pass[] = [];
  private readonly depthConsumers: DepthConsumer[] = [];
  private readonly hasDepthTexture: boolean;
  private readonly blend: boolean;
  private readonly scale: number;
  private width = 0;
  private height = 0;
  private ratio = 0;
  private disposed = false;

  constructor(view: View, renderer: THREE.WebGLRenderer, options: EffectsOptions = {}) {
    this.blend = options.blend ?? true;
    this.scale = options.resolutionScale ?? 1;

    const stencil = options.stencil ?? renderer.getContext().getContextAttributes()?.stencil ?? false;
    const taa = options.taa === true ? {} : options.taa || null;
    const wantsDepth = options.depthTexture === true || taa !== null;

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: preferredTargetType(options.type),
      samples: clampSamples(options.samples ?? 0),
      depthBuffer: true,
      stencilBuffer: stencil,
    });
    this.target.texture.name = `View${view.id}.effects`;

    this.hasDepthTexture = wantsDepth;

    if (wantsDepth) {
      const depth = stencil
        ? new THREE.DepthTexture(1, 1, THREE.UnsignedInt248Type)
        : new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
      if (stencil) depth.format = THREE.DepthStencilFormat;
      this.target.depthTexture = depth;
    }

    this.composer = new EffectComposer(renderer, this.target);
    this.composer.renderToScreen = true;

    this.renderPass = new RenderPass(view.scene, view.camera);
    this.renderPass.clearColor = view.clearColor ?? new THREE.Color(0x000000);
    this.renderPass.clearAlpha = view.clearColor ? view.clearAlpha : 0;
    this.addPass(this.renderPass);

    if (options.preserveAlpha) {
      this.savePass = new SavePass(
        new THREE.WebGLRenderTarget(1, 1, {
          type: preferredTargetType(options.type),
          depthBuffer: false,
          stencilBuffer: false,
        }),
      );
      this.savePass.renderTarget.texture.name = `View${view.id}.source`;
      this.addPass(this.savePass);
    } else {
      this.savePass = null;
    }

    const extra = options.passes?.({
      view,
      scene: view.scene,
      camera: view.camera,
      renderer,
      composer: this.composer,
      renderPass: this.renderPass,
      width: view.rect.width,
      height: view.rect.height,
      useSceneDepth: (consumer) => this.depthConsumers.push(consumer),
    });

    if (this.depthConsumers.length > 0 && !this.hasDepthTexture) {
      console.warn(
        `[ViewComposer] view ${view.id} has a pass that reads scene depth; set effects.depthTexture = true`,
      );
    }

    if (this.depthConsumers.length > 0 && (options.samples ?? 0) > 0) {
      console.warn(
        `[ViewComposer] view ${view.id} combines samples with passes that read scene depth. ` +
          'The multisampled depth is resolved on every read, which measured ~27x slower than the ' +
          'same chain without MSAA. TAA already anti-aliases; prefer one or the other.',
      );
    }
    if (extra) {
      for (const pass of Array.isArray(extra) ? extra : [extra]) this.addPass(pass);
    }

    if (this.savePass) {
      this.alphaPass = new ShaderPass(AlphaRestoreShader);
      this.alphaPass.uniforms['tSource'] = { value: this.savePass.renderTarget.texture };
      this.alphaPass.uniforms['spill'] = { value: options.alphaSpill ?? 1 };
      this.addPass(this.alphaPass);
    } else {
      this.alphaPass = null;
    }

    if (taa) {
      this.taaPass = new TAAPass(view.scene, view.camera, taa);
      this.depthConsumers.push((depthTexture) => this.taaPass?.setDepthTexture(depthTexture));
      this.addPass(this.taaPass);
    } else {
      this.taaPass = null;
    }

    this.outputPass = options.output === false ? null : new OutputPass();
    if (this.outputPass) this.addPass(this.outputPass);

    this.refreshBlend();
  }

  get passes(): readonly Pass[] {
    return this.composer.passes;
  }

  addPass(pass: Pass): Pass {
    this.composer.addPass(pass);
    this.owned.push(pass);
    return pass;
  }

  insertPass(pass: Pass, index: number): Pass {
    this.composer.insertPass(pass, index);
    this.owned.push(pass);
    return pass;
  }

  sync(width: number, height: number, pixelRatio: number): void {
    const ratio = pixelRatio * this.scale;
    if (width === this.width && height === this.height && ratio === this.ratio) return;
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
  }

  invalidate(): void {
    this.width = 0;
    this.height = 0;
    this.ratio = 0;
    for (const pass of this.owned) (pass as Partial<FrameHooks>).reset?.();
  }

  render(delta: number): void {
    if (this.disposed) return;

    if (this.depthConsumers.length > 0) {
      const depthTexture = (this.composer.readBuffer as THREE.WebGLRenderTarget).depthTexture;
      if (depthTexture) {
        for (const consume of this.depthConsumers) consume(depthTexture);
      }
    }

    const renderer = this.composer.renderer;
    for (const pass of this.owned) (pass as Partial<FrameHooks>).onBeforeComposerRender?.(renderer, delta);
    this.composer.render(delta);
    for (const pass of this.owned) (pass as Partial<FrameHooks>).onAfterComposerRender?.(renderer, delta);
  }

  refreshBlend(): void {
    for (let index = this.composer.passes.length - 1; index >= 0; index -= 1) {
      const pass = this.composer.passes[index];
      if (!pass || pass.enabled === false) continue;

      const material = (pass as unknown as MaterialCarrier).material;
      if (!material) return;

      material.transparent = this.blend;
      material.blending = this.blend ? THREE.NormalBlending : THREE.NoBlending;
      material.premultipliedAlpha = this.blend;
      material.depthTest = false;
      material.depthWrite = false;
      material.needsUpdate = true;
      return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pass of this.owned) pass.dispose?.();
    this.owned.length = 0;
    this.depthConsumers.length = 0;
    this.composer.passes.length = 0;
    this.target.depthTexture?.dispose();
    this.composer.dispose();
  }
}
