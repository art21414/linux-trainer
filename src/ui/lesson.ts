// Практика: очередь заданий (набор, зачёт или повторение), проверка, разбор, повтор ошибок, лист с теорией.
import type { ChoiceEx, Exercise, TerminalEx } from "../content/types";
import { topicById } from "../content/topics";
import { parseTheory, renderMarkdown } from "../content/theory";
import type { ReviewItem } from "../state/review";
import { openSheet } from "./sheet";
import type { SheetHandle } from "./sheet";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { PHRASES, pick } from "../content/palych";
import { createServer, Shell } from "../engine/shell";
import type { RunResult } from "../engine/shell";
import { clearMistake, logUnknown, markRead, noteMistake } from "../state/progress";
import { codeHtml, confirmModal, esc, h, mdInline, toast, vibrate } from "./dom";
import { Mascot } from "./mascot";
import { play } from "./sound";
import { TerminalView } from "./terminal";

export type LessonKind = "set" | "exam" | "review";

/** Что проходим: набор, зачёт темы или повторение ошибок (задания могут быть из разных тем). */
export interface LessonSpec {
  kind: LessonKind;
  /** Тема набора/зачёта; для повторения null. */
  topicId: string | null;
  /** Id набора для прогресса ("exam" для зачёта, "review" для повторения). */
  setId: string;
  title: string;
  items: ReviewItem[];
}

export interface LessonOutcome {
  spec: LessonSpec;
  accuracy: number;
  mistakes: number;
  seconds: number;
  /** Подтемы заданий, где были ошибки (без повторов). */
  weak: { topicId: string; anchor: string }[];
  /** Повторение: сколько ошибок исправлено с первого раза. */
  fixed: number;
}

interface View {
  el: HTMLElement;
  /** Можно ли нажимать «Проверить». */
  ready(): boolean;
  /** Проверить ответ. answer — правильный вариант для показа при ошибке. */
  check(): { ok: boolean; answer?: string };
  destroy?(): void;
}

const KIND_LABEL: Record<string, [IconName, string]> = {
  choice: ["dot", "Выбери ответ"],
  predict: ["play", "Предскажи вывод"],
  bug: ["warning", "Найди ошибку"],
  terminal: ["terminal", "Задание в терминале"],
};

function kindHead(kind: string): HTMLElement {
  const [ico, label] = KIND_LABEL[kind];
  return h("div", { class: `ex-kind ex-kind--${kind}` }, icon(ico, { size: 16 }), " ", label);
}

const isMono = (s: string) => !/[а-яё]/i.test(s);

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- представления заданий ----------

function choiceView(ex: ChoiceEx, onChange: () => void): View {
  let sel = -1;
  const order = shuffle(ex.options.map((_, i) => i));
  const btns: HTMLButtonElement[] = [];
  const opts = h("div", { class: "options" });
  order.forEach((idx, pos) => {
    const text = ex.options[idx];
    const b = h("button", { class: `opt ${isMono(text) ? "mono" : ""}` }, h("span", { class: "k" }, String(pos + 1)), h("span", {}, text));
    b.addEventListener("click", () => {
      sel = idx;
      btns.forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      play("tap");
      onChange();
    });
    b.dataset.idx = String(idx);
    btns.push(b);
    opts.append(b);
  });
  const el = h(
    "div",
    { class: "ex" },
    kindHead(ex.kind),
    h("h2", { html: mdInline(ex.prompt) }),
    ex.code ? h("pre", { class: "codeblock", html: codeHtml(ex.code) }) : null,
    opts,
  );
  return {
    el,
    ready: () => sel >= 0,
    check: () => {
      const ok = sel === ex.answer;
      for (const b of btns) {
        b.disabled = true;
        if (Number(b.dataset.idx) === ex.answer) b.classList.add("right");
        else if (Number(b.dataset.idx) === sel) b.classList.add("wrong");
      }
      return { ok, answer: ex.options[ex.answer] };
    },
  };
}

// ---------- экран урока ----------

export function renderLesson(root: HTMLElement, spec: LessonSpec, onDone: (o: LessonOutcome) => void, onExit: () => void): () => void {
  const started = Date.now();
  const total = spec.items.length;
  const queue = spec.items.map((_, i) => i);
  let solved = 0;
  let mistakes = 0;
  let fixed = 0;
  let combo = 0;
  let cur: ReviewItem | null = null;
  let view: View | null = null;
  let termCleanup: (() => void) | null = null;
  let theorySheet: SheetHandle | null = null;
  const failed = new Set<number>();

  const bar = h("i", { style: { width: "0%" } });
  const comboEl = h("div", { class: "combo" });
  const close = h("button", { class: "x", "aria-label": "Выйти" }, icon("close", { size: 22 }));
  close.addEventListener("click", async () => {
    if (solved === 0 || (await confirmModal("Выйти?", "Прогресс этого прохождения пропадёт. Палыч расстроится.", "Выйти", "Остаться"))) onExit();
  });
  const theoryBtn = h("button", { class: "theory-btn", hidden: "" }, icon("book", { size: 18 }), h("span", {}, "Теория"));
  const top = h("div", { class: "lesson-top" }, close, h("div", { class: "progress" }, bar), comboEl, theoryBtn);
  const body = h("div", { class: "scroll" });
  const checkBtn = h("button", { class: "btn" }, "Проверить");
  const footerRow = h("div", { class: "row" }, checkBtn);
  const sheetMascot = new Mascot({ size: "sm", bubble: false });
  const sheetTitle = h("h3", {});
  const sheetIco = h("div", { class: "ico" });
  const sheetBody = h("div", { class: "sheet-body" });
  const sheetBtn = h("button", { class: "btn" }, "Продолжить");
  const sheet = h(
    "div",
    { class: "sheet" },
    h("div", { class: "sheet-head" }, sheetIco, sheetTitle, h("div", { style: { marginLeft: "auto" } }, sheetMascot.el)),
    sheetBody,
    sheetBtn,
  );
  const footer = h("div", { class: "footer" }, footerRow, sheet);
  const screen = h("div", { class: "screen" }, top, body, footer);
  root.append(screen);

  const updateBar = () => {
    bar.style.width = `${Math.max(4, (solved / total) * 100)}%`;
    comboEl.replaceChildren(...(combo >= 3 ? [icon("flame", { size: 16 }), String(combo)] : []));
  };

  const showSheet = (ok: boolean, title: string, html: string) => {
    sheet.className = `sheet show ${ok ? "ok" : "bad"}`;
    sheetIco.replaceChildren(icon(ok ? "check" : "cross", { size: 20 }));
    sheetTitle.textContent = title;
    sheetBody.innerHTML = html;
    sheetBtn.className = `btn ${ok ? "" : "red"}`;
    sheetMascot.react(ok ? "correct" : "wrong", undefined, false);
    setTimeout(() => sheetBtn.focus({ preventScroll: true }), 50);
  };

  const explainHtml = (ex: Exercise) => (ex.explain ? `<span class="explain">${esc(ex.explain)}</span>` : "");

  /** Верный ответ: в повторении с первой попытки снимаем ошибку. */
  const onSolved = (item: ReviewItem, idx: number) => {
    solved++;
    if (!failed.has(idx)) {
      combo++;
      if (spec.kind === "review") {
        clearMistake(item.topicId, item.ex.id);
        fixed++;
      }
    }
  };
  const onFailed = (item: ReviewItem, idx: number) => {
    mistakes++;
    combo = 0;
    failed.add(idx);
    noteMistake(item.topicId, item.ex.id);
  };

  const finish = () => {
    const accuracy = total ? Math.max(0, (total - failed.size) / total) : 1;
    const weak: LessonOutcome["weak"] = [];
    for (const i of failed) {
      const { topicId, ex } = spec.items[i];
      if (ex.theory && !weak.some((w) => w.topicId === topicId && w.anchor === ex.theory)) weak.push({ topicId, anchor: ex.theory });
    }
    onDone({ spec, accuracy, mistakes, seconds: Math.round((Date.now() - started) / 1000), weak, fixed });
  };

  // ----- теория поверх задания -----
  const section = (item: ReviewItem) => {
    const t = topicById(item.topicId);
    return t && item.ex.theory ? parseTheory(t.theory).sections.find((s) => s.anchor === item.ex.theory) : undefined;
  };
  theoryBtn.onclick = () => {
    if (!cur || theorySheet) return;
    const sec = section(cur);
    if (!sec) return toast("Для этого задания нет подтемы");
    (document.activeElement as HTMLElement | null)?.blur();
    markRead(cur.topicId, sec.anchor);
    theorySheet = openSheet(root, sec.title, renderMarkdown(sec.body), () => (theorySheet = null));
  };

  const next = () => {
    view?.destroy?.();
    termCleanup?.();
    termCleanup = null;
    sheet.className = "sheet";
    if (!queue.length) return finish();
    const idx = queue.shift()!;
    const item = spec.items[idx];
    const ex = item.ex;
    cur = item;
    theoryBtn.hidden = !section(item);
    body.innerHTML = "";
    body.scrollTop = 0;
    if (ex.type === "terminal") return showTerminal(item, ex, idx);
    body.className = "scroll";
    const onChange = () => (checkBtn.disabled = !view!.ready());
    view = choiceView(ex, onChange);
    body.append(view.el);
    footerRow.replaceChildren(checkBtn);
    checkBtn.textContent = "Проверить";
    checkBtn.className = "btn";
    checkBtn.disabled = !view.ready();
    checkBtn.onclick = () => {
      if (!view || !view.ready()) return;
      const r = view.check();
      checkBtn.disabled = true;
      if (r.ok) {
        onSolved(item, idx);
        play("right");
        showSheet(true, pick(["Отлично!", "Верно!", "Так держать!", "Точно!"]), `${explainHtml(ex) || `«${esc(pick(PHRASES.correct))}» — Палыч`}`);
      } else {
        onFailed(item, idx);
        queue.push(idx); // повторим в конце
        play("wrong");
        vibrate([40, 40, 60]);
        showSheet(false, "Неправильно", `Правильный ответ:<span class="answer">${esc(r.answer ?? "")}</span>${explainHtml(ex)}`);
      }
      updateBar();
    };
  };

  const showTerminal = async (item: ReviewItem, ex: TerminalEx, idx: number) => {
    body.className = "ex term-ex";
    const w = await createServer();
    if (ex.setup) await ex.setup(w);
    const shell = new Shell(w, {
      user: ex.user ?? "root",
      cwd: ex.cwd,
      onNotFound: (c) => logUnknown(c, shell.history.at(-1) ?? c, "notfound"),
      onUnsupported: (c) => logUnknown(c, shell.history.at(-1) ?? c, "unsupported"),
    });
    const term = new TerminalView(shell);
    const mascot = new Mascot({ size: "sm" });
    const near = h("span", { class: "near" });
    const hintBox = h("div", { class: "hint-box", style: { display: "none" } });
    const card = h("div", { class: "task-card" }, h("span", { html: mdInline(ex.prompt) }), near);
    body.append(kindHead("terminal"), card, mascot.el, hintBox, term.el);
    term.mount();
    mascot.say(pick(["Давай, я смотрю.", "Сервер твой. Не урони.", "Пиши команду, не стесняйся."]), 3500);

    let hintLevel = 0;
    let done = false;
    const hintBtn = h("button", { class: "btn ghost small" }, icon("hint", { size: 18 }), " Подсказка");
    hintBtn.onclick = () => {
      hintLevel++;
      hintBox.style.display = "";
      if (hintLevel === 1) {
        hintBox.innerHTML = esc(ex.hint);
        hintBtn.replaceChildren(icon("known", { size: 18 }), " Показать решение");
        mascot.react("hint");
      } else {
        hintBox.innerHTML = `Решение (одно из возможных):<br><code>${esc(ex.solution).replace(/\n/g, "<br>")}</code>`;
        hintBtn.style.display = "none";
        mascot.say("Перепиши руками. Пальцы тоже должны запомнить.");
        if (!failed.has(idx)) onFailed(item, idx);
      }
    };
    footerRow.replaceChildren(hintBtn);

    term.onResult = async (r: RunResult) => {
      if (done) return;
      reactToCommand(mascot, r);
      const res = await ex.check({ world: w, shell });
      if (res === true) {
        done = true;
        onSolved(item, idx);
        updateBar();
        play("right");
        (document.activeElement as HTMLElement | null)?.blur();
        mascot.react("correct");
        showSheet(true, "Сервер принял!", `Проверка состояния пройдена. «${esc(pick(PHRASES.correct))}»${explainHtml(ex)}`);
      } else if (typeof res === "string") {
        near.textContent = "Почти: " + res;
        mascot.react("near", "think", false);
        mascot.say(res);
      } else {
        near.textContent = "";
      }
    };
    termCleanup = () => {
      term.destroy();
      mascot.destroy();
    };
    setTimeout(() => term.focus(), 350);
  };

  sheetBtn.onclick = () => next();
  updateBar();
  next();

  return () => {
    theorySheet?.destroy();
    view?.destroy?.();
    termCleanup?.();
    sheetMascot.destroy();
  };
}

/** Реакция Палыча на результат команды. */
export function reactToCommand(m: Mascot, r: RunResult): void {
  switch (r.kind) {
    case "danger":
      vibrate([80, 40, 80, 40, 120]);
      return m.react("danger");
    case "notfound":
      return m.react("notfound");
    case "unsupported":
      return m.react("unsupported");
    case "sudo":
      return m.react("sudo");
    case "su":
      return m.react("su");
    case "clear":
      return m.react("clear");
    case "error":
      if (/Permission denied|Operation not permitted|not in the sudoers/.test(r.out)) return m.react("permission");
      return m.react("error", "angry", Math.random() < 0.5);
    case "ok":
      if (Math.random() < 0.15) m.react("ok", "smug", false);
      else m.react("ok", "idle", false);
      return;
    default:
      return;
  }
}
