import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { MaskPass, ClearMaskPass } from 'three/examples/jsm/postprocessing/MaskPass.js';
import { DotScreenShader } from 'three/examples/jsm/shaders/DotScreenShader.js';
import { createStage, destroyStage, ssao, type EffectsOptions, type View } from '../src/three';

type MotionSource = 'rigid' | 'skinned' | 'instanced' | 'morphed' | 'instancedMorph' | 'batched';

function decodeHalf(bits: number): number {
  const sign = (bits & 0x8000) >> 15;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;

  if (exponent === 0) return (sign ? -1 : 1) * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : (sign ? -Infinity : Infinity);
  return (sign ? -1 : 1) * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function makeSkinned(): { mesh: THREE.SkinnedMesh; bones: THREE.Bone[] } {
  const height = 1;
  const segments = 4;
  const half = height / 2;
  const segmentHeight = height / segments;

  const geometry = new THREE.CylinderGeometry(0.08, 0.12, height, 8, segments * 2, true);
  const position = geometry.attributes['position'] as THREE.BufferAttribute;
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const vertex = new THREE.Vector3();

  for (let i = 0; i < position.count; i += 1) {
    vertex.fromBufferAttribute(position, i);
    const y = vertex.y + half;
    const index = Math.min(Math.floor(y / segmentHeight), segments - 1);
    const weight = (y % segmentHeight) / segmentHeight;
    skinIndices.push(index, Math.min(index + 1, segments), 0, 0);
    skinWeights.push(1 - weight, weight, 0, 0);
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  const bones: THREE.Bone[] = [];
  let parent = new THREE.Bone();
  parent.position.y = -half;
  bones.push(parent);

  for (let i = 0; i < segments; i += 1) {
    const bone = new THREE.Bone();
    bone.position.y = segmentHeight;
    parent.add(bone);
    bones.push(bone);
    parent = bone;
  }

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color: 0xff9a6c }));
  mesh.add(bones[0]!);
  mesh.bind(new THREE.Skeleton(bones));
  return { mesh, bones };
}

function makeMorphed(): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(0.35, 2);
  const spiked = (geometry.attributes['position'] as THREE.BufferAttribute).clone();
  const vertex = new THREE.Vector3();

  for (let i = 0; i < spiked.count; i += 1) {
    vertex.fromBufferAttribute(spiked, i).multiplyScalar(1.6);
    spiked.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }

  geometry.morphAttributes['position'] = [spiked];
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffd166 }));
}

function makeInstanced(withMorph: boolean): THREE.InstancedMesh {
  const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2, 3, 3, 3);

  if (withMorph) {
    const rounded = (geometry.attributes['position'] as THREE.BufferAttribute).clone();
    const vertex = new THREE.Vector3();
    for (let i = 0; i < rounded.count; i += 1) {
      vertex.fromBufferAttribute(rounded, i).normalize().multiplyScalar(0.4);
      rounded.setXYZ(i, vertex.x, vertex.y, vertex.z);
    }
    geometry.morphAttributes['position'] = [rounded];
  }

  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ color: 0x6ce5b1 }), 6);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const matrix = new THREE.Matrix4();
  for (let i = 0; i < 6; i += 1) {
    matrix.makeTranslation((i - 2.5) * 0.35, 0, 0);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  if (withMorph) {
    const source = new THREE.Mesh(geometry);
    for (let i = 0; i < 6; i += 1) {
      source.morphTargetInfluences![0] = 0;
      mesh.setMorphAt(i, source);
    }
    mesh.morphTexture!.needsUpdate = true;
  }

  return mesh;
}

function makeBatched(): { mesh: THREE.BatchedMesh; ids: number[] } {
  const box = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  const mesh = new THREE.BatchedMesh(
    6,
    box.attributes['position']!.count,
    box.index?.count ?? 0,
    new THREE.MeshStandardMaterial({ color: 0xb08cff }),
  );

  const geometryId = mesh.addGeometry(box);
  const ids: number[] = [];
  const matrix = new THREE.Matrix4();

  for (let i = 0; i < 6; i += 1) {
    const id = mesh.addInstance(geometryId);
    matrix.makeTranslation((i - 2.5) * 0.35, 0, 0);
    mesh.setMatrixAt(id, matrix);
    ids.push(id);
  }

  mesh.perObjectFrustumCulled = false;
  return { mesh, ids };
}

class Harness {
  readonly stage = createStage({ autoStart: false, pauseWhenHidden: false, maxPixelRatio: 1 });

  view: View | null = null;
  frameAtRestore = -1;
  private rigid: THREE.Mesh | null = null;
  private skinned: { mesh: THREE.SkinnedMesh; bones: THREE.Bone[] } | null = null;
  private instanced: THREE.InstancedMesh | null = null;
  private morphed: THREE.Mesh | null = null;
  private instancedMorph: THREE.InstancedMesh | null = null;
  private batched: { mesh: THREE.BatchedMesh; ids: number[] } | null = null;

  constructor() {
    // Stage subscribes first, so by the time this runs its handler has already
    // invalidated the composers — this samples the counter synchronously,
    // before the resumed loop can render anything
    this.stage.core.events.on('contextrestored', () => {
      this.frameAtRestore = this.view?.composer?.taaPass?.frame ?? -1;
    });
  }

  createView(
    anchorId: string,
    effects?: EffectsOptions,
    clearColor?: THREE.ColorRepresentation,
    orthographic = false,
  ): View {
    const view = this.stage.createView({
      element: document.getElementById(anchorId)!,
      camera: orthographic
        ? new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 100)
        : new THREE.PerspectiveCamera(40, 1, 0.1, 100),
      clearColor: clearColor ?? null,
      effects,
    });

    view.camera.position.set(0, 0.6, 3.2);
    view.camera.lookAt(0, 0, 0);
    view.add(new THREE.AmbientLight(0xffffff, 2));
    this.view = view;
    return view;
  }

  /** A heavier scene, so the cost of re-rendering geometry becomes visible. */
  populateHeavy(copies = 40): void {
    const view = this.view!;
    const geometry = new THREE.TorusKnotGeometry(0.3, 0.11, 220, 32);
    const material = new THREE.MeshStandardMaterial({ color: 0x8899ff });

    for (let i = 0; i < copies; i += 1) {
      const mesh = view.add(new THREE.Mesh(geometry, material));
      const angle = (i / copies) * Math.PI * 2;
      mesh.position.set(Math.cos(angle) * 1.2, Math.sin(angle * 3) * 0.5, Math.sin(angle) * 1.2);
    }
  }

  populate(): void {
    const view = this.view!;

    this.rigid = view.add(
      new THREE.Mesh(new THREE.TorusKnotGeometry(0.28, 0.1, 64, 12), new THREE.MeshStandardMaterial()),
    );
    this.rigid.position.set(-1.1, 0.4, 0);

    this.skinned = makeSkinned();
    view.add(this.skinned.mesh);
    this.skinned.mesh.position.set(-0.4, 0.2, 0);

    this.morphed = view.add(makeMorphed());
    this.morphed.position.set(0.5, 0.4, 0);

    this.instanced = view.add(makeInstanced(false));
    this.instanced.position.set(0, -0.5, 0);

    this.instancedMorph = view.add(makeInstanced(true));
    this.instancedMorph.position.set(0, -0.9, 0);

    this.batched = makeBatched();
    view.add(this.batched.mesh);
    this.batched.mesh.position.set(0, 0.9, 0);
  }

  move(source: MotionSource): void {
    const matrix = new THREE.Matrix4();

    switch (source) {
      case 'rigid':
        this.rigid!.rotation.y += 0.35;
        break;

      case 'skinned':
        this.skinned!.bones.forEach((bone, i) => {
          bone.rotation.z = 0.3 + i * 0.05;
        });
        break;

      case 'instanced':
        for (let i = 0; i < 6; i += 1) {
          matrix.makeTranslation((i - 2.5) * 0.35, 0.25, 0);
          this.instanced!.setMatrixAt(i, matrix);
        }
        this.instanced!.instanceMatrix.needsUpdate = true;
        break;

      case 'morphed':
        this.morphed!.morphTargetInfluences![0] = 1;
        break;

      case 'instancedMorph': {
        const source2 = new THREE.Mesh(this.instancedMorph!.geometry);
        for (let i = 0; i < 6; i += 1) {
          source2.morphTargetInfluences![0] = 1;
          this.instancedMorph!.setMorphAt(i, source2);
        }
        this.instancedMorph!.morphTexture!.needsUpdate = true;
        break;
      }

      case 'batched':
        this.batched!.ids.forEach((id, i) => {
          matrix.makeTranslation((i - 2.5) * 0.35, 0.25, 0);
          this.batched!.mesh.setMatrixAt(id, matrix);
        });
        break;
    }
  }

  frame(): void {
    this.stage.renderOnce();
  }

  /** Peak absolute screen-space motion in the view's velocity buffer. */
  peakVelocity(): number {
    const velocity = this.view!.composer!.taaPass!.velocity!;
    const { width, height } = velocity.target;
    const buffer = new Uint16Array(width * height * 4);

    this.stage.core.renderer.readRenderTargetPixels(velocity.target, 0, 0, width, height, buffer);

    let peak = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      if (decodeHalf(buffer[i + 2]!) < 0.5) continue;
      const x = Math.abs(decodeHalf(buffer[i]!));
      const y = Math.abs(decodeHalf(buffer[i + 1]!));
      const magnitude = Math.max(x, y);
      if (Number.isFinite(magnitude) && magnitude > peak) peak = magnitude;
    }

    return peak;
  }

  /** GPU string, so a benchmark can say which device produced its numbers. */
  renderer(): string {
    const gl = this.stage.core.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  }

  /**
   * Frame cost including GPU work. readPixels forces the pipeline to drain, so
   * each sample covers submit *and* execution rather than just the JS half.
   */
  /**
   * Main-thread cost of a frame. WebGL exposes no usable GPU timer (Chrome
   * disables EXT_disjoint_timer_query_webgl2, and clientWaitSync cannot be
   * busy-waited because command submission needs the event loop), so this is
   * CPU submit time plus whatever the driver blocks on — the figure that
   * decides whether the main thread janks.
   */
  bench(frames: number): { median: number; calls: number; triangles: number } {
    const renderer = this.stage.core.renderer;
    const samples: number[] = [];

    for (let i = 0; i < 20; i += 1) this.frame();

    // info.render resets at the start of every renderer.render() call, so a
    // frame that renders a velocity pass, a chain and a blit would otherwise
    // report only the last one
    renderer.info.autoReset = false;
    renderer.info.reset();
    this.frame();
    const calls = renderer.info.render.calls;
    const triangles = renderer.info.render.triangles;
    renderer.info.autoReset = true;

    // performance.now() is clamped to ~100us in Chrome, so time a batch and
    // divide rather than trying to resolve a single fast frame
    const batch = 20;
    for (let i = 0; i < frames / batch; i += 1) {
      const start = performance.now();
      for (let j = 0; j < batch; j += 1) this.frame();
      samples.push((performance.now() - start) / batch);
    }

    samples.sort((a, b) => a - b);
    return { median: samples[Math.floor(samples.length / 2)]!, calls, triangles };
  }

  /** End-to-end frame rate under the real loop, vsync included. */
  async throughput(durationMs: number): Promise<number> {
    let frames = 0;
    const stop = this.stage.onAfterRender(() => {
      frames += 1;
    });

    this.stage.start();
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    this.stage.stop();
    stop();

    return (frames / durationMs) * 1000;
  }

  /** Bytes held by the render targets a view's chain allocates. */
  targetBytes(): number {
    const composer = this.view?.composer;
    if (!composer) return 0;

    const half = 8; // RGBA16F
    const { renderTarget1, renderTarget2 } = composer.composer;
    let bytes = (renderTarget1.width * renderTarget1.height + renderTarget2.width * renderTarget2.height) * half;

    const taa = composer.taaPass;
    if (taa) {
      const history = (taa as unknown as { history: Array<{ width: number; height: number }> }).history;
      for (const target of history) bytes += target.width * target.height * half;
      if (taa.velocity) bytes += taa.velocity.target.width * taa.velocity.target.height * half;
    }

    return bytes;
  }

  memory(): { geometries: number; textures: number; canvases: number } {
    const { memory } = this.stage.core.renderer.info;
    return {
      geometries: memory.geometries,
      textures: memory.textures,
      canvases: document.querySelectorAll('canvas').length,
    };
  }

  private loseContextExtension: WEBGL_lose_context | null = null;

  loseContext(): void {
    // the extension is unreachable once the context is gone, so cache it first
    this.loseContextExtension =
      this.stage.core.renderer.getContext().getExtension('WEBGL_lose_context');
    this.loseContextExtension!.loseContext();
  }

  restoreContext(): void {
    this.loseContextExtension!.restoreContext();
  }

  destroy(): void {
    destroyStage();
  }
}

/**
 * Mimics passes such as UnrealBloomPass, which composite additively and leave
 * alpha at 1 across the whole quad — the reason `preserveAlpha` exists.
 */
export function alphaDestroyingPass(): EffectsOptions['passes'] {
  return () => {
    const pass = new ShaderPass({
      name: 'AlphaDestroyer',
      uniforms: { tDiffuse: { value: null } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        void main() {
          gl_FragColor = vec4( texture2D( tDiffuse, vUv ).rgb, 1.0 );
        }
      `,
    });
    return pass;
  };
}

/** A stencil-masked effect: exercises MaskPass, which needs a stencil buffer. */
export function maskedDotScreen(): EffectsOptions['passes'] {
  return ({ view, width, height }) => {
    const maskScene = new THREE.Scene();
    const maskCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mask = new THREE.Mesh(new THREE.CircleGeometry(0.8, 32), new THREE.MeshBasicMaterial());

    maskScene.add(mask);
    mask.scale.x = height / width;
    view.resources.track(mask);

    return [new MaskPass(maskScene, maskCamera), new ShaderPass(DotScreenShader), new ClearMaskPass()];
  };
}

declare global {
  interface Window {
    harness: Harness;
    THREE: typeof THREE;
    ssao: typeof ssao;
    alphaDestroyingPass: typeof alphaDestroyingPass;
    maskedDotScreen: typeof maskedDotScreen;
  }
}

window.harness = new Harness();
window.THREE = THREE;
window.ssao = ssao;
window.alphaDestroyingPass = alphaDestroyingPass;
window.maskedDotScreen = maskedDotScreen;
