import { defineConfig } from 'vite';

// Dev-only config. The dev-server port comes from the environment when a
// harness assigns one (so previews can run alongside other sessions);
// falls back to Vite's default 5173.
export default defineConfig({
  server: { port: Number(process.env.PORT) || 5173 },
  test: {
    // Agent worktrees live under .claude/ — testing them from the parent
    // checkout double-runs every suite and sweeps in scratch files.
    exclude: ['**/node_modules/**', '.claude/**'],
  },
});
