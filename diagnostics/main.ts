import * as THREE from 'three';
import { createStage, capabilities, ssao, StudioLighting, type EffectsOptions } from '../src/three';

const report = document.getElementById('report')!;
const anchor = document.getElementById('view') as HTMLElement;
const lines: string[] = [];

function row(label: string, value: string | number | boolean, warn = false): void {
  lines.push(
    `<tr${warn ? ' class="warn"' : ''}><th>${label}</th><td>${String(value)}</td></tr>`,
  );
  report.innerHTML = `<table>${lines.join('')}</table>`;
}

const stage = createStage({ maxPixelRatio: 2 });
const caps = capabilities();
const gl = stage.core.renderer.getContext() as WebGL2RenderingContext;

row('GPU', caps.renderer);
row('device pixel ratio', `${window.devicePixelRatio} (capped to ${stage.core.pixelRatio})`);
row('viewport', `${window.innerWidth}x${window.innerHeight}`);
row('WebGL2', gl instanceof WebGL2RenderingContext);
row('half-float render targets', caps.halfFloatTargets, !caps.halfFloatTargets);
row('float render targets', caps.floatTargets, !caps.floatTargets);
row('max MSAA samples', caps.maxSamples, caps.maxSamples < 4);
row('max texture size', caps.maxTextureSize, caps.maxTextureSize < 4096);
row('reduced motion', stage.reducedMotion);
row('touch points', navigator.maxTouchPoints);

const effects: EffectsOptions = {
  depthTexture: true,
  taa: true,
  passes: ssao({ radius: 0.6, power: 3 }),
};

const view = stage.createView({
  element: anchor,
  camera: new THREE.PerspectiveCamera(38, 1, 0.1, 100),
  effects,
});

view.camera.position.set(0, 1.1, 3.6);
view.camera.lookAt(0, 0.2, 0);
stage.environment.apply(view.scene, stage.environment.room(), { intensity: 1.2 });
view.resources.track(new StudioLighting({ shadowExtent: 3 }).attach(view.scene));

const mesh = view.add(
  new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.62, 0.2, 180, 32),
    new THREE.MeshStandardMaterial({ color: 0x8899ff, metalness: 0.85, roughness: 0.2 }),
  ),
);

stage.onBeforeRender((delta) => {
  mesh.rotation.y += delta * 0.6;
});

// let it warm up, then report what the chain actually built and how fast it runs
setTimeout(() => {
  const composer = view.composer;
  const taa = composer?.taaPass;

  row('effect chain built', composer !== null, composer === null);
  row(
    'target format',
    composer?.composer.renderTarget1.texture.type === THREE.HalfFloatType ? 'half-float' : '8-bit fallback',
  );
  row('velocity buffer', taa?.velocity ? 'yes' : 'no');
  row('TAA frames accumulated', taa?.frame ?? 0, (taa?.frame ?? 0) === 0);

  let frames = 0;
  const started = performance.now();
  const stop = stage.onAfterRender(() => {
    frames += 1;
  });

  setTimeout(() => {
    stop();
    const seconds = (performance.now() - started) / 1000;
    const fps = frames / seconds;
    row('sustained fps', fps.toFixed(0), fps < 30);
    row('textures resident', stage.core.renderer.info.memory.textures);
    report.insertAdjacentHTML(
      'beforeend',
      '<p id="done">Diagnostics complete — send this back.</p>',
    );
  }, 3000);
}, 1500);
