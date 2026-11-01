// Читалка теории: оглавление, сворачиваемые подтемы, «знаю», авто-отметка «прочитано».
import { parseTheory, renderMarkdown } from "../content/theory";
import { topicById } from "../content/topics";
import { isKnown, isRead, markKnown, markRead, setTopic } from "../state/progress";
import { h } from "./dom";
import { icon } from "./icons";

export function renderReader(root: HTMLElement, topicId: string, anchor: string | undefined, go: (hash: string) => void, back: () => void): () => void {
  const t = topicById(topicId);
  if (!t) {
    root.append(h("div", { class: "screen" }, h("div", { class: "scroll" }, h("p", { class: "empty" }, "Тема не найдена."), h("button", { class: "btn", onclick: back }, "Назад"))));
    return () => {};
  }
  setTopic(t.id);
  const parsed = parseTheory(t.theory);
  const secs = parsed.sections;
  const selected = secs.find((s) => s.anchor === anchor) ?? secs[0];

  const scroll = h("div", { class: "scroll" });
  const observers: IntersectionObserver[] = [];

  interface Sec {
    anchor: string;
    el: HTMLElement;
    head: HTMLButtonElement;
    marks: HTMLElement;
    chipMarks: HTMLElement;
    body: HTMLElement;
    knownBtn: HTMLButtonElement;
    observing: boolean;
  }
  const items: Sec[] = [];

  const renderMarks = (s: Sec) => {
    const known = isKnown(t.id, s.anchor);
    const read = isRead(t.id, s.anchor);
    const content = () => (known ? [icon("known", { size: 14 }), "знаю"] : read ? [icon("check", { size: 14 }), "прочитано"] : []);
    for (const box of [s.marks, s.chipMarks]) {
      box.className = box.className.replace(/ ?mark--\w+/g, "") + (known ? " mark--known" : read ? " mark--read" : "");
      box.replaceChildren(...(box === s.chipMarks ? (known ? [icon("known", { size: 12 })] : read ? [icon("check", { size: 12 })] : []) : content()));
    }
    s.knownBtn.classList.toggle("btn--on", known);
    s.knownBtn.replaceChildren(icon("known", { size: 18 }), known ? " Знаю (отменить)" : " Знаю");
  };

  const setOpen = (s: Sec, open: boolean) => {
    s.el.classList.toggle("tsec--open", open);
    s.head.setAttribute("aria-expanded", String(open));
    s.body.hidden = !open;
    if (open && !s.observing) {
      s.observing = true;
      // конец подтемы показался на экране -> прочитано
      const sentinel = s.body.querySelector(".tsec__end")!;
      const io = new IntersectionObserver(
        (es) => {
          if (es.some((e) => e.isIntersecting) && !isRead(t.id, s.anchor)) {
            markRead(t.id, s.anchor);
            renderMarks(s);
          }
        },
        { root: scroll, threshold: 0.1 },
      );
      io.observe(sentinel);
      observers.push(io);
    }
  };

  const chips = h("nav", { class: "toc", "aria-label": "Оглавление" });
  for (const sec of secs) {
    const marks = h("span", { class: "mark" });
    const chipMarks = h("span", { class: "chip-mark" });
    const body = h("div", { class: "tsec__body", hidden: "" }, renderMarkdown(sec.body), h("div", { class: "tsec__end" }));
    const head = h(
      "button",
      { class: "tsec__head", "aria-expanded": "false" },
      h("span", { class: "tsec__title" }, sec.title),
      marks,
      icon("chevron", { size: 18, class: "tsec__chev" }),
    );
    const knownBtn = h("button", { class: "btn ghost small tsec__known" });
    const el = h("section", { class: "tsec", id: `sec-${sec.anchor}` }, head, body);
    const s: Sec = { anchor: sec.anchor, el, head, marks, chipMarks, body, knownBtn, observing: false };
    body.insertBefore(knownBtn, body.querySelector(".tsec__end"));
    knownBtn.onclick = () => {
      markKnown(t.id, sec.anchor, !isKnown(t.id, sec.anchor));
      renderMarks(s);
    };
    head.onclick = () => setOpen(s, body.hidden);
    const chip = h("button", { class: "toc__chip" }, sec.title, chipMarks);
    chip.onclick = () => {
      setOpen(s, true);
      el.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    chips.append(chip);
    items.push(s);
    renderMarks(s);
  }

  const allBtn = h("button", { class: "btn ghost small" });
  const syncAll = () => {
    const allOpen = items.every((s) => !s.body.hidden);
    allBtn.textContent = allOpen ? "Свернуть всё" : "Развернуть всё";
  };
  allBtn.onclick = () => {
    const open = items.some((s) => s.body.hidden);
    items.forEach((s) => setOpen(s, open));
    syncAll();
  };
  for (const s of items) s.head.addEventListener("click", syncAll);

  const head = h(
    "header",
    { class: "thead" },
    h("button", { class: "iconbtn", "aria-label": "Назад", onclick: back }, icon("back", { size: 22 })),
    h("div", { class: "thead__text" }, h("div", { class: "thead__kicker" }, "Теория"), h("h1", { class: "thead__title" }, t.title)),
  );
  const intro = parsed.intro ? renderMarkdown(parsed.intro) : null;
  scroll.append(h("div", { class: "reader" }, chips, intro ? h("div", { class: "reader__intro" }, intro) : null, h("div", { class: "reader__tools" }, allBtn), ...items.map((s) => s.el), h("button", { class: "btn reader__practice", onclick: () => go(`#/topic/${t.id}`) }, "К практике")));
  root.append(h("div", { class: "screen" }, head, scroll));

  items.forEach((s, i) => setOpen(s, secs[i] === selected));
  syncAll();
  requestAnimationFrame(() => {
    const target = items.find((s) => s.anchor === selected?.anchor);
    if (target && anchor) target.el.scrollIntoView({ block: "start" });
  });
  return () => observers.forEach((o) => o.disconnect());
}
