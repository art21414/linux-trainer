// Финиш: набор, зачёт (сдан / не сдан + что почитать) или повторение.
import { PHRASES, pick } from "../content/palych";
import { parseTheory } from "../content/theory";
import { topicById } from "../content/topics";
import { completeReview, completeSet, currentStreak, progress } from "../state/progress";
import { h } from "./dom";
import { icon } from "./icons";
import type { LessonOutcome } from "./lesson";
import { Mascot } from "./mascot";
import { play } from "./sound";

/** XP: набор 10 (+5 без ошибок); зачёт 15, сдан без ошибок +15; повторение 5 (+5 без ошибок). */
export function lessonXp(o: LessonOutcome): number {
  const clean = o.mistakes === 0;
  switch (o.spec.kind) {
    case "exam":
      return 15 + (clean ? 15 : 0);
    case "review":
      return 5 + (clean ? 5 : 0);
    default:
      return 10 + (clean ? 5 : 0);
  }
}

function confetti(): HTMLElement {
  const box = h("div", { class: "confetti" });
  const cs = getComputedStyle(document.documentElement);
  const colors = ["--c-accent", "--c-ok", "--c-text", "--c-warn"].map((v) => cs.getPropertyValue(v).trim() || "#f2a03d");
  for (let i = 0; i < 50; i++) {
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

export function renderFinish(root: HTMLElement, o: LessonOutcome, go: (hash: string) => void): () => void {
  const { spec } = o;
  const xp = lessonXp(o);
  const { streakUp } = spec.kind === "review" ? completeReview(xp) : completeSet(spec.topicId!, spec.setId, o.accuracy, xp);
  const topic = spec.topicId ? topicById(spec.topicId) : undefined;
  const passed = spec.kind === "exam" && o.accuracy >= 1;
  const failedExam = spec.kind === "exam" && !passed;
  const clean = o.mistakes === 0;
  const mascot = new Mascot({ size: "lg", bubble: true });
  play("finish");
  setTimeout(() => {
    mascot.setMood(failedExam ? "think" : "happy", 4000);
    mascot.say(failedExam ? "Не сдал. Это данные, не приговор. Читай и приходи." : clean ? "Без единой ошибки?! Ладно, признаю — красава." : pick(PHRASES.complete), 0);
  }, 300);

  const mm = Math.floor(o.seconds / 60);
  const ss = String(o.seconds % 60).padStart(2, "0");
  const stat = (label: string, value: string, cls: string) => h("div", { class: `stat stat--${cls}` }, h("small", {}, label), h("b", {}, value));

  const title = passed ? "Тема закрыта" : failedExam ? `Не сдан: ошибок ${o.mistakes}` : spec.kind === "review" ? "Повторение пройдено" : clean ? "Идеально" : "Набор пройден";
  const sub = passed
    ? `Зачёт по теме «${topic?.title ?? ""}» сдан без ошибок. В повторение она больше не попадает.`
    : failedExam
      ? "Попробуй ещё раз или сначала перечитай подтемы, где ошибся."
      : spec.kind === "review"
        ? `Исправлено с первого раза: ${o.fixed} из ${spec.items.length}. Осталось в повторении: ${Object.keys(progress.mistakes).length}.`
        : "";

  const readList = h("div", { class: "finish__read" });
  if (failedExam && o.weak.length) {
    const t = topic;
    const secs = t ? parseTheory(t.theory).sections : [];
    readList.append(h("p", { class: "finish__read-title" }, "Почитай подтемы"));
    for (const w of o.weak) {
      const title = secs.find((s) => s.anchor === w.anchor)?.title ?? w.anchor;
      readList.append(h("button", { class: "row-item", onclick: () => go(`#/theory/${w.topicId}/${w.anchor}`) }, h("span", { class: "row-item__main" }, h("span", { class: "row-item__title" }, title)), icon("chevron", { size: 16, class: "row-item__go" })));
    }
  }

  const actions = h("div", { class: "footer finish__actions" });
  if (failedExam && topic) actions.append(h("button", { class: "btn", onclick: () => go(`#/set/${topic.id}/exam`) }, "Пересдать"));
  actions.append(h("button", { class: failedExam ? "btn ghost" : "btn", onclick: () => go("#/") }, "Продолжить"));
  if (topic) actions.append(h("button", { class: "btn ghost", onclick: () => go(`#/topic/${topic.id}`) }, "К теме"));

  root.append(
    ...(passed || clean ? [confetti()] : []),
    h(
      "div",
      { class: "screen" },
      h(
        "div",
        { class: `finish scroll finish--${passed ? "passed" : failedExam ? "failed" : "done"}` },
        mascot.el,
        h("h1", { class: "finish__title" }, title),
        sub ? h("p", { class: "finish__sub" }, sub) : null,
        streakUp ? h("div", { class: "chip streak" }, icon("flame", { size: 18 }), `Стрик: ${currentStreak()} ${days(currentStreak())}`) : null,
        h("div", { class: "stats" }, stat("Опыт", `+${xp} XP`, "xp"), stat("Точность", `${Math.round(o.accuracy * 100)}%`, "acc"), stat("Время", `${mm}:${ss}`, "time")),
        readList,
      ),
      actions,
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
