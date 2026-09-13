import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // `scripts/**` is here because the operator CLIs have testable pure parts (smoke.ts's
          // assertions, the status-claims matcher) and a test outside the suite is a test that
          // rots unnoticed. They need no containers, so they belong in the unit project.
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
