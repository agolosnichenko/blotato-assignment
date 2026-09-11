import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/app/api.ts', 'src/app/worker.ts'],
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  sourcemap: true,
});
