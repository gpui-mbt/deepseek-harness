import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    control: 'lib/types/control.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
