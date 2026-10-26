import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Сайт живёт по адресу https://<user>.github.io/linux-trainer/
export default defineConfig({
  base: "/linux-trainer/",
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  resolve: {
    // just-bash тянет node:zlib для gzip — в браузере подменяем заглушкой
    alias: { "node:zlib": fileURLToPath(new URL("./src/shims/zlib.ts", import.meta.url)) },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
