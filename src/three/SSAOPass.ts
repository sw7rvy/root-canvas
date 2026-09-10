import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { EffectPassFactory } from './Effects';

export interface SSAOOptions {
  kernelSize?: number;
  radius?: number;
  bias?: number;
  intensity?: number;
  power?: number;
  blurDepthCutoff?: number;
  output?: 'default' | 'ao';
}

const NOISE_SIZE = 4;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const OCCLUSION_SHADER = /* glsl */ `
  varying vec2 vUv;

  uniform sampler2D tDepth;
  uniform sampler2D tNoise;
  uniform vec3 kernel[ KERNEL_SIZE ];
  uniform vec2 resolution;
  uniform mat4 cameraProjectionMatrix;
  uniform mat4 cameraProjectionMatrixInverse;
  uniform float radius;
  uniform float bias;

  vec3 viewPositionAt( vec2 uv, float depth ) {
    vec4 clip = vec4( vec3( uv, depth ) * 2.0 - 1.0, 1.0 );
    vec4 view = cameraProjectionMatrixInverse * clip;
    return view.xyz / view.w;
  }

  vec3 reconstructNormal( vec2 uv, vec3 center, float centerDepth ) {
    vec2 texel = 1.0 / resolution;

    vec2 uvL = uv - vec2( texel.x, 0.0 );
    vec2 uvR = uv + vec2( texel.x, 0.0 );
    vec2 uvD = uv - vec2( 0.0, texel.y );
    vec2 uvU = uv + vec2( 0.0, texel.y );

    float depthL = texture2D( tDepth, uvL ).x;
    float depthR = texture2D( tDepth, uvR ).x;
    float depthD = texture2D( tDepth, uvD ).x;
    float depthU = texture2D( tDepth, uvU ).x;

    vec3 tangentX = abs( depthL - centerDepth ) < abs( depthR - centerDepth )
      ? center - viewPositionAt( uvL, depthL )
      : viewPositionAt( uvR, depthR ) - center;

    vec3 tangentY = abs( depthD - centerDepth ) < abs( depthU - centerDepth )
      ? center - viewPositionAt( uvD, depthD )
      : viewPositionAt( uvU, depthU ) - center;

    vec3 normal = normalize( cross( tangentX, tangentY ) );
    return dot( normal, center ) > 0.0 ? -normal : normal;
  }

  void main() {
    float depth = texture2D( tDepth, vUv ).x;

    if ( depth >= 1.0 ) {
      gl_FragColor = vec4( 1.0 );
      return;
    }

    vec3 viewPosition = viewPositionAt( vUv, depth );
    vec3 normal = reconstructNormal( vUv, viewPosition, depth );

    vec3 random = normalize( texture2D( tNoise, vUv * resolution / float( NOISE_SIZE ) ).xyz );
    vec3 tangent = normalize( random - normal * dot( random, normal ) );
    mat3 basis = mat3( tangent, cross( normal, tangent ), normal );

    float occlusion = 0.0;

    for ( int i = 0; i < KERNEL_SIZE; i ++ ) {
      vec3 samplePosition = viewPosition + basis * kernel[ i ] * radius;
      vec4 clip = cameraProjectionMatrix * vec4( samplePosition, 1.0 );
      vec2 sampleUv = ( clip.xy / clip.w ) * 0.5 + 0.5;

      if ( sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0 ) continue;

      float sampleDepth = texture2D( tDepth, sampleUv ).x;
      if ( sampleDepth >= 1.0 ) continue;

      vec3 occluder = viewPositionAt( sampleUv, sampleDepth );
      float range = smoothstep( 0.0, 1.0, radius / abs( viewPosition.z - occluder.z ) );
      occlusion += step( samplePosition.z + bias, occluder.z ) * range;
    }

    gl_FragColor = vec4( 1.0 - occlusion / float( KERNEL_SIZE ) );
  }
`;

const BLUR_SHADER = /* glsl */ `
  varying vec2 vUv;

  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform vec2 resolution;
  uniform mat4 cameraProjectionMatrixInverse;
  uniform float depthCutoff;

  float viewZAt( vec2 uv ) {
    float depth = texture2D( tDepth, uv ).x;
    vec4 clip = vec4( vec3( uv, depth ) * 2.0 - 1.0, 1.0 );
    vec4 view = cameraProjectionMatrixInverse * clip;
    return view.z / view.w;
  }

  void main() {
    vec2 texel = 1.0 / resolution;
    float centerZ = viewZAt( vUv );

    float sum = 0.0;
    float total = 0.0;

    for ( int x = -2; x < 2; x ++ ) {
      for ( int y = -2; y < 2; y ++ ) {
        vec2 uv = vUv + vec2( float( x ), float( y ) ) * texel;
        float weight = step( abs( viewZAt( uv ) - centerZ ), depthCutoff );
        sum += texture2D( tDiffuse, uv ).r * weight;
        total += weight;
      }
    }

    gl_FragColor = vec4( total > 0.0 ? sum / total : texture2D( tDiffuse, vUv ).r );
  }
`;

const COMPOSITE_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform sampler2D tAmbientOcclusion;
  uniform float intensity;
  uniform float power;
  uniform bool aoOnly;

  void main() {
    vec4 color = texture2D( tDiffuse, vUv );
    float ao = pow( clamp( texture2D( tAmbientOcclusion, vUv ).r, 0.0, 1.0 ), power );

    if ( aoOnly ) {
      gl_FragColor = vec4( vec3( ao ), color.a );
      return;
    }

    gl_FragColor = vec4( color.rgb * mix( 1.0, ao, intensity ), color.a );
  }
`;

function createKernel(size: number): THREE.Vector3[] {
  const kernel: THREE.Vector3[] = [];

  for (let i = 0; i < size; i += 1) {
    const sample = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random()).normalize();
    const weight = i / size;
    kernel.push(sample.multiplyScalar(0.1 + 0.9 * weight * weight));
  }

  return kernel;
}

function createNoiseTexture(): THREE.DataTexture {
  const data = new Float32Array(NOISE_SIZE * NOISE_SIZE * 4);

  for (let i = 0; i < NOISE_SIZE * NOISE_SIZE; i += 1) {
    data[i * 4 + 0] = Math.random() * 2 - 1;
    data[i * 4 + 1] = Math.random() * 2 - 1;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 1;
  }

  const texture = new THREE.DataTexture(data, NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat, THREE.FloatType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function createTarget(name: string): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.name = name;
  return target;
}

export class SSAOPass extends Pass {
  readonly occlusionMaterial: THREE.ShaderMaterial;
  readonly blurMaterial: THREE.ShaderMaterial;
  readonly material: THREE.ShaderMaterial;

  private readonly occlusionTarget = createTarget('SSAOPass.occlusion');
  private readonly blurTarget = createTarget('SSAOPass.blur');
  private readonly noise = createNoiseTexture();
  private readonly quad = new FullScreenQuad();
  private readonly camera: THREE.Camera;

  constructor(camera: THREE.Camera, options: SSAOOptions = {}) {
    super();

    this.camera = camera;

    const kernelSize = options.kernelSize ?? 32;

    this.occlusionMaterial = new THREE.ShaderMaterial({
      name: 'SSAOPass.occlusion',
      defines: { KERNEL_SIZE: kernelSize, NOISE_SIZE: NOISE_SIZE },
      uniforms: {
        tDepth: { value: null },
        tNoise: { value: this.noise },
        kernel: { value: createKernel(kernelSize) },
        resolution: { value: new THREE.Vector2(1, 1) },
        cameraProjectionMatrix: { value: new THREE.Matrix4() },
        cameraProjectionMatrixInverse: { value: new THREE.Matrix4() },
        radius: { value: options.radius ?? 0.25 },
        bias: { value: options.bias ?? 0.02 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: OCCLUSION_SHADER,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.blurMaterial = new THREE.ShaderMaterial({
      name: 'SSAOPass.blur',
      uniforms: {
        tDiffuse: { value: this.occlusionTarget.texture },
        tDepth: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        cameraProjectionMatrixInverse: { value: new THREE.Matrix4() },
        depthCutoff: { value: options.blurDepthCutoff ?? options.radius ?? 0.25 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BLUR_SHADER,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.material = new THREE.ShaderMaterial({
      name: 'SSAOPass.composite',
      uniforms: {
        tDiffuse: { value: null },
        tAmbientOcclusion: { value: this.blurTarget.texture },
        intensity: { value: options.intensity ?? 1 },
        power: { value: options.power ?? 2.5 },
        aoOnly: { value: options.output === 'ao' },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: COMPOSITE_SHADER,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });
  }

  get radius(): number {
    return this.occlusionMaterial.uniforms['radius']?.value as number;
  }

  set radius(value: number) {
    const uniform = this.occlusionMaterial.uniforms['radius'];
    if (uniform) uniform.value = value;
  }

  get power(): number {
    return this.material.uniforms['power']?.value as number;
  }

  set power(value: number) {
    const uniform = this.material.uniforms['power'];
    if (uniform) uniform.value = value;
  }

  get intensity(): number {
    return this.material.uniforms['intensity']?.value as number;
  }

  set intensity(value: number) {
    const uniform = this.material.uniforms['intensity'];
    if (uniform) uniform.value = value;
  }

  setDepthTexture(depthTexture: THREE.DepthTexture | null): void {
    const occlusion = this.occlusionMaterial.uniforms['tDepth'];
    if (occlusion) occlusion.value = depthTexture;

    const blur = this.blurMaterial.uniforms['tDepth'];
    if (blur) blur.value = depthTexture;
  }

  override setSize(width: number, height: number): void {
    this.occlusionTarget.setSize(width, height);
    this.blurTarget.setSize(width, height);
    this.occlusionMaterial.uniforms['resolution']?.value.set(width, height);
    this.blurMaterial.uniforms['resolution']?.value.set(width, height);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    if (!this.occlusionMaterial.uniforms['tDepth']?.value) {
      this.material.uniforms['tDiffuse']!.value = readBuffer.texture;
      this.draw(renderer, this.material, this.renderToScreen ? null : writeBuffer);
      return;
    }

    this.camera.updateMatrixWorld();
    this.occlusionMaterial.uniforms['cameraProjectionMatrix']!.value.copy(this.camera.projectionMatrix);
    this.occlusionMaterial.uniforms['cameraProjectionMatrixInverse']!.value.copy(this.camera.projectionMatrixInverse);
    this.blurMaterial.uniforms['cameraProjectionMatrixInverse']!.value.copy(this.camera.projectionMatrixInverse);

    this.draw(renderer, this.occlusionMaterial, this.occlusionTarget);
    this.draw(renderer, this.blurMaterial, this.blurTarget);

    this.material.uniforms['tDiffuse']!.value = readBuffer.texture;
    this.draw(renderer, this.material, this.renderToScreen ? null : writeBuffer);
  }

  override dispose(): void {
    this.occlusionTarget.dispose();
    this.blurTarget.dispose();
    this.noise.dispose();
    this.occlusionMaterial.dispose();
    this.blurMaterial.dispose();
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

export function ssao(options: SSAOOptions = {}): EffectPassFactory {
  return ({ camera, useSceneDepth }) => {
    const pass = new SSAOPass(camera, options);
    useSceneDepth((depthTexture) => pass.setDepthTexture(depthTexture));
    return pass;
  };
}
