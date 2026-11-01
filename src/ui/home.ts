import { SECTIONS, ALL_TOPICS } from "../content/topics";
import { continueTarget, doneToday, dailyXp, progress, topicProgress, topicStatus } from "../state/progress";
import { h } from "./dom";
import { Mascot } from "./mascot";
import { navBar, topBar } from "./chrome";

// ВРЕМЕННЫЙ простой экран: список тем -> наборы. Полностью переделывается.
const STATUS: Record<string, string> = { new: "", "in-progress": "в процессе", "closed-by-exam": "зачёт сдан", mastered: "освоена" };

export function renderHome(root: HTMLElement, go: (hash: string) => void): () => void {
  const mascot = new Mascot({ size: "lg", greet: true });
  const goal = progress.settings.dailyGoal;
  const dxp = dailyXp();
  const cont = continueTarget(ALL_TOPICS);

  const scroll = h("div", { class: "scroll" });
  scroll.append(
    h("div", { class: "hero" }, mascot.el),
    h(
      "div",
      { class: "goal" },
      h("div", { class: "goal-top" }, h("span", {}, doneToday() ? "🔥 Сегодня уже занимался" : "🎯 Цель дня"), h("b", {}, `${Math.min(dxp, goal)} / ${goal} XP`)),
      h("div", { class: "bar" }, h("i", { style: { width: `${Math.min(100, (dxp / goal) * 100)}%` } })),
    ),
  );

  if (cont) {
    const t = ALL_TOPICS.find((x) => x.id === cont.topicId)!;
    scroll.append(h("button", { class: "btn", onclick: () => go(`#/set/${t.id}/${cont.setId ?? "exam"}`) }, `Продолжить: ${t.title}`));
  }
  for (const sec of SECTIONS) {
    scroll.append(h("h2", {}, sec.title));
    for (const t of sec.topics) {
      const pct = Math.round(topicProgress(t) * 100);
      const row = h("div", { class: "topic-row" }, h("b", {}, `${t.n}. ${t.title}`), h("small", {}, ` ${t.summary} · ${pct}% ${STATUS[topicStatus(t)]}`));
      const btns = h("div", { class: "row" });
      for (const s of [...t.sets, t.exam]) {
        const done = !!progress.sets[`${t.id}/${s.id}`];
        btns.append(h("button", { class: "btn ghost small", onclick: () => go(`#/set/${t.id}/${s.id}`) }, `${done ? "✓ " : ""}${s.id === "exam" ? "Зачёт" : s.title}`));
      }
      scroll.append(row, btns);
    }
  }

  root.append(h("div", { class: "screen" }, topBar(), scroll, navBar("home", go)));
  return () => mascot.destroy();
}
