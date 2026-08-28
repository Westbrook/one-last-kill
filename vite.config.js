import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900,
    rolldownOptions: { input: { main: 'index.html', legacy: 'punisher-game.html' } },
  },
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
});
