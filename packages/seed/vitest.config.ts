import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suites here are pure — the RNG, the module graph, and the corpus
    // checked against the API's real rich-text schema. Nothing in this package's
    // tests touches Postgres; seeding itself is exercised by running it.
    fileParallelism: true,
  },
});
