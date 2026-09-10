import * as THREE from 'three';
import { disposeMaterial, disposeObject, disposeRenderTarget } from './Disposal';

type Trackable =
  | THREE.Object3D
  | THREE.Material
  | THREE.Material[]
  | THREE.BufferGeometry
  | THREE.Texture
  | THREE.WebGLRenderTarget
  | { dispose: () => void };

export class ResourceTracker {
  private objects = new Set<THREE.Object3D>();
  private targets = new Set<THREE.WebGLRenderTarget>();
  private generic = new Set<{ dispose: () => void }>();

  track<T extends Trackable>(resource: T): T {
    if (!resource) return resource;

    if (Array.isArray(resource)) {
      for (const entry of resource) this.track(entry);
      return resource;
    }
    if (resource instanceof THREE.Object3D) {
      this.objects.add(resource);
      return resource;
    }
    if (resource instanceof THREE.WebGLRenderTarget) {
      this.targets.add(resource);
      return resource;
    }
    if (typeof (resource as { dispose?: unknown }).dispose === 'function') {
      this.generic.add(resource as { dispose: () => void });
    }
    return resource;
  }

  untrack(resource: Trackable): void {
    if (Array.isArray(resource)) {
      for (const entry of resource) this.untrack(entry);
      return;
    }
    this.objects.delete(resource as THREE.Object3D);
    this.targets.delete(resource as THREE.WebGLRenderTarget);
    this.generic.delete(resource as { dispose: () => void });
  }

  get size(): number {
    return this.objects.size + this.targets.size + this.generic.size;
  }

  dispose(): void {
    const seen = new Set<unknown>();
    for (const object of this.objects) disposeObject(object, seen);
    for (const target of this.targets) disposeRenderTarget(target, seen);
    for (const resource of this.generic) {
      if (seen.has(resource)) continue;
      seen.add(resource);
      const material = resource as THREE.Material;
      if (material.isMaterial) disposeMaterial(material, seen);
      else resource.dispose();
    }
    this.objects.clear();
    this.targets.clear();
    this.generic.clear();
  }
}
