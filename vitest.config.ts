import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // Starting a Postgres container takes a few seconds, especially on the first image pull.
          hookTimeout: 120_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
