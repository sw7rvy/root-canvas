export default {
  build: {
    outDir: 'lib',
    sourcemap: true,
    lib: {
      entry: 'src/three/index.ts',
      formats: ['es'],
      fileName: () => 'root-canvas.js',
    },
    rollupOptions: {
      // three must stay external: bundling it would give consumers a second
      // copy, which breaks instanceof checks inside EffectComposer
      external: [/^three($|\/)/],
    },
  },
  resolve: { dedupe: ['three'] },
};
