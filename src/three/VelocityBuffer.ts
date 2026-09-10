import * as THREE from 'three';

const VELOCITY_VERTEX = /* glsl */ `
  #include <common>
  #include <batching_pars_vertex>
  #include <morphtarget_pars_vertex>
  #include <skinning_pars_vertex>

  uniform mat4 currentMVP;
  uniform mat4 previousMVP;

  varying vec4 vCurrentClip;
  varying vec4 vPreviousClip;

  #ifdef USE_SKINNING

    uniform highp sampler2D previousBoneTexture;

    mat4 getPreviousBoneMatrix( const in float i ) {
      int size = textureSize( previousBoneTexture, 0 ).x;
      int j = int( i ) * 4;
      int x = j % size;
      int y = j / size;
      vec4 v1 = texelFetch( previousBoneTexture, ivec2( x, y ), 0 );
      vec4 v2 = texelFetch( previousBoneTexture, ivec2( x + 1, y ), 0 );
      vec4 v3 = texelFetch( previousBoneTexture, ivec2( x + 2, y ), 0 );
      vec4 v4 = texelFetch( previousBoneTexture, ivec2( x + 3, y ), 0 );
      return mat4( v1, v2, v3, v4 );
    }

  #endif

  #ifdef USE_MORPHTARGETS

    #ifdef USE_INSTANCING_MORPH

      uniform highp sampler2D previousMorphTexture;

    #else

      uniform float previousMorphTargetBaseInfluence;
      uniform float previousMorphTargetInfluences[ MORPHTARGETS_COUNT ];

    #endif

  #endif

  #ifdef USE_BATCHING

    uniform highp sampler2D previousBatchingTexture;

    mat4 getPreviousBatchingMatrix( const in float i ) {
      int size = textureSize( previousBatchingTexture, 0 ).x;
      int j = int( i ) * 4;
      int x = j % size;
      int y = j / size;
      vec4 v1 = texelFetch( previousBatchingTexture, ivec2( x, y ), 0 );
      vec4 v2 = texelFetch( previousBatchingTexture, ivec2( x + 1, y ), 0 );
      vec4 v3 = texelFetch( previousBatchingTexture, ivec2( x + 2, y ), 0 );
      vec4 v4 = texelFetch( previousBatchingTexture, ivec2( x + 3, y ), 0 );
      return mat4( v1, v2, v3, v4 );
    }

  #endif

  #ifdef USE_INSTANCING

    uniform highp sampler2D previousInstanceTexture;

    mat4 getPreviousInstanceMatrix() {
      int size = textureSize( previousInstanceTexture, 0 ).x;
      int j = gl_InstanceID * 4;
      int x = j % size;
      int y = j / size;
      vec4 v1 = texelFetch( previousInstanceTexture, ivec2( x, y ), 0 );
      vec4 v2 = texelFetch( previousInstanceTexture, ivec2( x + 1, y ), 0 );
      vec4 v3 = texelFetch( previousInstanceTexture, ivec2( x + 2, y ), 0 );
      vec4 v4 = texelFetch( previousInstanceTexture, ivec2( x + 3, y ), 0 );
      return mat4( v1, v2, v3, v4 );
    }

  #endif

  void main() {
    #include <batching_vertex>
    #include <morphinstance_vertex>

    vec3 transformed = vec3( position );
    vec3 previousPosition = vec3( position );

    #ifdef USE_MORPHTARGETS

      #include <morphtarget_vertex>

      #ifdef USE_INSTANCING_MORPH

        previousPosition *= texelFetch( previousMorphTexture, ivec2( 0, gl_InstanceID ), 0 ).r;

        for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
          float influence = texelFetch( previousMorphTexture, ivec2( i + 1, gl_InstanceID ), 0 ).r;
          if ( influence != 0.0 ) previousPosition += getMorph( gl_VertexID, i, 0 ).xyz * influence;
        }

      #else

        previousPosition *= previousMorphTargetBaseInfluence;

        for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
          if ( previousMorphTargetInfluences[ i ] != 0.0 ) {
            previousPosition += getMorph( gl_VertexID, i, 0 ).xyz * previousMorphTargetInfluences[ i ];
          }
        }

      #endif

    #endif

    #ifdef USE_SKINNING

      #include <skinbase_vertex>
      #include <skinning_vertex>

      mat4 previousBoneMatX = getPreviousBoneMatrix( skinIndex.x );
      mat4 previousBoneMatY = getPreviousBoneMatrix( skinIndex.y );
      mat4 previousBoneMatZ = getPreviousBoneMatrix( skinIndex.z );
      mat4 previousBoneMatW = getPreviousBoneMatrix( skinIndex.w );

      vec4 previousSkinVertex = bindMatrix * vec4( previousPosition, 1.0 );
      vec4 previousSkinned = vec4( 0.0 );
      previousSkinned += previousBoneMatX * previousSkinVertex * skinWeight.x;
      previousSkinned += previousBoneMatY * previousSkinVertex * skinWeight.y;
      previousSkinned += previousBoneMatZ * previousSkinVertex * skinWeight.z;
      previousSkinned += previousBoneMatW * previousSkinVertex * skinWeight.w;
      previousPosition = ( bindMatrixInverse * previousSkinned ).xyz;

    #endif

    vec4 currentLocal = vec4( transformed, 1.0 );
    vec4 previousLocal = vec4( previousPosition, 1.0 );

    #ifdef USE_BATCHING

      currentLocal = batchingMatrix * currentLocal;
      previousLocal = getPreviousBatchingMatrix( getIndirectIndex( gl_DrawID ) ) * previousLocal;

    #endif

    #ifdef USE_INSTANCING

      currentLocal = instanceMatrix * currentLocal;
      previousLocal = getPreviousInstanceMatrix() * previousLocal;

    #endif

    vCurrentClip = currentMVP * currentLocal;
    vPreviousClip = previousMVP * previousLocal;
    gl_Position = vCurrentClip;
  }
`;

const VELOCITY_FRAGMENT = /* glsl */ `
  varying vec4 vCurrentClip;
  varying vec4 vPreviousClip;

  void main() {
    vec2 currentUv = ( vCurrentClip.xy / vCurrentClip.w ) * 0.5 + 0.5;
    vec2 previousUv = ( vPreviousClip.xy / vPreviousClip.w ) * 0.5 + 0.5;

    gl_FragColor = vec4( currentUv - previousUv, 1.0, gl_FragCoord.z );
  }
`;

function matrixTextureSize(count: number): number {
  let size = Math.sqrt(count * 4);
  size = Math.ceil(size / 4) * 4;
  return Math.max(size, 4);
}

type BatchedInternals = THREE.BatchedMesh & { _matricesTexture?: THREE.DataTexture };

type Renderable = THREE.Object3D & {
  isMesh?: boolean;
  isBatchedMesh?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isSprite?: boolean;
  isSkinnedMesh?: boolean;
  isInstancedMesh?: boolean;
};

export class VelocityBuffer {
  readonly target: THREE.WebGLRenderTarget;

  private readonly materials = new WeakMap<THREE.Mesh, THREE.ShaderMaterial>();
  private readonly owned = new Set<THREE.ShaderMaterial>();
  private readonly previousMatrices = new WeakMap<THREE.Object3D, THREE.Matrix4>();
  private readonly previousBones = new WeakMap<THREE.Skeleton, THREE.DataTexture>();
  private readonly previousInstances = new WeakMap<THREE.InstancedMesh, THREE.DataTexture>();
  private readonly ownedTextures = new Set<THREE.DataTexture>();
  private readonly previousInfluences = new WeakMap<THREE.Mesh, Float32Array>();
  private readonly previousMorphTextures = new WeakMap<THREE.InstancedMesh, THREE.DataTexture>();
  private readonly previousBatches = new WeakMap<THREE.BatchedMesh, THREE.DataTexture>();
  private readonly batchedThisFrame: THREE.BatchedMesh[] = [];
  private readonly skinnedThisFrame: THREE.SkinnedMesh[] = [];
  private readonly instancedThisFrame: THREE.InstancedMesh[] = [];
  private readonly morphedThisFrame: THREE.Mesh[] = [];

  private readonly currentViewProjection = new THREE.Matrix4();
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly scratch = new THREE.Matrix4();
  private readonly clearColor = new THREE.Color();

  private readonly hidden: THREE.Object3D[] = [];
  private readonly swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];

  private hasPrevious = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.texture.name = 'VelocityBuffer.velocity';
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }

  reset(): void {
    this.hasPrevious = false;
  }

  render(renderer: THREE.WebGLRenderer): void {
    const { scene, camera } = this;

    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    this.currentViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this.hasPrevious) this.previousViewProjection.copy(this.currentViewProjection);

    scene.updateMatrixWorld();
    this.prepare();

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const previousBackground = scene.background;
    const previousAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);

    scene.background = null;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    renderer.setClearColor(this.clearColor, previousAlpha);
    renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);
    scene.background = previousBackground;

    this.restore();
    this.captureBones();
    this.captureInstances();
    this.captureInfluences();
    this.captureBatches();

    this.previousViewProjection.copy(this.currentViewProjection);
    this.hasPrevious = true;
  }

  dispose(): void {
    for (const material of this.owned) material.dispose();
    this.owned.clear();
    for (const texture of this.ownedTextures) texture.dispose();
    this.ownedTextures.clear();
    this.target.dispose();
  }

  private previousBoneTextureFor(mesh: THREE.SkinnedMesh): THREE.DataTexture | null {
    const skeleton = mesh.skeleton;
    if (!skeleton) return null;

    let texture = this.previousBones.get(skeleton);
    if (texture) return texture;

    skeleton.update();
    if (skeleton.boneTexture === null) skeleton.computeBoneTexture();

    const size = skeleton.boneTexture?.image.width ?? 4;
    const data = new Float32Array(size * size * 4);
    data.set(skeleton.boneMatrices);

    texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    texture.name = 'VelocityBuffer.previousBones';
    texture.needsUpdate = true;

    this.previousBones.set(skeleton, texture);
    this.ownedTextures.add(texture);
    return texture;
  }

  private previousInstanceTextureFor(mesh: THREE.InstancedMesh): THREE.DataTexture | null {
    const matrices = mesh.instanceMatrix;
    if (!matrices) return null;

    let texture = this.previousInstances.get(mesh);
    if (texture) return texture;

    const size = matrixTextureSize(matrices.count);
    const data = new Float32Array(size * size * 4);
    data.set(matrices.array as Float32Array);

    texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    texture.name = 'VelocityBuffer.previousInstances';
    texture.needsUpdate = true;

    this.previousInstances.set(mesh, texture);
    this.ownedTextures.add(texture);
    return texture;
  }

  private applyPreviousInfluences(mesh: THREE.Mesh, material: THREE.ShaderMaterial): void {
    const influences = mesh.morphTargetInfluences;
    if (!influences) return;

    let previous = this.previousInfluences.get(mesh);
    if (!previous || previous.length !== influences.length) {
      previous = new Float32Array(influences);
      this.previousInfluences.set(mesh, previous);
    }

    let sum = 0;
    for (let i = 0; i < previous.length; i += 1) sum += previous[i]!;

    material.uniforms['previousMorphTargetInfluences']!.value = previous;
    material.uniforms['previousMorphTargetBaseInfluence']!.value = mesh.geometry.morphTargetsRelative ? 1 : 1 - sum;
  }

  private captureInfluences(): void {
    for (const mesh of this.morphedThisFrame) {
      const influences = mesh.morphTargetInfluences;
      const previous = this.previousInfluences.get(mesh);
      if (!influences || !previous) continue;

      previous.set(influences);
    }

    this.morphedThisFrame.length = 0;
  }

  private previousMorphTextureFor(mesh: THREE.InstancedMesh): THREE.DataTexture | null {
    const source = mesh.morphTexture;
    if (!source) return null;

    let texture = this.previousMorphTextures.get(mesh);
    if (texture) return texture;

    const image = source.image as { data: Float32Array; width: number; height: number };
    texture = new THREE.DataTexture(
      new Float32Array(image.data),
      image.width,
      image.height,
      THREE.RedFormat,
      THREE.FloatType,
    );
    texture.name = 'VelocityBuffer.previousInstanceMorphs';
    texture.needsUpdate = true;

    this.previousMorphTextures.set(mesh, texture);
    this.ownedTextures.add(texture);
    return texture;
  }

  private previousBatchTextureFor(mesh: THREE.BatchedMesh): THREE.DataTexture | null {
    const source = (mesh as BatchedInternals)._matricesTexture;
    if (!source) return null;

    let texture = this.previousBatches.get(mesh);
    if (texture) return texture;

    const image = source.image as { data: Float32Array; width: number; height: number };
    texture = new THREE.DataTexture(
      new Float32Array(image.data),
      image.width,
      image.height,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    texture.name = 'VelocityBuffer.previousBatches';
    texture.needsUpdate = true;

    this.previousBatches.set(mesh, texture);
    this.ownedTextures.add(texture);
    return texture;
  }

  private captureBatches(): void {
    for (const mesh of this.batchedThisFrame) {
      const source = (mesh as BatchedInternals)._matricesTexture;
      const mirror = this.previousBatches.get(mesh);
      if (!source || !mirror) continue;

      (mirror.image.data as Float32Array).set(source.image.data as Float32Array);
      mirror.needsUpdate = true;
    }

    this.batchedThisFrame.length = 0;
  }

  private captureInstances(): void {
    for (const mesh of this.instancedThisFrame) {
      const texture = this.previousInstances.get(mesh);

      if (texture) {
        (texture.image.data as Float32Array).set(mesh.instanceMatrix.array as Float32Array);
        texture.needsUpdate = true;
      }

      const morphSource = mesh.morphTexture;
      const morphMirror = this.previousMorphTextures.get(mesh);

      if (morphSource && morphMirror) {
        (morphMirror.image.data as Float32Array).set(morphSource.image.data as Float32Array);
        morphMirror.needsUpdate = true;
      }
    }

    this.instancedThisFrame.length = 0;
  }

  private captureBones(): void {
    for (const mesh of this.skinnedThisFrame) {
      const skeleton = mesh.skeleton;
      const texture = skeleton ? this.previousBones.get(skeleton) : undefined;
      if (!skeleton || !texture) continue;

      (texture.image.data as Float32Array).set(skeleton.boneMatrices);
      texture.needsUpdate = true;
    }

    this.skinnedThisFrame.length = 0;
  }

  private prepare(): void {
    this.scene.traverse((object) => {
      const renderable = object as Renderable;

      if (renderable.isMesh !== true) {
        if ((renderable.isPoints || renderable.isLine || renderable.isSprite) && object.visible) {
          object.visible = false;
          this.hidden.push(object);
        }
        return;
      }

      const mesh = object as THREE.Mesh;
      if (!mesh.visible) return;

      const material = this.materialFor(mesh);
      const uniforms = material.uniforms;

      if (renderable.isSkinnedMesh === true) {
        const skinned = mesh as THREE.SkinnedMesh;
        uniforms['previousBoneTexture']!.value = this.previousBoneTextureFor(skinned);
        this.skinnedThisFrame.push(skinned);
      }

      if ((mesh.morphTargetInfluences?.length ?? 0) > 0) {
        this.applyPreviousInfluences(mesh, material);
        this.morphedThisFrame.push(mesh);
      }

      if (renderable.isBatchedMesh === true) {
        const batched = mesh as THREE.BatchedMesh;
        const mirror = this.previousBatchTextureFor(batched);
        if (mirror) {
          uniforms['previousBatchingTexture']!.value = mirror;
          this.batchedThisFrame.push(batched);
        }
      }

      if (renderable.isInstancedMesh === true) {
        const instanced = mesh as THREE.InstancedMesh;
        uniforms['previousInstanceTexture']!.value = this.previousInstanceTextureFor(instanced);
        this.instancedThisFrame.push(instanced);

        if (instanced.morphTexture) {
          uniforms['previousMorphTexture']!.value = this.previousMorphTextureFor(instanced);
        }
      }

      uniforms['currentMVP']!.value.multiplyMatrices(this.currentViewProjection, mesh.matrixWorld);

      let previousWorld = this.previousMatrices.get(mesh);
      if (!previousWorld) {
        previousWorld = new THREE.Matrix4().copy(mesh.matrixWorld);
        this.previousMatrices.set(mesh, previousWorld);
      }

      this.scratch.multiplyMatrices(this.previousViewProjection, previousWorld);
      uniforms['previousMVP']!.value.copy(this.scratch);
      previousWorld.copy(mesh.matrixWorld);

      this.swapped.push([mesh, mesh.material]);
      mesh.material = material;
    });
  }

  private restore(): void {
    for (const [mesh, material] of this.swapped) mesh.material = material;
    this.swapped.length = 0;

    for (const object of this.hidden) object.visible = true;
    this.hidden.length = 0;
  }

  private materialFor(mesh: THREE.Mesh): THREE.ShaderMaterial {
    let material = this.materials.get(mesh);

    if (!material) {
      material = new THREE.ShaderMaterial({
        name: 'VelocityBuffer.velocity',
        uniforms: {
          currentMVP: { value: new THREE.Matrix4() },
          previousMVP: { value: new THREE.Matrix4() },
          previousBoneTexture: { value: null },
          previousInstanceTexture: { value: null },
          previousMorphTargetBaseInfluence: { value: 1 },
          previousMorphTargetInfluences: { value: new Float32Array(1) },
          previousMorphTexture: { value: null },
          previousBatchingTexture: { value: null },
        },
        vertexShader: VELOCITY_VERTEX,
        fragmentShader: VELOCITY_FRAGMENT,
        blending: THREE.NoBlending,
      });
      this.materials.set(mesh, material);
      this.owned.add(material);
    }

    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (source) {
      material.side = source.side;
      material.wireframe = (source as THREE.MeshStandardMaterial).wireframe === true;
    }

    return material;
  }
}
