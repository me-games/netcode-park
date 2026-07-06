import { defineConfig } from "vite";

// base: './' so the built game works under the published subpath.
export default defineConfig({
  base: "./",
  server: {
    // 5173 is the Genex dashboard; let Vite pick the next free port.
    port: 5174,
    strictPort: false,
  },
  optimizeDeps: {
    // colyseus.js (inside @genex-ai/multiplayer) is CJS and pulls in tslib;
    // force these through the pre-bundler together so tslib is inlined and the
    // dev bundle never emits a browser `require("tslib")` (which throws).
    include: ["@genex-ai/multiplayer", "colyseus.js", "tslib"],
  },
});
