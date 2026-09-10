export default ({ command }) => ({
  base: command === 'build' ? '/root-canvas/' : '/',
  resolve: { dedupe: ['three'] },
  optimizeDeps: { include: ['three'] },
  // the test server must not hot-reload: a reload mid-test destroys the
  // execution context that page.evaluate is running in
  server: { hmr: process.env.VITE_NO_HMR ? false : undefined },
  build: {
    rollupOptions: {
      input: { main: 'index.html', diagnostics: 'diagnostics/index.html' },
    },
  },
});
