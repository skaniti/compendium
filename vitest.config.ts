import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ESM has no __dirname (the package is "type": "module" for Next 16 / Turbopack);
// recreate it so the "@" alias matches tsconfig's "@/*" -> "./*".
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Vitest 4 exits 1 on an empty run by default; keep `npm test` green when no
    // files match (fresh clone before tests exist, or a dev filter that misses).
    passWithNoTests: true,
  },
  resolve: { alias: { "@": __dirname } },
});
