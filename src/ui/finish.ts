import { PHRASES, pick } from "../content/palych";
import { completeLesson, currentStreak } from "../state/progress";
import { h } from "./dom";
import type { LessonOutcome } from "./lesson";
import { Mascot } from "./mascot";
import { play } from "./sound";

/** XP за урок: 10 базовых + 5 за прохождение без ошибок. */
export function lessonXp(o: LessonOutcome): number {
  return 10 + (o.mistakes === 0 ? 5 : 0);
}

function confetti(): HTMLElement {
  const box = h("div", { class: "confetti" });
  const colors = ["#58cc02", "#1cb0f6", "#ffc800", "#ff4b4b", "#ce82ff", "#ff9600"];
  for (let i = 0; i < 70; i++) {
    box.append(
      h("i", {
        style: {
          left: `${Math.random() * 100}%`,
          background: colors[i % colors.length],
          animationDuration: `${1.8 + Math.random() * 1.8}s`,
          animationDelay: `${Math.random() * 0.6}s`,
          transform: `rotate(${Math.random() * 360}deg)`,
        },
      }),
    );
  }
  setTimeout(() => box.remove(), 4500);
  return box;
}

export function renderFinish(root: HTMLElement, o: LessonOutcome, onContinue: () => void): () => void {
  const xp = lessonXp(o);
  const { streakUp } = completeLesson(o.lesson.id, o.accuracy, xp);
  const mascot = new Mascot({ size: "lg", bubble: true });
  play("finish");
  setTimeout(() => {
    mascot.setMood("happy", 4000);
    mascot.say(o.mistakes === 0 ? "Без единой ошибки?! Ладно, признаю — красава." : pick(PHRASES.complete), 0);
  }, 300);
  const mm = Math.floor(o.seconds / 60);
  const ss = String(o.seconds % 60).padStart(2, "0");
  const stat = (label: string, value: string, color: string) => {
    const s = h("div", { class: "stat" }, h("small", {}, label), h("b", {}, value));
    s.style.setProperty("--c", color);
    return s;
  };
  root.append(
    confetti(),
    h(
      "div",
      { class: "screen" },
      h(
        "div",
        { class: "finish" },
        mascot.el,
        h("h1", {}, o.mistakes === 0 ? "Идеально!" : "Урок пройден!"),
        streakUp ? h("div", { class: "chip streak", style: { fontSize: "20px" } }, `🔥 Стрик: ${currentStreak()} ${days(currentStreak())}`) : null,
        h(
          "div",
          { class: "stats" },
          stat("Опыт", `+${xp} XP`, "#ffc800"),
          stat("Точность", `${Math.round(o.accuracy * 100)}%`, "#58cc02"),
          stat("Время", `${mm}:${ss}`, "#1cb0f6"),
        ),
      ),
      h("div", { class: "footer" }, h("button", { class: "btn", onclick: onContinue }, "Продолжить")),
    ),
  );
  return () => mascot.destroy();
}

function days(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "день";
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "дня";
  return "дней";
}
