import * as THREE from 'three';
import { disposeObject } from './Disposal';

export interface StudioLightingOptions {
  intensity?: number;
  keyColor?: THREE.ColorRepresentation;
  fillColor?: THREE.ColorRepresentation;
  rimColor?: THREE.ColorRepresentation;
  ambientColor?: THREE.ColorRepresentation;
  ambientIntensity?: number;
  hemisphere?: boolean;
  shadows?: boolean;
  shadowMapSize?: number;
  shadowRadius?: number;
  shadowExtent?: number;
}

export class StudioLighting {
  readonly group = new THREE.Group();
  readonly key: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  readonly rim: THREE.DirectionalLight;
  readonly ambient: THREE.AmbientLight;
  readonly hemi: THREE.HemisphereLight | null;

  constructor(options: StudioLightingOptions = {}) {
    const {
      intensity = 1,
      keyColor = 0xffffff,
      fillColor = 0xdfe8ff,
      rimColor = 0xfff2e0,
      ambientColor = 0xffffff,
      ambientIntensity = 0.35,
      hemisphere = true,
      shadows = true,
      shadowMapSize = 2048,
      shadowRadius = 3,
      shadowExtent = 8,
    } = options;

    this.group.name = 'StudioLighting';

    this.key = new THREE.DirectionalLight(keyColor, 3 * intensity);
    this.key.position.set(4, 6, 5);
    this.key.castShadow = shadows;
    this.configureShadow(this.key, shadowMapSize, shadowRadius, shadowExtent);

    this.fill = new THREE.DirectionalLight(fillColor, 1.1 * intensity);
    this.fill.position.set(-5, 2.5, 3.5);

    this.rim = new THREE.DirectionalLight(rimColor, 1.8 * intensity);
    this.rim.position.set(-2, 3, -6);

    this.ambient = new THREE.AmbientLight(ambientColor, ambientIntensity * intensity);

    this.hemi = hemisphere ? new THREE.HemisphereLight(0xbcd4ff, 0x2b2118, 0.6 * intensity) : null;

    this.group.add(this.key, this.key.target, this.fill, this.rim, this.ambient);
    if (this.hemi) this.group.add(this.hemi);
  }

  attach(scene: THREE.Scene): this {
    scene.add(this.group);
    return this;
  }

  setTarget(target: THREE.Object3D): this {
    this.key.target = target;
    this.fill.target = target;
    this.rim.target = target;
    return this;
  }

  setIntensity(scale: number): this {
    this.key.intensity = 3 * scale;
    this.fill.intensity = 1.1 * scale;
    this.rim.intensity = 1.8 * scale;
    this.ambient.intensity = 0.35 * scale;
    if (this.hemi) this.hemi.intensity = 0.6 * scale;
    return this;
  }

  dispose(): void {
    disposeObject(this.group);
  }

  private configureShadow(light: THREE.DirectionalLight, mapSize: number, radius: number, extent: number): void {
    const { shadow } = light;
    shadow.mapSize.setScalar(mapSize);
    shadow.radius = radius;
    shadow.bias = -0.0005;
    shadow.normalBias = 0.02;

    const camera = shadow.camera;
    camera.near = 0.5;
    camera.far = 50;
    camera.left = -extent;
    camera.right = extent;
    camera.top = extent;
    camera.bottom = -extent;
    camera.updateProjectionMatrix();
  }
}
