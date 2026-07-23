import { defineConfig } from 'vite';

// Dev-only config. The dev-server port comes from the environment when a
// harness assigns one (so previews can run alongside other sessions);
// falls back to Vite's default 5173.
export default defineConfig({
  server: { port: Number(process.env.PORT) || 5173 },
});
