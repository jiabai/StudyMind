import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

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
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/react/") || id.includes("react-dom") || id.includes("/scheduler/")) return "react";
          if (
            id.includes("react-markdown") ||
            id.includes("/remark") ||
            id.includes("/rehype") ||
            id.includes("/micromark") ||
            id.includes("/mdast") ||
            id.includes("/hast") ||
            id.includes("/unist") ||
            id.includes("/unified") ||
            id.includes("/vfile")
          )
            return "markdown";
          if (id.includes("i18next")) return "i18n";
          return "vendor";
        },
      },
    },
  },
}));
