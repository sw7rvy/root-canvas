import * as THREE from 'three';

type Seen = Set<unknown>;

function isTexture(value: unknown): value is THREE.Texture {
  return !!value && (value as THREE.Texture).isTexture === true;
}

export function disposeMaterialTextures(material: THREE.Material, seen: Seen = new Set()): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (isTexture(value) && !seen.has(value)) {
      seen.add(value);
      value.dispose();
    }
  }

  const uniforms = (material as THREE.ShaderMaterial).uniforms;
  if (!uniforms) return;

  for (const uniform of Object.values(uniforms)) {
    const value = uniform?.value as unknown;
    if (isTexture(value) && !seen.has(value)) {
      seen.add(value);
      value.dispose();
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (isTexture(entry) && !seen.has(entry)) {
          seen.add(entry);
          entry.dispose();
        }
      }
    } else if (value instanceof THREE.WebGLRenderTarget) {
      disposeRenderTarget(value, seen);
    }
  }
}

export function disposeMaterial(material: THREE.Material | THREE.Material[], seen: Seen = new Set()): void {
  const list = Array.isArray(material) ? material : [material];
  for (const entry of list) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    disposeMaterialTextures(entry, seen);
    entry.dispose();
  }
}

export function disposeObject(object: THREE.Object3D, seen: Seen = new Set()): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry && !seen.has(mesh.geometry)) {
      seen.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    if (mesh.material) disposeMaterial(mesh.material, seen);

    const skinned = child as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) skinned.skeleton?.dispose?.();

    const instanced = child as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) instanced.dispose();

    const batched = child as THREE.BatchedMesh;
    if (batched.isBatchedMesh) batched.dispose();

    const light = child as THREE.Light;
    if (light.isLight) {
      const shadow = (light as THREE.DirectionalLight).shadow as THREE.LightShadow | undefined;
      if (shadow?.map) {
        shadow.map.dispose();
        shadow.map = null as unknown as THREE.WebGLRenderTarget;
      }
      light.dispose?.();
    }
  });

  object.removeFromParent();
}

export interface DisposeSceneOptions {
  disposeEnvironment?: boolean;
  disposeBackground?: boolean;
}

export function disposeScene(scene: THREE.Scene, options: DisposeSceneOptions = {}): void {
  const seen: Seen = new Set();
  for (const child of [...scene.children]) disposeObject(child, seen);

  if (options.disposeBackground !== false && isTexture(scene.background)) scene.background.dispose();
  if (options.disposeEnvironment === true && scene.environment) scene.environment.dispose();

  scene.background = null;
  scene.environment = null;
  scene.clear();
}

export function disposeRenderTarget(target: THREE.WebGLRenderTarget, seen: Seen = new Set()): void {
  if (seen.has(target)) return;
  seen.add(target);

  const textures = (target.textures ?? [target.texture]) as THREE.Texture[];
  for (const texture of textures) {
    if (isTexture(texture) && !seen.has(texture)) {
      seen.add(texture);
      texture.dispose();
    }
  }
  target.depthTexture?.dispose();
  target.dispose();
}
