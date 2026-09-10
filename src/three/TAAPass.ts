import * as THREE from 'three';
import { preferredTargetType } from './Capabilities';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { VelocityBuffer } from './VelocityBuffer';

export interface TAAOptions {
  feedback?: number;
  clampScale?: number;
  jitterScale?: number;
  sequenceLength?: number;
  velocity?: boolean;
}

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const RESOLVE_SHADER = /* glsl */ `
  varying vec2 vUv;

  uniform sampler2D tDiffuse;
  uniform sampler2D tHistory;
  uniform sampler2D tDepth;
  uniform sampler2D tVelocity;
  uniform float useVelocity;
  uniform vec2 resolution;
  uniform mat4 projectionMatrixInverse;
  uniform mat4 cameraWorldMatrix;
  uniform mat4 previousViewProjection;
  uniform float feedback;
  uniform float clampScale;
  uniform float hasHistory;

  float taaLuminance( vec3 color ) {
    return dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  }

  vec4 closestVelocity( vec2 uv, vec2 texel ) {
    vec4 best = texture2D( tVelocity, uv );

    for ( int x = -1; x <= 1; x ++ ) {
      for ( int y = -1; y <= 1; y ++ ) {
        vec4 neighbour = texture2D( tVelocity, uv + vec2( float( x ), float( y ) ) * texel );
        if ( neighbour.w < best.w ) best = neighbour;
      }
    }

    return best;
  }

  void main() {
    vec2 texel = 1.0 / resolution;
    vec4 current = texture2D( tDiffuse, vUv );

    vec4 minColor = current;
    vec4 maxColor = current;

    for ( int x = -1; x <= 1; x ++ ) {
      for ( int y = -1; y <= 1; y ++ ) {
        vec4 neighbour = texture2D( tDiffuse, vUv + vec2( float( x ), float( y ) ) * texel );
        minColor = min( minColor, neighbour );
        maxColor = max( maxColor, neighbour );
      }
    }

    vec4 middle = ( minColor + maxColor ) * 0.5;
    minColor = middle + ( minColor - middle ) * clampScale;
    maxColor = middle + ( maxColor - middle ) * clampScale;

    float depth = texture2D( tDepth, vUv ).x;
    vec4 clip = vec4( vec3( vUv, depth ) * 2.0 - 1.0, 1.0 );
    vec4 viewPosition = projectionMatrixInverse * clip;
    viewPosition /= viewPosition.w;
    vec4 worldPosition = cameraWorldMatrix * viewPosition;

    vec4 previousClip = previousViewProjection * worldPosition;
    vec2 reprojectedUv = ( previousClip.xy / previousClip.w ) * 0.5 + 0.5;

    vec4 motion = closestVelocity( vUv, texel );
    float useMotion = useVelocity * step( 0.5, motion.z );
    vec2 previousUv = mix( reprojectedUv, vUv - motion.xy, useMotion );

    float inside =
      step( 0.0, previousUv.x ) * step( previousUv.x, 1.0 ) *
      step( 0.0, previousUv.y ) * step( previousUv.y, 1.0 ) *
      mix( step( 0.0, previousClip.w ), 1.0, useMotion );

    float weight = feedback * inside * hasHistory;
    vec4 history = clamp( texture2D( tHistory, previousUv ), minColor, maxColor );

    float currentWeight = ( 1.0 - weight ) / ( 1.0 + taaLuminance( current.rgb ) );
    float historyWeight = weight / ( 1.0 + taaLuminance( history.rgb ) );

    gl_FragColor = ( current * currentWeight + history * historyWeight ) / max( currentWeight + historyWeight, 1e-5 );
  }
`;

const COPY_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  void main() {
    gl_FragColor = texture2D( tDiffuse, vUv );
  }
`;

function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1;
  let current = index;

  while (current > 0) {
    fraction /= base;
    result += fraction * (current % base);
    current = Math.floor(current / base);
  }

  return result;
}

function createHistoryTarget(name: string): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: preferredTargetType(),
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.name = name;
  return target;
}

export class TAAPass extends Pass {
  readonly resolveMaterial: THREE.ShaderMaterial;
  readonly material: THREE.ShaderMaterial;
  readonly velocity: VelocityBuffer | null;

  private readonly history = [createHistoryTarget('TAAPass.history0'), createHistoryTarget('TAAPass.history1')];
  private readonly quad = new FullScreenQuad();
  private readonly camera: THREE.Camera;

  private readonly savedProjection = new THREE.Matrix4();
  private readonly savedProjectionInverse = new THREE.Matrix4();
  private readonly currentViewProjection = new THREE.Matrix4();
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly offset = new THREE.Vector2();

  private readonly jitterScale: number;
  private readonly sequenceLength: number;

  private width = 1;
  private height = 1;
  private frame = 0;
  private slot = 0;
  private jittered = false;
  private hasHistory = false;

  constructor(scene: THREE.Scene, camera: THREE.Camera, options: TAAOptions = {}) {
    super();

    this.camera = camera;
    this.jitterScale = options.jitterScale ?? 1;
    this.sequenceLength = options.sequenceLength ?? 16;
    this.velocity = options.velocity === false ? null : new VelocityBuffer(scene, camera);

    this.resolveMaterial = new THREE.ShaderMaterial({
      name: 'TAAPass.resolve',
      uniforms: {
        tDiffuse: { value: null },
        tHistory: { value: null },
        tDepth: { value: null },
        tVelocity: { value: null },
        useVelocity: { value: 0 },
        resolution: { value: new THREE.Vector2(1, 1) },
        projectionMatrixInverse: { value: new THREE.Matrix4() },
        cameraWorldMatrix: { value: new THREE.Matrix4() },
        previousViewProjection: { value: new THREE.Matrix4() },
        feedback: { value: options.feedback ?? 0.9 },
        clampScale: { value: options.clampScale ?? 1 },
        hasHistory: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: RESOLVE_SHADER,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });

    if (this.velocity) {
      this.resolveMaterial.uniforms['tVelocity']!.value = this.velocity.texture;
      this.resolveMaterial.uniforms['useVelocity']!.value = 1;
    }

    this.material = new THREE.ShaderMaterial({
      name: 'TAAPass.copy',
      uniforms: { tDiffuse: { value: null } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: COPY_SHADER,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });
  }

  get feedback(): number {
    return this.resolveMaterial.uniforms['feedback']?.value as number;
  }

  set feedback(value: number) {
    const uniform = this.resolveMaterial.uniforms['feedback'];
    if (uniform) uniform.value = value;
  }

  setDepthTexture(depthTexture: THREE.DepthTexture | null): void {
    const uniform = this.resolveMaterial.uniforms['tDepth'];
    if (uniform) uniform.value = depthTexture;
  }

  reset(): void {
    this.hasHistory = false;
    this.frame = 0;
    this.velocity?.reset();
  }

  onBeforeComposerRender(renderer: THREE.WebGLRenderer): void {
    if (this.enabled === false) return;

    this.velocity?.render(renderer);

    const projection = this.camera.projectionMatrix;
    this.savedProjection.copy(projection);
    this.savedProjectionInverse.copy(this.camera.projectionMatrixInverse);

    const index = (this.frame % this.sequenceLength) + 1;
    this.offset.set(halton(index, 2) - 0.5, halton(index, 3) - 0.5).multiplyScalar(this.jitterScale);

    const jitterX = (this.offset.x * 2) / this.width;
    const jitterY = (this.offset.y * 2) / this.height;

    if ((this.camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      projection.elements[8] += jitterX;
      projection.elements[9] += jitterY;
    } else {
      projection.elements[12] += jitterX;
      projection.elements[13] += jitterY;
    }

    this.camera.projectionMatrixInverse.copy(projection).invert();
    this.jittered = true;

    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this.currentViewProjection.multiplyMatrices(projection, this.camera.matrixWorldInverse);
  }

  onAfterComposerRender(): void {
    if (!this.jittered) return;

    this.camera.projectionMatrix.copy(this.savedProjection);
    this.camera.projectionMatrixInverse.copy(this.savedProjectionInverse);
    this.jittered = false;

    this.previousViewProjection.copy(this.currentViewProjection);
    this.hasHistory = true;
    this.frame += 1;
    this.slot ^= 1;
  }

  override setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.history[0]!.setSize(this.width, this.height);
    this.history[1]!.setSize(this.width, this.height);
    this.velocity?.setSize(this.width, this.height);
    this.resolveMaterial.uniforms['resolution']?.value.set(this.width, this.height);
    this.reset();
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const target = this.history[this.slot ^ 1]!;
    const source = this.history[this.slot]!;

    const uniforms = this.resolveMaterial.uniforms;
    uniforms['tDiffuse']!.value = readBuffer.texture;
    uniforms['tHistory']!.value = source.texture;
    uniforms['hasHistory']!.value = this.hasHistory ? 1 : 0;
    uniforms['projectionMatrixInverse']!.value.copy(this.camera.projectionMatrixInverse);
    uniforms['cameraWorldMatrix']!.value.copy(this.camera.matrixWorld);
    uniforms['previousViewProjection']!.value.copy(
      this.hasHistory ? this.previousViewProjection : this.currentViewProjection,
    );

    this.draw(renderer, this.resolveMaterial, target);

    this.material.uniforms['tDiffuse']!.value = target.texture;
    this.draw(renderer, this.material, this.renderToScreen ? null : writeBuffer);
  }

  override dispose(): void {
    this.history[0]!.dispose();
    this.history[1]!.dispose();
    this.velocity?.dispose();
    this.resolveMaterial.dispose();
    this.material.dispose();
    this.quad.dispose();
  }

  private draw(
    renderer: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }
}
