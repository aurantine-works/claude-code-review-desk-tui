import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.js'], testTimeout: 30000, setupFiles: ['test/helpers/setup-env.js'] } });
