// Палыч — талисман тренажёра. Старый сисадмин: майка, пузо, залысина, кофе и сигарета.
// Рисунок — inline SVG, анимации — CSS (см. styles/mascot.css), настроение — класс m-<mood>.
import { PHRASES, pick } from "../content/palych";
import type { PhraseKey } from "../content/palych";

export type Mood = "idle" | "happy" | "angry" | "shock" | "think" | "sleep" | "smug";

const SKIN = "#f3c7a2";
const LINE = "#3a2a22";
const HAIR = "#8d847b";

export const PALYCH_SVG = `
<svg class="palych m-idle" viewBox="0 0 240 250" aria-hidden="true">
  <ellipse cx="120" cy="243" rx="72" ry="6" fill="rgba(0,0,0,.35)"/>
  <g class="p-body">
    <path d="M60,160 C30,180 22,222 44,240 L196,240 C218,222 210,180 180,160 C160,150 80,150 60,160 Z" fill="${SKIN}" stroke="${LINE}" stroke-width="3"/>
    <path d="M116,233 Q121,237 126,233" stroke="#c48e6c" stroke-width="2" fill="none"/>
    <path d="M78,154 L90,153 C96,174 144,174 150,153 L162,154 C186,164 202,192 200,220 C160,229 80,229 40,220 C38,192 54,164 78,154 Z" fill="#ece5d3" stroke="${LINE}" stroke-width="3"/>
    <path d="M150,180 C160,174 174,178 172,188 C176,194 166,200 158,196 C148,200 142,190 150,180 Z" fill="#9b6a3c" opacity=".55"/>
    <path d="M164,198 C166,202 165,207 163,209" stroke="#9b6a3c" stroke-width="3" opacity=".45" stroke-linecap="round" fill="none"/>
    <text x="120" y="212" font-family="JetBrains Mono, monospace" font-size="12" font-weight="800" fill="#bfb5a0" transform="rotate(-5 134 208)">RTFM</text>
    <path d="M110,166 l2,4 M116,168 l1,4 M123,168 l-1,4 M129,166 l-2,4" stroke="${HAIR}" stroke-width="1.5" stroke-linecap="round"/>
  </g>
  <g class="p-arm-l">
    <path d="M66,164 Q40,192 54,212 Q64,222 84,206" stroke="${LINE}" stroke-width="25" stroke-linecap="round" fill="none"/>
    <path d="M66,164 Q40,192 54,212 Q64,222 84,206" stroke="${SKIN}" stroke-width="19" stroke-linecap="round" fill="none"/>
    <g class="p-steam" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round">
      <path class="s1" d="M94,178 q-4,-6 0,-12 q4,-6 0,-12"/>
      <path class="s2" d="M101,176 q-4,-6 0,-12 q4,-6 0,-12"/>
      <path class="s3" d="M108,178 q-4,-6 0,-12 q4,-6 0,-12"/>
    </g>
    <path d="M84,192 C72,192 72,210 84,210" stroke="#f7f7f2" stroke-width="5" fill="none"/>
    <path d="M84,192 C72,192 72,210 84,210" stroke="${LINE}" stroke-width="1.5" fill="none" opacity=".5"/>
    <rect x="84" y="182" width="30" height="34" rx="4" fill="#f7f7f2" stroke="${LINE}" stroke-width="2.5"/>
    <rect x="86" y="184" width="26" height="5" rx="2" fill="#5b3a21"/>
    <text x="99" y="205" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9" font-weight="800" fill="#2f9e44">&gt;_</text>
    <path d="M110,189 v7" stroke="#8a5a32" stroke-width="2" stroke-linecap="round" opacity=".6"/>
    <circle cx="84" cy="205" r="10" fill="${SKIN}" stroke="${LINE}" stroke-width="2.5"/>
  </g>
  <g class="p-arm-r">
    <path d="M174,164 Q206,178 207,198 Q207,170 196,146" stroke="${LINE}" stroke-width="25" stroke-linecap="round" fill="none"/>
    <path d="M174,164 Q206,178 207,198 Q207,170 196,146" stroke="${SKIN}" stroke-width="19" stroke-linecap="round" fill="none"/>
    <g class="p-smoke" fill="none" stroke="#cfd6dd" stroke-width="3" stroke-linecap="round">
      <path class="k1" d="M222,112 q6,-8 0,-16 q-6,-8 0,-16"/>
      <path class="k2" d="M222,112 q-6,-8 0,-16 q6,-8 0,-16"/>
    </g>
    <path d="M199,139 L220,118" stroke="${LINE}" stroke-width="7" stroke-linecap="round"/>
    <path d="M199,139 L220,118" stroke="#f5f5f5" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M198,140 L204,134" stroke="#e39a4a" stroke-width="4.5" stroke-linecap="round"/>
    <circle class="p-tip" cx="221" cy="117" r="3" fill="#ff5a1f"/>
    <circle cx="195" cy="144" r="10" fill="${SKIN}" stroke="${LINE}" stroke-width="2.5"/>
  </g>
  <path d="M104,136 L104,160 Q120,166 136,160 L136,136 Z" fill="${SKIN}" stroke="${LINE}" stroke-width="3"/>
  <g class="p-head">
    <ellipse cx="73" cy="102" rx="8" ry="12" fill="${SKIN}" stroke="${LINE}" stroke-width="3"/>
    <ellipse cx="167" cy="102" rx="8" ry="12" fill="${SKIN}" stroke="${LINE}" stroke-width="3"/>
    <g class="p-tufts" fill="${HAIR}" stroke="${LINE}" stroke-width="2">
      <path class="t-l" d="M80,112 C66,104 64,82 72,70 C75,78 78,77 80,72 C82,80 85,82 88,80 C86,92 88,100 86,110 Z"/>
      <path class="t-r" d="M160,112 C174,104 176,82 168,70 C165,78 162,77 160,72 C158,80 155,82 152,80 C154,92 152,100 154,110 Z"/>
    </g>
    <ellipse cx="120" cy="96" rx="46" ry="50" fill="${SKIN}" stroke="${LINE}" stroke-width="3"/>
    <ellipse class="p-red" cx="120" cy="98" rx="44" ry="48" fill="#ff3b2f" opacity="0"/>
    <ellipse cx="103" cy="60" rx="13" ry="7" fill="#fff" opacity=".5" transform="rotate(-22 103 60)"/>
    <path d="M94,56 Q120,44 148,58" stroke="${HAIR}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <path d="M98,52 Q122,42 144,52" stroke="${HAIR}" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path class="p-wrinkle" d="M102,72 Q120,68 138,72 M106,77 Q120,74 134,77" stroke="#d9a181" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <path d="M82,118 C86,150 104,152 120,152 C136,152 154,150 158,118 C150,136 136,140 120,140 C104,140 90,136 82,118 Z" fill="#8d847b" opacity=".3"/>
    <ellipse cx="91" cy="121" rx="7" ry="4" fill="#f08f7e" opacity=".45"/>
    <ellipse cx="149" cy="121" rx="7" ry="4" fill="#f08f7e" opacity=".45"/>
    <g class="p-eye p-eye-l"><ellipse cx="101" cy="98" rx="7.5" ry="6.5" fill="#fff"/><circle class="p-pupil" cx="101" cy="98.5" r="3.4" fill="#1d1d1d"/></g>
    <g class="p-eye p-eye-r"><ellipse cx="139" cy="98" rx="7.5" ry="6.5" fill="#fff"/><circle class="p-pupil" cx="139" cy="98.5" r="3.4" fill="#1d1d1d"/></g>
    <path d="M93,112 Q101,116 109,112 M131,112 Q139,116 147,112" stroke="#c48e6c" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <g fill="rgba(170,215,255,.16)" stroke="#1b1b1b" stroke-width="3.5">
      <rect x="85" y="86" width="32" height="24" rx="7"/>
      <rect x="123" y="86" width="32" height="24" rx="7"/>
    </g>
    <path d="M117,96 Q120,93 123,96 M85,94 L74,91 M155,94 L166,91" stroke="#1b1b1b" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M90,92 l6,-3 M128,92 l6,-3" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".7"/>
    <path class="p-brow p-brow-l" d="M88,82 Q100,75 113,81" stroke="#5a524b" stroke-width="5.5" fill="none" stroke-linecap="round"/>
    <path class="p-brow p-brow-r" d="M127,81 Q140,75 152,82" stroke="#5a524b" stroke-width="5.5" fill="none" stroke-linecap="round"/>
    <ellipse cx="120" cy="115" rx="9.5" ry="8.5" fill="#eea488" stroke="${LINE}" stroke-width="2"/>
    <ellipse cx="117" cy="112" rx="3" ry="2" fill="#fff" opacity=".5"/>
    <g class="p-mouth">
      <path class="mo mo-idle" d="M110,135 Q120,133 130,135" stroke="${LINE}" stroke-width="2.8" fill="none" stroke-linecap="round"/>
      <path class="mo mo-happy" d="M105,131 Q120,148 135,131 Q120,137 105,131 Z" fill="#7a2c22" stroke="${LINE}" stroke-width="2"/>
      <path class="mo mo-angry" d="M108,140 Q120,129 132,140" stroke="${LINE}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <ellipse class="mo mo-shock" cx="120" cy="137" rx="6" ry="8" fill="#4a1d17" stroke="${LINE}" stroke-width="2"/>
      <path class="mo mo-smug" d="M109,136 Q123,137 132,130" stroke="${LINE}" stroke-width="2.8" fill="none" stroke-linecap="round"/>
    </g>
    <path d="M99,125 C106,118 116,120 120,123 C124,120 134,118 141,125 C136,131 126,129 120,128 C114,129 104,131 99,125 Z" fill="#7b7168" stroke="${LINE}" stroke-width="1.5"/>
    <path class="p-vein" d="M146,62 l8,4 M150,58 l0,10 M146,66 l8,-4" stroke="#e03131" stroke-width="2.5" stroke-linecap="round"/>
    <path class="p-sweat" d="M162,70 C158,78 156,82 160,86 C164,89 168,85 166,80 C165,77 163,74 162,70 Z" fill="#74c0fc" stroke="#1971c2" stroke-width="1.5"/>
    <g class="p-earsteam" fill="#fff" opacity=".85">
      <circle cx="62" cy="92" r="5"/><circle cx="56" cy="84" r="4"/><circle cx="178" cy="92" r="5"/><circle cx="184" cy="84" r="4"/>
    </g>
    <g class="p-zzz" font-family="Nunito, sans-serif" font-weight="900" fill="#a5d8ff">
      <text class="z1" x="160" y="58" font-size="14">z</text>
      <text class="z2" x="170" y="44" font-size="18">z</text>
      <text class="z3" x="182" y="28" font-size="22">Z</text>
    </g>
  </g>
</svg>`;

/** Как Палыч реагирует на события. */
const REACTIONS: Record<PhraseKey, Mood> = {
  greet: "smug",
  correct: "happy",
  wrong: "angry",
  notfound: "think",
  unsupported: "think",
  danger: "shock",
  sudo: "smug",
  ok: "idle",
  error: "angry",
  clear: "smug",
  complete: "happy",
  su: "smug",
  idle: "sleep",
  near: "think",
  hint: "think",
  permission: "smug",
};

export class Mascot {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private bubble: HTMLElement | null;
  private timers: number[] = [];
  private moodTimer = 0;
  private sleepTimer = 0;
  private typeTimer = 0;
  private alive = true;

  constructor(opts: { size?: "lg" | "md" | "sm"; bubble?: boolean; greet?: boolean } = {}) {
    this.el = document.createElement("div");
    this.el.className = `palych-wrap palych-${opts.size ?? "md"}`;
    this.el.innerHTML = `<div class="palych-box">${PALYCH_SVG}</div>${opts.bubble === false ? "" : '<div class="bubble"><span class="bubble-text"></span></div>'}`;
    this.svg = this.el.querySelector("svg")!;
    this.bubble = this.el.querySelector(".bubble");
    this.el.querySelector(".palych-box")!.addEventListener("click", () => this.poke());
    this.loop();
    this.resetSleep();
    if (opts.greet) this.react("greet");
  }

  /** Тык в Палыча — он реагирует. */
  poke(): void {
    this.resetSleep();
    this.setMood(pick<Mood>(["smug", "angry", "think", "happy"]), 1800);
    this.say(pick(PHRASES.poke));
  }

  setMood(mood: Mood, ms = 2600): void {
    if (!this.alive) return;
    this.svg.classList.forEach((c) => c.startsWith("m-") && this.svg.classList.remove(c));
    this.svg.classList.add(`m-${mood}`);
    // перезапуск анимации настроения
    this.svg.classList.remove("pulse");
    void this.svg.getBoundingClientRect();
    this.svg.classList.add("pulse");
    clearTimeout(this.moodTimer);
    if (mood !== "idle" && mood !== "sleep" && ms > 0) {
      this.moodTimer = window.setTimeout(() => this.setMood("idle"), ms);
    }
  }

  say(text: string, ms = 4200): void {
    if (!this.bubble || !this.alive) return;
    const span = this.bubble.querySelector(".bubble-text")!;
    this.bubble.classList.remove("show");
    void this.bubble.offsetWidth;
    this.bubble.classList.add("show");
    clearInterval(this.typeTimer);
    let i = 0;
    span.textContent = "";
    this.typeTimer = window.setInterval(() => {
      i += 2;
      span.textContent = text.slice(0, i);
      if (i >= text.length) clearInterval(this.typeTimer);
    }, 22);
    if (ms > 0) {
      const t = window.setTimeout(() => this.bubble?.classList.remove("show"), ms);
      this.timers.push(t);
    }
  }

  /** Реакция на событие: настроение + фраза. */
  react(key: PhraseKey, mood?: Mood, say = true): void {
    this.resetSleep();
    this.setMood(mood ?? REACTIONS[key]);
    if (say && PHRASES[key]?.length) this.say(pick(PHRASES[key]));
  }

  private resetSleep(): void {
    clearTimeout(this.sleepTimer);
    if (this.svg.classList.contains("m-sleep")) this.setMood("idle");
    this.sleepTimer = window.setTimeout(() => {
      this.setMood("sleep", 0);
      if (Math.random() < 0.6) this.say(pick(PHRASES.idle), 5000);
    }, 60000);
  }

  /** Жизнь сама по себе: моргает, смотрит по сторонам, отхлёбывает кофе. */
  private loop(): void {
    const schedule = (fn: () => void, min: number, max: number) => {
      const tick = () => {
        if (!this.alive) return;
        fn();
        this.timers.push(window.setTimeout(tick, min + Math.random() * (max - min)));
      };
      this.timers.push(window.setTimeout(tick, min + Math.random() * (max - min)));
    };
    const flash = (cls: string, ms: number) => {
      this.svg.classList.add(cls);
      this.timers.push(window.setTimeout(() => this.svg.classList.remove(cls), ms));
    };
    schedule(() => flash("blink", 160), 2200, 5500);
    schedule(() => flash(Math.random() < 0.5 ? "look-l" : "look-r", 1300), 5000, 11000);
    schedule(() => {
      if (this.svg.classList.contains("m-idle")) flash("sip", 1800);
    }, 9000, 18000);
    schedule(() => {
      if (this.svg.classList.contains("m-idle")) flash("puff", 1600);
    }, 7000, 15000);
  }

  destroy(): void {
    this.alive = false;
    this.timers.forEach(clearTimeout);
    clearTimeout(this.moodTimer);
    clearTimeout(this.sleepTimer);
    clearInterval(this.typeTimer);
  }
}
