import { defineConfig } from 'tsdown';

export default defineConfig({
  // Named entries, not an array: entries no longer share one common base directory once
  // scripts/migrate.ts joined src/app/*.ts, and the array form would nest output under
  // dist/src/app/ and dist/scripts/ instead of the flat dist/api.mjs etc. that the Dockerfile
  // CMD and Railway's pre-deploy command (.railway/railway.ts) both expect.
  entry: {
    api: 'src/app/api.ts',
    worker: 'src/app/worker.ts',
    migrate: 'scripts/migrate.ts',
  },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  sourcemap: true,
});
