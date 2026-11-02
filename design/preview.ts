// Стенд дизайн-системы: палитра, шрифты, иконки, компоненты, Палыч во всех настроениях.
// Запуск: npm run dev → http://localhost:5173/linux-trainer/design/preview.html (не входит в сборку).
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/cyrillic-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/cyrillic-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/cyrillic-400.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "@fontsource/ibm-plex-mono/cyrillic-600.css";
import "@fontsource/pixelify-sans/latin-600.css";
import "@fontsource/pixelify-sans/cyrillic-600.css";
import "../src/styles/tokens.css";
import "../src/styles/mascot.css";
import "./preview.css";
import { icon, ICON_NAMES } from "../src/ui/icons";
import { Mascot } from "../src/ui/mascot";
import type { Mood } from "../src/ui/mascot";

const root = document.getElementById("root")!;
const sec = (title: string, html: string) => { const s = document.createElement("section"); s.innerHTML = `<h2>${title}</h2>${html}`; root.append(s); return s; };

const vars = ["bg", "surface", "surface-2", "term", "line", "line-strong", "text", "text-2", "muted", "accent", "ok", "err", "warn"];
sec("palette", `<div class="sw">${vars.map((v) => `<div><i style="background:var(--c-${v})"></i><b>--c-${v}</b></div>`).join("")}</div>`);

sec("type", `
<div class="pix">Linux Тренажёр 01</div>
<h3>Заголовок раздела на Plex Sans</h3>
<p>Права доступа: <code>chmod 640 file</code> — владелец читает и пишет, группа читает, остальным нельзя. Текст урока на IBM Plex Sans 400/600.</p>
<pre>[user@server1 ~]$ ls -l /etc/shadow
---------- 1 root root 1287 Nov  1 09:12 /etc/shadow</pre>`);

const s = sec("icons", `<div class="ic"></div>`);
const ic = s.querySelector(".ic")!;
for (const n of ICON_NAMES) { const d = document.createElement("div"); d.append(icon(n, { size: 24 }), Object.assign(document.createElement("span"), { textContent: n })); ic.append(d); }

sec("components", `
<button class="b">Проверить</button> <button class="b ghost">Подсказка</button> <button class="b" disabled>Закрыто</button>
<div class="rows">
 <div class="row run"><span class="pid">01</span><span class="nm">Права и владельцы</span><span class="bar">[####....]</span><span class="st">R</span></div>
 <div class="row"><span class="pid">02</span><span class="nm">umask и setgid</span><span class="bar">[........]</span><span class="st">S</span></div>
 <div class="row"><span class="pid">03</span><span class="nm">Процессы и сигналы</span><span class="bar">[########]</span><span class="st ok">0</span></div>
</div>
<div class="res ok"><b>OK</b> exit 0 · +10 XP</div>
<div class="res err"><b>FAIL</b> exit 1 · chmod: invalid mode</div>
<div class="trap"><b>ЛОВУШКА</b> 0640 и 640 — одно и то же, а вот 0o640 в bash не работает.</div>`);

const ms: Mood[] = ["idle", "happy", "angry", "shock", "think", "sleep", "smug", "facepalm", "proud", "typing", "nervous", "bored"];
const s2 = sec("palych", `<div class="pg"></div>`);
const pg = s2.querySelector(".pg")!;
const q = new URLSearchParams(location.search);
for (const m of ms) {
  const c = document.createElement("div"); c.className = "cell";
  const mm = new Mascot({ size: "lg", bubble: false }); mm.setMood(m, 0); c.append(mm.el, Object.assign(document.createElement("span"), { textContent: m })); pg.append(c);
  if (q.get("still")) mm.destroy();
}
const big = sec("palych-big", `<div class="bigp"></div>`).querySelector(".bigp")!;
const bm = new Mascot({ size: "lg" }); big.append(bm.el); bm.say("Permission denied — это не обида, это безопасность.", 0);
(window as any).bm = bm;
