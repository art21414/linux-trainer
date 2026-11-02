// Палыч — талисман тренажёра. Старый сисадмин: рисунок — src/ui/palych-art.ts, стили и анимации —
// src/styles/mascot.css, фразы — src/content/palych.ts. Настроение — класс m-<mood> на <svg>.
import { PHRASES, pick } from "../content/palych";
import type { PhraseKey } from "../content/palych";
import { palychSvg } from "./palych-art";

export type Mood =
  | "idle" | "happy" | "angry" | "shock" | "think" | "sleep" | "smug"
  | "facepalm" | "proud" | "typing" | "nervous" | "bored";

/** События-ситуации для react(): streak, combo, slow, danger, sudo, root, night, morning, comeback, examPassed, theoryOpen. */
export type PalychEvent = "streak" | "combo" | "slow" | "danger" | "sudo" | "root" | "night" | "morning" | "comeback" | "examPassed" | "theoryOpen";

/** Какое событие уместно «по часам»: night (после 23:00 и до 5:00), morning (5–10), comeback (не заходил 3+ дня). */
export function timeEvent(lastVisitMs?: number, now = new Date()): PalychEvent | null {
  if (lastVisitMs && now.getTime() - lastVisitMs > 3 * 86400_000) return "comeback";
  const h = now.getHours();
  if (h >= 23 || h < 5) return "night";
  if (h >= 5 && h < 10) return "morning";
  return null;
}

/** Как Палыч реагирует на события. */
const REACTIONS: Record<PhraseKey, Mood | Mood[]> = {
  greet: "smug",
  correct: "happy",
  wrong: ["angry", "angry", "facepalm"],
  notfound: ["think", "facepalm"],
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
  streak: "proud",
  combo: "happy",
  slow: "bored",
  root: "nervous",
  night: "bored",
  morning: "happy",
  comeback: "smug",
  examPassed: "proud",
  theoryOpen: "think",
};

export class Mascot {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private bubble: HTMLElement | null;
  private timers: number[] = [];
  private moodTimer = 0;
  private sleepTimer = 0;
  private typeTimer = 0;
  private hideTimer = 0;
  /** До этого момента тык не перебивает текущую реплику (чтобы успеть дочитать). */
  private readUntil = 0;
  private alive = true;
  private slowTimer = 0;
  private slowMs = 0;

  constructor(opts: { size?: "lg" | "md" | "sm"; bubble?: boolean; greet?: boolean } = {}) {
    this.el = document.createElement("div");
    this.el.className = `palych-wrap palych-${opts.size ?? "md"}`;
    this.el.innerHTML = `<div class="palych-box">${palychSvg()}</div>${opts.bubble === false ? "" : '<div class="bubble"><span class="bubble-text"></span></div>'}`;
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
    if (Date.now() < this.readUntil) return; // реплика ещё читается — только мимика
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

  /** ms: 0 — не прятать; не задано — по длине текста (~15 символов в секунду + 2 с, минимум 3.5 с). */
  say(text: string, ms?: number): void {
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
    const show = ms ?? Math.max(3500, 2000 + text.length * 65);
    // старый таймер скрытия больше не прячет новую реплику
    clearTimeout(this.hideTimer);
    this.readUntil = Date.now() + Math.min(show, 1200 + text.length * 50);
    if (show > 0) this.hideTimer = window.setTimeout(() => this.bubble?.classList.remove("show"), show);
  }

  /** Реакция на событие: настроение + фраза. */
  react(key: PhraseKey, mood?: Mood, say = true): void {
    this.resetSleep();
    const m = REACTIONS[key];
    this.setMood(mood ?? (Array.isArray(m) ? pick(m) : m));
    if (key === "morning") this.sip();
    if (key === "streak" || key === "examPassed") this.puff();
    if (say && PHRASES[key]?.length) this.say(pick(PHRASES[key]));
  }

  /** Глоток кофе / затяжка по требованию. */
  sip(): void { this.flash("sip", 2400); }
  puff(): void { this.flash("puff", 1800); }

  /** «Слишком долго думает»: вызови при показе задания; activity() сбрасывает таймер при любом действии. */
  armSlow(ms = 45000): void {
    this.slowMs = ms;
    this.activity();
  }
  activity(): void {
    clearTimeout(this.slowTimer);
    if (!this.slowMs || !this.alive) return;
    this.slowTimer = window.setTimeout(() => this.react("slow"), this.slowMs);
  }

  private flash(cls: string, ms: number): void {
    this.svg.classList.add(cls);
    this.timers.push(window.setTimeout(() => this.svg.classList.remove(cls), ms));
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
    const flash = (cls: string, ms: number) => this.flash(cls, ms);
    schedule(() => flash("blink", 160), 2200, 5500);
    schedule(() => flash(Math.random() < 0.5 ? "look-l" : "look-r", 1300), 5000, 11000);
    schedule(() => {
      if (this.svg.classList.contains("m-idle")) flash("sip", 2400);
    }, 9000, 18000);
    schedule(() => {
      if (this.svg.classList.contains("m-idle")) flash("puff", 1800);
    }, 7000, 15000);
  }

  destroy(): void {
    this.alive = false;
    this.timers.forEach(clearTimeout);
    clearTimeout(this.moodTimer);
    clearTimeout(this.sleepTimer);
    clearTimeout(this.slowTimer);
    clearInterval(this.typeTimer);
    clearTimeout(this.hideTimer);
  }
}
