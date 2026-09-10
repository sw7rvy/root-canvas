import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { MaskPass, ClearMaskPass } from 'three/examples/jsm/postprocessing/MaskPass.js';
import { DotScreenShader } from 'three/examples/jsm/shaders/DotScreenShader.js';
import { createStage, StudioLighting, destroyStage, ssao, type EffectsOptions } from '../src/three';

const stage = createStage({ maxPixelRatio: 2, exposure: 1.1 });
const envMap = stage.environment.room();

const bloom: EffectsOptions = {
  samples: 4,
  preserveAlpha: true,
  alphaSpill: 1,
  passes: ({ renderer }) => {
    const size = renderer.getSize(new THREE.Vector2());
    return new UnrealBloomPass(size, 0.55, 0.35, 0.85);
  },
};

const dots: EffectsOptions = {
  resolutionScale: 0.75,
  passes: () => new ShaderPass(DotScreenShader),
};

const maskedDots: EffectsOptions = {
  passes: ({ view, width, height }) => {
    const maskScene = new THREE.Scene();
    const maskCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mask = new THREE.Mesh(new THREE.CircleGeometry(0.85, 64), new THREE.MeshBasicMaterial());

    maskScene.add(mask);
    mask.scale.x = height / width;
    view.resources.track(mask);
    view.on('resize', (event) => {
      mask.scale.x = event.height / event.width;
    });

    return [new MaskPass(maskScene, maskCamera), new ShaderPass(DotScreenShader), new ClearMaskPass()];
  },
};

const ambientOcclusion: EffectsOptions = {
  depthTexture: true,
  taa: true,
  passes: ssao({ radius: 0.6, power: 3, kernelSize: 32 }),
};

interface ViewSetup {
  effects: EffectsOptions;
  floor?: boolean;
  skinned?: boolean;
  instanced?: boolean;
  morphed?: boolean;
  batched?: boolean;
}

const BATCH_COUNT = 24;

function createBatch(): { mesh: THREE.BatchedMesh; instances: number[] } {
  const box = new THREE.BoxGeometry(0.13, 0.13, 0.13);
  const cone = new THREE.ConeGeometry(0.09, 0.22, 6);

  const vertexCount = box.attributes['position']!.count + cone.attributes['position']!.count;
  const indexCount = (box.index?.count ?? 0) + (cone.index?.count ?? 0);

  const mesh = new THREE.BatchedMesh(
    BATCH_COUNT,
    vertexCount,
    indexCount,
    new THREE.MeshStandardMaterial({ color: 0xb08cff, roughness: 0.35, metalness: 0.25 }),
  );

  const boxId = mesh.addGeometry(box);
  const coneId = mesh.addGeometry(cone);
  const instances: number[] = [];

  for (let i = 0; i < BATCH_COUNT; i += 1) {
    instances.push(mesh.addInstance(i % 2 === 0 ? boxId : coneId));
  }

  mesh.perObjectFrustumCulled = false;
  mesh.sortObjects = false;
  mesh.castShadow = true;

  return { mesh, instances };
}

function updateBatch(
  mesh: THREE.BatchedMesh,
  instances: number[],
  elapsed: number,
  matrix: THREE.Matrix4,
): void {
  instances.forEach((id, i) => {
    const angle = -elapsed * 0.6 + (i / BATCH_COUNT) * Math.PI * 2;
    matrix.makeRotationY(angle * 3);
    matrix.setPosition(Math.cos(angle) * 2.4, -0.55 + Math.sin(angle * 2) * 0.18, Math.sin(angle) * 2.4);
    mesh.setMatrixAt(id, matrix);
  });
}

function createMorphBlob(): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(0.42, 4);
  const base = geometry.attributes['position'] as THREE.BufferAttribute;
  const spiked = base.clone();
  const vertex = new THREE.Vector3();

  for (let i = 0; i < spiked.count; i += 1) {
    vertex.fromBufferAttribute(spiked, i);
    const spike = 1 + 0.55 * Math.abs(Math.sin(vertex.x * 7) * Math.cos(vertex.y * 7) * Math.sin(vertex.z * 7));
    vertex.multiplyScalar(spike);
    spiked.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }

  geometry.morphAttributes['position'] = [spiked];

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.3, metalness: 0.3, flatShading: true }),
  );
  mesh.castShadow = true;
  return mesh;
}

const ORBITER_COUNT = 32;

function createOrbiters(): THREE.InstancedMesh {
  const geometry = new THREE.BoxGeometry(0.16, 0.16, 0.16, 5, 5, 5);
  const base = geometry.attributes['position'] as THREE.BufferAttribute;
  const rounded = base.clone();
  const vertex = new THREE.Vector3();

  for (let i = 0; i < rounded.count; i += 1) {
    vertex.fromBufferAttribute(rounded, i).normalize().multiplyScalar(0.18);
    rounded.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }

  geometry.morphAttributes['position'] = [rounded];

  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x6ce5b1, roughness: 0.35, metalness: 0.2 }),
    ORBITER_COUNT,
  );

  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;

  const source = new THREE.Mesh(geometry);
  for (let i = 0; i < ORBITER_COUNT; i += 1) {
    source.morphTargetInfluences![0] = 0;
    mesh.setMorphAt(i, source);
  }
  mesh.morphTexture!.needsUpdate = true;

  return mesh;
}

function updateOrbiters(
  mesh: THREE.InstancedMesh,
  elapsed: number,
  matrix: THREE.Matrix4,
  source: THREE.Mesh,
): void {
  for (let i = 0; i < ORBITER_COUNT; i += 1) {
    const angle = elapsed * 0.8 + (i / ORBITER_COUNT) * Math.PI * 2;
    matrix.makeRotationY(angle * 2);
    matrix.setPosition(Math.cos(angle) * 1.7, -0.55 + Math.sin(angle * 3) * 0.3, Math.sin(angle) * 1.7);
    mesh.setMatrixAt(i, matrix);

    source.morphTargetInfluences![0] = Math.sin(elapsed * 2.2 + i * 0.5) * 0.5 + 0.5;
    mesh.setMorphAt(i, source);
  }

  mesh.instanceMatrix.needsUpdate = true;
  mesh.morphTexture!.needsUpdate = true;
}

function createTentacle(): { mesh: THREE.SkinnedMesh; bones: THREE.Bone[] } {
  const height = 1.8;
  const segments = 6;
  const halfHeight = height / 2;
  const segmentHeight = height / segments;

  const geometry = new THREE.CylinderGeometry(0.06, 0.16, height, 12, segments * 3, true);
  const position = geometry.attributes['position'] as THREE.BufferAttribute;
  const vertex = new THREE.Vector3();
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];

  for (let i = 0; i < position.count; i += 1) {
    vertex.fromBufferAttribute(position, i);
    const y = vertex.y + halfHeight;
    const index = Math.min(Math.floor(y / segmentHeight), segments - 1);
    const weight = (y % segmentHeight) / segmentHeight;
    skinIndices.push(index, Math.min(index + 1, segments), 0, 0);
    skinWeights.push(1 - weight, weight, 0, 0);
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  const bones: THREE.Bone[] = [];
  let parent = new THREE.Bone();
  parent.position.y = -halfHeight;
  bones.push(parent);

  for (let i = 0; i < segments; i += 1) {
    const bone = new THREE.Bone();
    bone.position.y = segmentHeight;
    parent.add(bone);
    bones.push(bone);
    parent = bone;
  }

  const mesh = new THREE.SkinnedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0xff9a6c, roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide }),
  );
  mesh.add(bones[0]!);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true;

  return { mesh, bones };
}

function mountProductView(anchor: HTMLElement, setup: ViewSetup) {
  const { effects, floor = false, skinned = false, instanced = false, morphed = false, batched = false } = setup;

  const view = stage.createView({
    element: anchor,
    camera: new THREE.PerspectiveCamera(35, 1, 0.1, 100),
    priority: 1,
    effects,
  });

  view.camera.position.set(0, 1.2, 4);
  view.camera.lookAt(0, 0.5, 0);

  stage.environment.apply(view.scene, envMap, { intensity: 1.2 });

  const lighting = new StudioLighting({ shadowExtent: 4 }).attach(view.scene);
  view.resources.track(lighting);

  const mesh = view.add(
    new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.6, 0.22, 200, 32),
      new THREE.MeshStandardMaterial({ color: 0x8899ff, metalness: 0.9, roughness: 0.18 }),
    ),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  lighting.setTarget(mesh);

  if (floor) {
    const ground = view.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(12, 12),
        new THREE.MeshStandardMaterial({ color: 0xd8dae0, roughness: 0.95, metalness: 0 }),
      ),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.95;
    ground.receiveShadow = true;
  }

  view.on('pointermove', ({ intersect, view: self }) => {
    self.element.style.cursor = intersect([mesh]).length > 0 ? 'grab' : '';
  });

  const tentacle = skinned ? createTentacle() : null;
  if (tentacle) {
    view.add(tentacle.mesh);
    tentacle.mesh.position.set(1.35, -0.05, 0);
  }

  const orbiters = instanced ? view.add(createOrbiters()) : null;
  const orbiterMatrix = new THREE.Matrix4();
  const orbiterSource = orbiters ? new THREE.Mesh(orbiters.geometry) : null;

  const blob = morphed ? view.add(createMorphBlob()) : null;
  if (blob) blob.position.set(-1.5, -0.35, 0.4);

  const batch = batched ? createBatch() : null;
  if (batch) view.add(batch.mesh);
  const batchMatrix = new THREE.Matrix4();

  const unbind = stage.onBeforeRender((delta, elapsed) => {
    if (!view.onScreen) return;
    mesh.rotation.y += delta * 0.6;

    if (tentacle) {
      tentacle.bones.forEach((bone, index) => {
        bone.rotation.z = Math.sin(elapsed * 2.4 + index * 0.6) * 0.28;
      });
    }

    if (orbiters && orbiterSource) updateOrbiters(orbiters, elapsed, orbiterMatrix, orbiterSource);

    if (blob?.morphTargetInfluences) {
      blob.morphTargetInfluences[0] = Math.sin(elapsed * 1.6) * 0.5 + 0.5;
    }

    if (batch) updateBatch(batch.mesh, batch.instances, elapsed, batchMatrix);
  });

  return () => {
    unbind();
    stage.environment.release(view.scene);
    stage.removeView(view);
  };
}

const setups: ViewSetup[] = [
  { effects: ambientOcclusion, floor: true, skinned: true, instanced: true, morphed: true, batched: true },
  { effects: bloom },
  { effects: dots },
  { effects: maskedDots },
];

const anchors = [...document.querySelectorAll<HTMLElement>('[data-three-view]')];
const teardown = anchors.map((anchor, index) => mountProductView(anchor, setups[index] ?? setups[0]!));

window.addEventListener('beforeunload', () => {
  for (const off of teardown) off();
  destroyStage();
});
