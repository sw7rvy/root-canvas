export default ({ command }) => ({
  base: command === 'build' ? '/root-canvas/' : '/',
  resolve: { dedupe: ['three'] },
  optimizeDeps: { include: ['three'] },
});
