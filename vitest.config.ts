import { defineConfig } from 'vitest/config';

export default defineConfig({
  envFile: false,
  test: {
    pool: 'forks',
  },
});

