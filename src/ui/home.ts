// Главная: «Программа» — продолжить, цель дня, повторение, разделы -> темы. Ничего не блокируется.
import { SECTIONS, ALL_TOPICS, setOf, topicById } from "../content/topics";
import type { Topic } from "../content/types";
import { continueTarget, doneToday, dailyXp, progress, topicProgress, topicSetsDone, topicStatus } from "../state/progress";
import type { TopicStatus } from "../state/progress";
import { reviewCount } from "../state/review";
import { h } from "./dom";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { Mascot, timeEvent } from "./mascot";
import { navBar, topBar } from "./chrome";

export const STATUS_LABEL: Record<TopicStatus, string> = {
  new: "Не начата",
  "in-progress": "В работе",
  "closed-by-exam": "Закрыта зачётом",
  mastered: "Освоена",
};
const STATUS_ICON: Record<TopicStatus, IconName> = { new: "dot", "in-progress": "play", "closed-by-exam": "exam", mastered: "star" };
export const LEVEL_LABEL = { base: "база", mid: "mid" } as const;

export function pluralTasks(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} задание`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `${n} задания`;
  return `${n} заданий`;
}

function topicRow(t: Topic, go: (hash: string) => void, isCurrent: boolean): HTMLElement {
  const st = topicStatus(t);
  const { done, total } = topicSetsDone(t);
  const pct = Math.round(topicProgress(t) * 100);
  return h(
    "button",
    { class: `trow trow--${st}${isCurrent ? " trow--current" : ""}`, onclick: () => go(`#/topic/${t.id}`) },
    h("span", { class: "trow__n" }, String(t.n).padStart(2, "0")),
    h(
      "span",
      { class: "trow__main" },
      h("span", { class: "trow__title" }, t.title),
      h("span", { class: "trow__sum" }, t.summary),
      h(
        "span",
        { class: "trow__meta" },
        h("span", { class: `tag tag--${t.level}` }, LEVEL_LABEL[t.level]),
        h("span", { class: `status status--${st}` }, icon(STATUS_ICON[st], { size: 14 }), STATUS_LABEL[st]),
        h("span", { class: "trow__count" }, `наборов ${done}/${total}`),
      ),
      h("span", { class: "bar trow__bar", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" }, h("i", { style: { width: `${pct}%` } })),
    ),
    icon("chevron", { size: 18, class: "trow__go" }),
  );
}

export function renderHome(root: HTMLElement, go: (hash: string) => void): () => void {
  const mascot = new Mascot({ size: "sm", greet: false });
  const ev = timeEvent(progress.streak.last ? Date.parse(progress.streak.last) : undefined);
  if (ev) mascot.react(ev);
  else mascot.react("greet");
  const goal = progress.settings.dailyGoal;
  const dxp = dailyXp();
  const cont = continueTarget(ALL_TOPICS);
  const due = reviewCount();

  const scroll = h("div", { class: "scroll" });
  const page = h("div", { class: "program" });
  scroll.append(page);
  page.append(
    h("div", { class: "hero hero--home" }, mascot.el),
    h(
      "div",
      { class: "goal" },
      h("div", { class: "goal-top" }, h("span", { class: "goal__label" }, icon(doneToday() ? "flame" : "star", { size: 16 }), doneToday() ? "Сегодня уже занимался" : "Цель дня"), h("b", {}, `${Math.min(dxp, goal)} / ${goal} XP`)),
      h("div", { class: "bar" }, h("i", { style: { width: `${Math.min(100, (dxp / goal) * 100)}%` } })),
    ),
  );

  if (cont) {
    const t = topicById(cont.topicId)!;
    const set = cont.setId ? setOf(t, cont.setId) : undefined;
    const where = set ? (cont.setId === "exam" ? "Зачёт" : set.title) : "тема";
    page.append(
      h(
        "button",
        { class: "resume", onclick: () => go(set ? `#/set/${t.id}/${cont.setId}` : `#/topic/${t.id}`) },
        h("span", { class: "resume__label" }, "Продолжить"),
        h("span", { class: "resume__what" }, `${t.title} → ${where}`),
        icon("play", { size: 20, class: "resume__ico" }),
      ),
    );
  }

  if (due > 0) {
    page.append(
      h(
        "button",
        { class: "review-row", onclick: () => go("#/review") },
        icon("refresh", { size: 20 }),
        h("span", { class: "review-row__text" }, `Повторение: ${pluralTasks(due)}`),
        icon("chevron", { size: 18 }),
      ),
    );
  }

  for (const sec of SECTIONS) {
    page.append(h("h2", { class: "sec-title" }, sec.title));
    const list = h("div", { class: "tlist" });
    for (const t of sec.topics) list.append(topicRow(t, go, cont?.topicId === t.id));
    page.append(list);
  }

  root.append(h("div", { class: "screen" }, topBar(), scroll, navBar("home", go)));
  return () => mascot.destroy();
}
