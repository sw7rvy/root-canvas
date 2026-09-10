import * as THREE from 'three';

export interface Capabilities {
  /** Whether RGBA16F can be rendered into, not merely sampled. */
  halfFloatTargets: boolean;
  /** Whether RGBA32F can be rendered into. */
  floatTargets: boolean;
  /** Upper bound for MSAA on this device — commonly 4 on mobile, 8 on desktop. */
  maxSamples: number;
  /** Largest texture dimension the driver accepts. */
  maxTextureSize: number;
  /** Unmasked GPU string where the driver exposes it. */
  renderer: string;
}

const OPTIMISTIC: Capabilities = {
  halfFloatTargets: true,
  floatTargets: true,
  maxSamples: 4,
  maxTextureSize: 4096,
  renderer: 'unknown',
};

let cached: Capabilities = OPTIMISTIC;

/**
 * The architecture runs a single renderer, so capabilities are resolved once
 * and read from anywhere — passes build their render targets in constructors,
 * long before they would otherwise get a context to ask.
 */
export function detectCapabilities(renderer: THREE.WebGLRenderer): Capabilities {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');

  cached = {
    // WebGL2 can sample half-float textures without an extension, but rendering
    // into one needs this; without it every composer target is incomplete
    halfFloatTargets:
      gl.getExtension('EXT_color_buffer_half_float') !== null ||
      gl.getExtension('EXT_color_buffer_float') !== null,
    floatTargets: gl.getExtension('EXT_color_buffer_float') !== null,
    maxSamples: (gl.getParameter(gl.MAX_SAMPLES) as number) ?? 0,
    maxTextureSize: (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) ?? 2048,
    renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unknown',
  };

  if (!cached.halfFloatTargets) {
    console.warn(
      '[root-canvas] this device cannot render to half-float targets; ' +
        'effect chains fall back to 8-bit, which will band on HDR gradients',
    );
  }

  return cached;
}

export function capabilities(): Capabilities {
  return cached;
}

/** The best colour format this device can actually render into. */
export function preferredTargetType(requested?: THREE.TextureDataType): THREE.TextureDataType {
  if (requested !== undefined) {
    if (requested === THREE.HalfFloatType && !cached.halfFloatTargets) return THREE.UnsignedByteType;
    if (requested === THREE.FloatType && !cached.floatTargets) {
      return cached.halfFloatTargets ? THREE.HalfFloatType : THREE.UnsignedByteType;
    }
    return requested;
  }

  return cached.halfFloatTargets ? THREE.HalfFloatType : THREE.UnsignedByteType;
}

/** Asking for more samples than the driver supports makes a target incomplete. */
export function clampSamples(requested: number): number {
  if (requested <= 0) return 0;
  return Math.min(requested, cached.maxSamples);
}
