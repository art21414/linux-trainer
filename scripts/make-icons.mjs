// Генерирует иконки приложения из рисунка Палыча: public/icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png.
// Запуск: node scripts/make-icons.mjs (нужен Playwright с Chromium).
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const out = await build({
  entryPoints: ["src/ui/mascot.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const mod = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
const inner = mod.PALYCH_SVG.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
  // убираем то, что видно только в эмоциях
  .replace(/<path class="p-vein"[^>]*\/>|<path class="p-sweat"[^>]*\/>|<g class="p-earsteam"[\s\S]*?<\/g>|<g class="p-zzz"[\s\S]*?<\/g>|<ellipse class="p-red"[^>]*\/>/g, "")
  .replace(/<path class="mo mo-(happy|angry|smug)"[^>]*\/>|<ellipse class="mo mo-shock"[^>]*\/>/g, "");

// rounded — обычная иконка; maskable — без скругления и с запасом по краям (Android сам обрежет)
const icon = (rounded, viewBox) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><clipPath id="c"><rect width="512" height="512" ${rounded ? 'rx="112"' : ""}/></clipPath></defs>
  <g clip-path="url(#c)">
    <rect width="512" height="512" fill="#58cc02"/>
    <circle cx="256" cy="230" r="200" fill="#6bdc14"/>
    <svg width="512" height="512" viewBox="${viewBox}">${inner}</svg>
  </g>
</svg>`;

writeFileSync("public/icon.svg", icon(true, "42 22 156 156"));
writeFileSync("public/icon-maskable.svg", icon(false, "10 -6 220 220"));

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, src, size] of [
  ["public/icon-192.png", "public/icon.svg", 192],
  ["public/icon-512.png", "public/icon.svg", 512],
  ["public/icon-maskable-512.png", "public/icon-maskable.svg", 512],
]) {
  await page.setViewportSize({ width: size, height: size });
  const svg = (await import("node:fs")).readFileSync(src, "utf8");
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true });
}
await browser.close();
console.log("icons ok");
