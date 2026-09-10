export { capabilities, detectCapabilities, preferredTargetType, clampSamples } from './Capabilities';
export type { Capabilities } from './Capabilities';

export { RendererCore } from './RendererCore';
export type { RendererCoreOptions, RendererCoreEvents } from './RendererCore';

export { View, ViewRegistry } from './View';
export type { ViewOptions, ViewEvents, ViewRect } from './View';

export { ViewComposer } from './Effects';
export type { EffectsOptions, EffectPassContext, EffectPassFactory, DepthConsumer, FrameHooks } from './Effects';

export { SSAOPass, ssao } from './SSAOPass';
export type { SSAOOptions } from './SSAOPass';

export { TAAPass } from './TAAPass';
export type { TAAOptions } from './TAAPass';

export { VelocityBuffer } from './VelocityBuffer';

export { PointerPipeline } from './PointerPipeline';
export type { PointerEvents, PointerPayload } from './PointerPipeline';

export { StudioLighting } from './LightingRig';
export type { StudioLightingOptions } from './LightingRig';

export { EnvironmentManager } from './Environment';
export type { ApplyEnvironmentOptions } from './Environment';

export { Stage, createStage, getStage, destroyStage } from './Stage';
export type { StageOptions, FrameCallback } from './Stage';

export { ResourceTracker } from './ResourceTracker';
export { Emitter } from './Emitter';
export type { Unsubscribe } from './Emitter';

export {
  disposeMaterial,
  disposeMaterialTextures,
  disposeObject,
  disposeScene,
  disposeRenderTarget,
} from './Disposal';
export type { DisposeSceneOptions } from './Disposal';
