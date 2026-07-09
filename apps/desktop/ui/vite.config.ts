import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port and localhost.
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    chunkSizeWarningLimit: 1200,
    // Tauri v2 uses Chromium on Windows and WebKit on macOS/Linux.
    // Target reasonably modern engines to avoid excessive down-leveling.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome120' : 'safari16',
    // Disable minification for debug builds.
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    // Produce sourcemaps for debug builds.
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    outDir: 'dist',
  },
})
