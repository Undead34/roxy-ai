// @ts-check
import { defineConfig } from "astro/config";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://astro.build/config
export default defineConfig({
  publicDir: "./crates/frontend/public",
  srcDir: "./crates/frontend/src",
  outDir: "./.roxy/dist",
  cacheDir: "./.roxy/.astro",
  vite: {
    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/crates/backend/**"],
      },
    },
  },
});
