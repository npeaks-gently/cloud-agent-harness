import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          root: './sdk',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          root: './sdk',
          include: ['src/**/*.integration.test.ts'],
          testTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'infra-unit',
          root: './infra',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'cloud-unit',
          root: '.',
          include: ['src/cloud/**/*.test.ts'],
          exclude: ['src/cloud/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'cloud-integration',
          root: '.',
          include: ['src/cloud/**/*.integration.test.ts'],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
