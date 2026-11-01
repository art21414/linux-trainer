// Экран темы: теория по подтемам, наборы практики, зачёт.
import { parseTheory } from "../content/theory";
import { topicById } from "../content/topics";
import { isKnown, isRead, progress, topicProgress, topicStatus } from "../state/progress";
import { h } from "./dom";
import { icon } from "./icons";
import { LEVEL_LABEL, STATUS_LABEL, pluralTasks } from "./home";

export function renderTopic(root: HTMLElement, topicId: string, go: (hash: string) => void, back: () => void): () => void {
  const t = topicById(topicId);
  if (!t) {
    root.append(h("div", { class: "screen" }, h("div", { class: "scroll" }, h("p", { class: "empty" }, "Тема не найдена."), h("button", { class: "btn", onclick: back }, "Назад"))));
    return () => {};
  }
  const st = topicStatus(t);
  const pct = Math.round(topicProgress(t) * 100);
  const secs = parseTheory(t.theory).sections;
  const examDate = progress.exams[t.id];

  const head = h(
    "header",
    { class: "thead" },
    h("button", { class: "iconbtn", "aria-label": "Назад", onclick: back }, icon("back", { size: 22 })),
    h(
      "div",
      { class: "thead__text" },
      h("div", { class: "thead__kicker" }, `Тема ${String(t.n).padStart(2, "0")}`, h("span", { class: `tag tag--${t.level}` }, LEVEL_LABEL[t.level])),
      h("h1", { class: "thead__title" }, t.title),
    ),
  );

  const intro = h(
    "section",
    { class: "tintro" },
    h("p", { class: "tintro__sum" }, t.summary),
    h("div", { class: "tintro__row" }, h("span", { class: `status status--${st}` }, STATUS_LABEL[st]), h("b", {}, `${pct}%`)),
    h("div", { class: "bar" }, h("i", { style: { width: `${pct}%` } })),
  );

  const theory = h("section", { class: "tblock" }, h("h2", { class: "tblock__title" }, icon("book", { size: 18 }), "Теория"));
  const tlist = h("div", { class: "rows" });
  for (const s of secs) {
    const known = isKnown(t.id, s.anchor);
    const read = isRead(t.id, s.anchor);
    tlist.append(
      h(
        "button",
        { class: "row-item", onclick: () => go(`#/theory/${t.id}/${s.anchor}`) },
        h("span", { class: "row-item__main" }, h("span", { class: "row-item__title" }, s.title)),
        known
          ? h("span", { class: "mark mark--known" }, icon("known", { size: 14 }), "знаю")
          : read
            ? h("span", { class: "mark mark--read" }, icon("check", { size: 14 }), "прочитано")
            : null,
        icon("chevron", { size: 16, class: "row-item__go" }),
      ),
    );
  }
  theory.append(tlist);
  if (secs.length > 1) theory.append(h("button", { class: "btn ghost small", onclick: () => go(`#/theory/${t.id}`) }, "Читать всё подряд"));

  const practice = h("section", { class: "tblock" }, h("h2", { class: "tblock__title" }, icon("terminal", { size: 18 }), "Практика"));
  const plist = h("div", { class: "rows" });
  for (const s of t.sets) {
    const r = progress.sets[`${t.id}/${s.id}`];
    plist.append(
      h(
        "button",
        { class: `row-item${r ? " row-item--done" : ""}`, onclick: () => go(`#/set/${t.id}/${s.id}`) },
        h(
          "span",
          { class: "row-item__main" },
          h("span", { class: "row-item__title" }, s.title),
          h("span", { class: "row-item__sub" }, `${pluralTasks(s.exercises.length)} · ${r ? `лучшая точность ${Math.round(r.best * 100)}%` : "не пройден"}`),
        ),
        r ? h("span", { class: "mark mark--read" }, icon("check", { size: 14 }), "пройден") : null,
        icon("chevron", { size: 16, class: "row-item__go" }),
      ),
    );
  }
  practice.append(plist);

  const exam = h(
    "section",
    { class: `tblock exam${examDate ? " exam--passed" : ""}` },
    h("h2", { class: "tblock__title" }, icon("exam", { size: 18 }), "Зачёт"),
    h("p", { class: "exam__text" }, examDate ? `Тема закрыта зачётом (${examDate}). Наборы выше остаются доступными — можно потренироваться ещё.` : `${pluralTasks(t.exam.exercises.length)} по всей теме. Сдай без ошибок — тема закроется и не будет всплывать в повторении.`),
    h("button", { class: examDate ? "btn ghost" : "btn", onclick: () => go(`#/set/${t.id}/exam`) }, examDate ? "Пересдать зачёт" : "Сдать зачёт"),
  );

  root.append(h("div", { class: "screen" }, head, h("div", { class: "scroll" }, h("div", { class: "topic" }, intro, theory, practice, exam))));
  return () => {};
}
