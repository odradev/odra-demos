import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths, so the build works from any directory of a static host.
  base: "./",
  build: { target: "es2022" },
  // The wasm packages load their .wasm files relative to their own modules: leave them as they are.
  optimizeDeps: { exclude: ["attestations-wasm-client", "attestations-storage-reader"] },
  // The logo and the favicon of the shared Odra style (see ../../style/README.md).
  publicDir: "../../style/public",
  // The wasm packages, the contract schemas and the shared style live above web/.
  server: { fs: { allow: ["../.."] } },
});
