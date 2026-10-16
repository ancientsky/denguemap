/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// GitHub Pages project site: https://ancientsky.github.io/denguemap/
export default defineConfig({
  base: '/denguemap/',
  build: {
    target: 'es2022',
    // No inline scripts in the output (CSP script-src 'self'): disable the modulepreload polyfill.
    modulePreload: { polyfill: false },
    // Never inline assets as data: URLs (the MapLibre worker must be a same-origin file).
    assetsInlineLimit: 0,
    cssCodeSplit: true,
    sourcemap: false,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // MapLibre is its own chunk (only loaded by map views).
            { name: 'maplibre', test: /node_modules[\\/]maplibre-gl[\\/]/, priority: 20 },
            // ECharts (+ zrender) is only imported by the lazily-loaded trends view.
            { name: 'echarts', test: /node_modules[\\/](echarts|zrender|tslib)[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
  preview: { port: 4173, strictPort: true },
  server: { port: 5173 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
