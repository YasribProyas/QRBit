import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// Default environment is `node`: most of src/lib is pure logic (crypto,
// chunker, protocol, library) and runs fastest headless.
// Tests that need the DOM must opt in per-file with a docblock on line 1:
//   /** @vitest-environment jsdom */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
  },
})
