# Root Canvas

One `WebGLRenderer`, one full-page canvas, many independent 3D views anchored to DOM elements — each with its own scene, camera, post-processing chain, and lifecycle.

Adding 3D to a component does not allocate a WebGL context. Browsers cap contexts (typically 8–16) and silently drop the oldest when you exceed it; this architecture never gets near that limit no matter how many components render 3D.

**[Live demo →](https://sw7rvy.github.io/root-canvas/)**

Four views on one canvas, each with a different chain: SSAO + TAA over a scene exercising every motion-vector path; bloom with alpha preserved over the page; a full-view dot-screen; and a stencil-masked effect. Scroll — views render only while their anchor is on screen.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static bundle in dist/
```

## Quick start

```ts
import * as THREE from 'three';
import { createStage, StudioLighting } from './src/three';

const stage = createStage({ maxPixelRatio: 2, exposure: 1.1 });
const envMap = stage.environment.room();

const view = stage.createView({
  element: document.querySelector('#hero')!,
  camera: new THREE.PerspectiveCamera(35, 1, 0.1, 100),
});

view.camera.position.set(0, 1.2, 4);
stage.environment.apply(view.scene, envMap, { intensity: 1.2 });
view.resources.track(new StudioLighting().attach(view.scene));

const mesh = view.add(
  new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.22), new THREE.MeshStandardMaterial()),
);

stage.onBeforeRender((delta) => {
  if (view.onScreen) mesh.rotation.y += delta * 0.6;
});
```

`view.add()` and `view.resources.track()` register objects for disposal. `stage.removeView(view)` or `destroyStage()` frees everything.

## How the shared canvas works

The canvas is `position: fixed; inset: 0; pointer-events: none`, sitting behind (or above) the page. Each `View` binds to a **DOM anchor element**. Every frame the registry measures the anchors, then renders each view with `setViewport`/`setScissor` mapped to its anchor's rect:

```
┌─ canvas (fixed, full viewport) ──────────────┐
│   ┌──────────┐                               │
│   │ #hero    │  ← view 1: scissor + viewport │
│   └──────────┘                               │
│              ┌──────────┐                    │
│              │ #product │  ← view 2          │
│              └──────────┘                    │
└──────────────────────────────────────────────┘
```

Scissor rects are clamped to the canvas; viewports are not, so projection stays correct when an anchor is partly off-screen. Views off-screen entirely are skipped (`renderOnlyWhenOnScreen`, default `true`).

Because the canvas ignores pointer events, input is captured once on `window` and hit-tested against anchor rects by descending `priority`, then converted to per-view NDC with a shared `Raycaster`.

## Files

| File | Responsibility |
| --- | --- |
| `RendererCore.ts` | Singleton `WebGLRenderer` + canvas, pixel ratio, resize, context-loss guards |
| `Stage.ts` | Single RAF loop, frame hooks, lifecycle, module-level singleton |
| `View.ts` | `View` + `ViewRegistry` — scissored multi-view rendering |
| `PointerPipeline.ts` | One set of window listeners → hit-tested, per-view raycast events |
| `LightingRig.ts` | Studio three-point rig with configured shadow frustum |
| `Environment.ts` | PMREM environment maps (RoomEnvironment / HDR), cached |
| `Effects.ts` | `ViewComposer` — per-view `EffectComposer` |
| `SSAOPass.ts` | Depth-driven screen-space ambient occlusion |
| `TAAPass.ts` | Temporal anti-aliasing (jitter + reprojection + neighbourhood clamp) |
| `VelocityBuffer.ts` | Motion vectors for every three.js mesh type |
| `Disposal.ts` | Recursive disposal of geometries, materials, textures, render targets |
| `ResourceTracker.ts` | Scoped registry → one `dispose()` per feature |
| `Emitter.ts` | Typed pub/sub with unsubscribe handles |

## Stage & renderer

```ts
createStage({
  maxPixelRatio: 2,      // capped DPR — the single biggest perf lever
  exposure: 1.1,
  toneMapping: THREE.ACESFilmicToneMapping,   // default
  shadows: true,
  stencil: true,         // default; needed for MaskPass
  alpha: true,
  antialias: true,
  autoStart: true,
  pauseWhenHidden: true, // stop the RAF loop on tab blur
  maxDelta: 1 / 20,      // clamp delta after a stall
});
```

Defaults worth knowing:

- `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`
- `autoClear = false` — the frame clears once full-canvas, then each view clears depth (or colour, if it declares `clearColor`)
- Pixel ratio is `min(devicePixelRatio, maxPixelRatio)`, re-evaluated through a self-rearming `matchMedia("(resolution: Xdppx)")` watcher, so monitor changes and browser zoom are caught, not just window resizes

### Context loss

`webglcontextlost` is `preventDefault()`ed, the loop stops, and on restore the pixel ratio is reapplied, shadows are flagged for update, PMREM environments are regenerated (they do not survive), and TAA/velocity history is dropped. Subscribe via `stage.core.events.on('contextlost' | 'contextrestored', …)`.

## Views

```ts
stage.createView({
  element,                      // required DOM anchor
  scene, camera,                // optional; created if omitted
  priority: 1,                  // render + hit-test order
  interactive: true,
  clearColor: null,             // null = transparent, page shows through
  clearAlpha: 1,
  renderOnlyWhenOnScreen: true,
  disposeSceneOnDestroy: true,
  effects: { … },               // see below
  onUpdate: (delta, elapsed, view) => {},
  onRender: (renderer, view, delta) => {},  // full override
});
```

Per-view events: `pointermove`, `pointerdown`, `pointerup`, `pointerenter`, `pointerleave`, `click`, `wheel`, `resize`, `visibility`, `dispose`.

```ts
view.on('pointermove', ({ intersect, ndc, view }) => {
  view.element.style.cursor = intersect([mesh]).length ? 'grab' : '';
});
```

Cameras are kept in sync with the anchor's aspect automatically (perspective and orthographic).

## Post-processing

Per view, opt in with `effects`. The chain is assembled as:

```
RenderPass → [SavePass] → your passes → [AlphaRestore] → [TAAPass] → [OutputPass]
```

```ts
effects: {
  passes: ({ view, scene, camera, renderer, composer, renderPass, width, height, useSceneDepth }) =>
    new UnrealBloomPass(new THREE.Vector2(width, height), 0.55, 0.35, 0.85),
  samples: 4,            // MSAA on the composer target
  preserveAlpha: true,
  taa: true,
  depthTexture: true,
  resolutionScale: 1,    // render the chain below DPR
  type: THREE.HalfFloatType,
  output: true,          // append OutputPass
  blend: true,           // premultiplied composite onto the shared canvas
  stencil: true,         // inherits the context setting
}
```

The composer's final pass writes straight into the view's viewport/scissor on the shared canvas, blended with premultiplied alpha so a transparent view composites over the page instead of stamping an opaque rectangle.

**`preserveAlpha`** exists because some passes destroy alpha. `UnrealBloomPass` composites additively with alpha 1 across the whole quad, flattening a transparent view to opaque black. With it enabled, a `SavePass` captures the scene after `RenderPass` and a pass before `OutputPass` restores alpha in linear space:

```glsl
float added = max(0.0, dot(post.rgb - source.rgb, vec3(0.2126, 0.7152, 0.0722)));
gl_FragColor = vec4(post.rgb, clamp(source.a + added * spill, 0.0, 1.0));
```

`alphaSpill: 0` clips to the scene silhouette; `1` (default) lets glow carry alpha so bloom fades into the page. Skip it for views with an opaque `clearColor`.

### SSAO

```ts
effects: { depthTexture: true, passes: ssao({ radius: 0.6, power: 3 }) }
```

| Option | Default | Notes |
| --- | --- | --- |
| `kernelSize` | 32 | Hemisphere samples |
| `radius` | 0.25 | **World units** — scale to your scene |
| `bias` | 0.02 | Self-occlusion guard |
| `intensity` | 1 | Blend against unoccluded |
| `power` | 2.5 | Contrast exponent; without it AO on convex scenes reads as almost nothing |
| `blurDepthCutoff` | `radius` | Bilateral blur depth threshold |
| `output` | `'default'` | `'ao'` renders the raw AO buffer for tuning |

This is a custom pass rather than three's. `SSAOPass` hardcodes its own normal/depth G-buffer and re-renders the scene every frame with `MeshNormalMaterial` — an injected depth texture is impossible. `GTAOPass` accepts one, but that path throws in r180: `normalRenderTarget` is only assigned in `setGBuffer`'s internal branch, so the last line of that method dereferences `undefined`.

Normals are reconstructed from depth by a best-fit tap — sample left/right and down/up, take the tangent toward whichever neighbour's depth is closer to centre. Naive `dFdx`/`dFdy` reads across silhouettes and produces a dark rim tracing every outline. The blur is depth-weighted for the same reason.

### TAA

```ts
effects: { taa: true }                       // implies depthTexture
effects: { taa: { feedback: 0.9, velocity: true } }
```

| Option | Default | Notes |
| --- | --- | --- |
| `feedback` | 0.9 | History weight — stability vs responsiveness |
| `clampScale` | 1 | Neighbourhood rejection box size |
| `jitterScale` | 1 | Subpixel jitter amplitude |
| `sequenceLength` | 16 | Halton sequence length |
| `velocity` | `true` | Motion-vector buffer (second scene render) |

Each frame the projection matrix is offset by a Halton(2,3) subpixel jitter before the scene renders and restored after; `projectionMatrixInverse` is refreshed alongside so SSAO's reconstruction matches the jittered depth. Resolve reprojects, clamps history to the 3×3 colour box of the current frame, and blends with Karis luminance weighting so highlights don't flicker.

Jitter is applied through the generic `FrameHooks` interface — any pass may implement `onBeforeComposerRender` / `onAfterComposerRender` / `reset` and `ViewComposer` calls them around `composer.render()`.

### Velocity buffer

Without motion vectors, reprojection is camera-only: moving objects get their history rejected by the clamp and see no temporal benefit. The velocity pass renders the scene once more (unjittered) writing screen-space motion:

```glsl
gl_FragColor = vec4( currentUv - previousUv, 1.0, gl_FragCoord.z );
```

`.z` marks written pixels, `.w` carries depth for a 3×3 nearest-depth dilation that fixes edge ghosting. Pixels with no geometry fall back to depth reprojection, which covers camera motion over empty background.

Every three.js mesh type is handled. Three supplies the *current* transform for free — `USE_SKINNING`, `USE_INSTANCING`, `USE_MORPHTARGETS`, `USE_BATCHING` and their uniforms are set for any material — so the work is retaining the *previous* one:

| Source | Previous state |
| --- | --- |
| Object transform | `Matrix4` per mesh |
| `SkinnedMesh` | Mirror of `skeleton.boneMatrices` as a `DataTexture` |
| `InstancedMesh` | Mirror of `instanceMatrix`, fetched by `gl_InstanceID` |
| Morph targets | Previous influences (the morph texture itself is static) |
| Per-instance morphs | Mirror of `InstancedMesh.morphTexture` |
| `BatchedMesh` | Mirror of `_matricesTexture`, resolved through the **current** `getIndirectIndex(gl_DrawID)` |

Batched instances must be looked up by resolved id, not draw index — visibility and sort order change which instance a draw corresponds to, and using last frame's id texture would hand an instance its neighbour's history.

`Points`, `Line`, and `Sprite` are hidden during the pass. `BatchedMesh` support reads `_matricesTexture`, an internal three field with no public accessor; the mesh is skipped cleanly if it disappears.

## Memory

Three layers, all verified to return `renderer.info.memory` to zero:

```ts
view.add(mesh);                  // tracked, disposed with the view
view.resources.track(lighting);  // anything with dispose()
stage.removeView(view);          // disposes the view and its scene
destroyStage();                  // everything, including the canvas
```

`disposeObject` walks a subtree disposing geometries, materials, every texture referenced by material properties **and** shader uniforms, render targets, skeletons, and light shadow maps, guarding against double-disposal of shared resources. It also calls `dispose()` on `InstancedMesh` and `BatchedMesh` — those own textures (`morphTexture`, `_matricesTexture`) that nothing else frees.

## three.js notes

Things worth knowing before extending this, each of which cost real debugging time:

- **`EffectComposer.dispose()` does not dispose its passes.** `ViewComposer` tracks and disposes every pass it adds; passes pushed directly onto `composer.passes` are not tracked.
- **Read/write buffers never reset between frames.** With an odd number of swapping passes, the buffer `RenderPass` draws into alternates each frame — and so does its depth texture, since `RenderTarget.copy` *clones* rather than shares it. Anything sampling scene depth must re-bind per frame; use `useSceneDepth(consumer)` rather than caching the texture.
- **Three injects `<common>` into every `ShaderMaterial`,** which defines `luminance(const in vec3)`. An identically named helper fails to link and the pass renders black. Avoid three's chunk function names.
- **Every non-`RawShaderMaterial` compiles as `#version 300 es`** with ESSL1 compatibility defines, so `texelFetch`, `textureSize`, `gl_InstanceID`, and `gl_VertexID` are available in your own shaders.
- **`MaskPass` needs a stencil buffer** on the context *and* on the composer's render targets. Both are on by default here; `createStage({ stencil: false })` or `effects: { stencil: false }` opts out.
- **Multiple copies of three break `instanceof`** checks inside `EffectComposer.render`. `vite.config.js` sets `resolve.dedupe: ['three']`.

## Deploying the demo

`.github/workflows/deploy.yml` typechecks, builds and publishes to GitHub Pages on every push to `master`, and can be run by hand from the Actions tab. `vite.config.js` sets `base` to `/root-canvas/` for builds only, so local dev still serves from `/`.

The `gh-pages` branch it replaced has been deleted; Pages now builds from the workflow artifact.

## Limitations

- Velocity for `Points` / `Line` / `Sprite` falls back to depth reprojection.
- SSAO reconstructs normals from depth, so silhouette edges are approximate. A real normal buffer would fix it at the cost of the extra G-buffer render this design avoids.
- TAA's velocity pass is a second full scene render. Set `taa: { velocity: false }` on heavy scenes to trade moving-object quality for the draw calls.
- No WebGPU path. `WebGLRenderer` only.
