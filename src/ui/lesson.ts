// Прохождение урока: очередь заданий, проверка, плашка результата, повтор ошибок.
import type { ChoiceEx, Exercise, FillEx, Lesson, TerminalEx, TheoryEx, TilesEx } from "../content/types";
import { PHRASES, pick } from "../content/palych";
import { createServer, Shell } from "../engine/shell";
import type { RunResult } from "../engine/shell";
import { logUnknown, noteMistake } from "../state/progress";
import { codeHtml, confirmModal, esc, h, md, mdInline, vibrate } from "./dom";
import { Mascot } from "./mascot";
import { play } from "./sound";
import { TerminalView } from "./terminal";

export interface LessonOutcome {
  lesson: Lesson;
  accuracy: number;
  mistakes: number;
  seconds: number;
}

interface View {
  el: HTMLElement;
  /** Можно ли нажимать «Проверить». */
  ready(): boolean;
  /** Проверить ответ. answer — правильный вариант для показа при ошибке. */
  check(): { ok: boolean; answer?: string };
  destroy?(): void;
}

const KIND_LABEL: Record<string, [string, string]> = {
  choice: ["❓", "Выбери ответ"],
  predict: ["🔮", "Предскажи вывод"],
  bug: ["🐞", "Найди ошибку"],
  fill: ["✏️", "Заполни пропуск"],
  tiles: ["🧩", "Собери команду"],
  terminal: ["💻", "Задание в терминале"],
};

function kindHead(kind: string): HTMLElement {
  const [icon, label] = KIND_LABEL[kind];
  return h("div", { class: `ex-kind ${kind}` }, icon, " ", label);
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
    kindHead(ex.kind ?? "choice"),
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

function fillView(ex: FillEx, onChange: () => void): View {
  let sel = -1;
  const [before, after] = ex.template.split("___");
  const gap = h("span", { class: "gap empty" }, "____");
  const code = h("pre", { class: "codeblock fill-code" }, h("span", { class: "ps" }, "$ "), before, gap, after ?? "");
  const bank = h("div", { class: "bank" });
  const tiles: HTMLButtonElement[] = [];
  shuffle(ex.options.map((_, i) => i)).forEach((idx) => {
    const t = h("button", { class: "tile" }, ex.options[idx]);
    t.addEventListener("click", () => {
      sel = idx;
      gap.textContent = ex.options[idx];
      gap.classList.remove("empty");
      tiles.forEach((x) => x.classList.remove("ghost"));
      t.classList.add("ghost");
      play("tap");
      onChange();
    });
    tiles.push(t);
    bank.append(t);
  });
  const el = h("div", { class: "ex" }, kindHead("fill"), h("h2", { html: mdInline(ex.prompt) }), code, bank);
  return {
    el,
    ready: () => sel >= 0,
    check: () => {
      tiles.forEach((t) => (t.disabled = true));
      return { ok: sel === ex.answer, answer: ex.template.replace("___", ex.options[ex.answer]) };
    },
  };
}

function tilesView(ex: TilesEx, onChange: () => void): View {
  const line = h("div", { class: "answer-line" }, h("span", { class: "ps" }, "$"));
  const bank = h("div", { class: "bank" });
  const chosen: { word: string; src: HTMLButtonElement; el: HTMLButtonElement }[] = [];
  let locked = false;
  for (const word of shuffle([...ex.answer, ...ex.extra])) {
    const src = h("button", { class: "tile" }, word);
    src.addEventListener("click", () => {
      if (locked || src.classList.contains("ghost")) return;
      src.classList.add("ghost");
      const el = h("button", { class: "tile" }, word);
      const item = { word, src, el };
      el.addEventListener("click", () => {
        if (locked) return;
        el.remove();
        src.classList.remove("ghost");
        chosen.splice(chosen.indexOf(item), 1);
        play("tap");
        onChange();
      });
      chosen.push(item);
      line.append(el);
      play("tap");
      onChange();
    });
    bank.append(src);
  }
  const el = h("div", { class: "ex" }, kindHead("tiles"), h("h2", { html: mdInline(ex.prompt) }), line, bank);
  return {
    el,
    ready: () => chosen.length > 0,
    check: () => {
      locked = true;
      const got = chosen.map((c) => c.word).join(" ");
      const ok = [ex.answer, ...(ex.accept ?? [])].some((a) => a.join(" ") === got);
      return { ok, answer: ex.answer.join(" ") };
    },
  };
}

function theoryView(ex: TheoryEx): View {
  const el = h(
    "div",
    { class: "ex" },
    h(
      "div",
      { class: "theory-card" },
      h("span", { class: "theory-badge" }, "📖 Теория"),
      h("h2", {}, ex.title),
      h("div", { class: "md", html: md(ex.body) }),
      ex.code ? h("pre", { class: "codeblock", html: codeHtml(ex.code) }) : null,
    ),
  );
  return { el, ready: () => true, check: () => ({ ok: true }) };
}

// ---------- экран урока ----------

export function renderLesson(root: HTMLElement, lesson: Lesson, onDone: (o: LessonOutcome) => void, onExit: () => void): () => void {
  const started = Date.now();
  const queue = lesson.exercises.map((_, i) => i);
  const total = lesson.exercises.length;
  let solved = 0;
  let mistakes = 0;
  let combo = 0;
  let view: View | null = null;
  let termCleanup: (() => void) | null = null;
  const failed = new Set<number>();

  const bar = h("i", { style: { width: "0%" } });
  const comboEl = h("div", { class: "combo" });
  const close = h("button", { class: "x", "aria-label": "Выйти" }, "✕");
  close.addEventListener("click", async () => {
    if (solved === 0 || (await confirmModal("Выйти из урока?", "Прогресс этого урока пропадёт. Палыч расстроится.", "Выйти", "Остаться"))) onExit();
  });
  const top = h("div", { class: "lesson-top" }, close, h("div", { class: "progress" }, bar), comboEl);
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
    comboEl.textContent = combo >= 3 ? `🔥${combo}` : "";
  };

  const showSheet = (ok: boolean, title: string, html: string) => {
    sheet.className = `sheet show ${ok ? "ok" : "bad"}`;
    sheetIco.textContent = ok ? "✓" : "✕";
    sheetTitle.textContent = title;
    sheetBody.innerHTML = html;
    sheetBtn.className = `btn ${ok ? "" : "red"}`;
    sheetMascot.react(ok ? "correct" : "wrong", undefined, false);
    setTimeout(() => sheetBtn.focus({ preventScroll: true }), 50);
  };

  const finish = () => {
    const graded = lesson.exercises.filter((e) => e.type !== "theory").length;
    const accuracy = graded ? Math.max(0, (graded - failed.size) / graded) : 1;
    onDone({ lesson, accuracy, mistakes, seconds: Math.round((Date.now() - started) / 1000) });
  };

  const next = () => {
    view?.destroy?.();
    termCleanup?.();
    termCleanup = null;
    sheet.className = "sheet";
    if (!queue.length) return finish();
    const idx = queue.shift()!;
    const ex = lesson.exercises[idx];
    body.innerHTML = "";
    body.scrollTop = 0;
    if (ex.type === "terminal") return showTerminal(ex, idx);
    body.className = "scroll";
    const onChange = () => (checkBtn.disabled = !view!.ready());
    view = makeView(ex, onChange);
    body.append(view.el);
    footerRow.replaceChildren(checkBtn);
    checkBtn.textContent = ex.type === "theory" ? "Дальше" : "Проверить";
    checkBtn.className = "btn";
    checkBtn.disabled = !view.ready();
    checkBtn.onclick = () => {
      if (!view || !view.ready()) return;
      if (ex.type === "theory") {
        solved++;
        updateBar();
        return next();
      }
      const r = view.check();
      checkBtn.disabled = true;
      if (r.ok) {
        solved++;
        combo++;
        play("right");
        showSheet(true, pick(["Отлично!", "Верно!", "Так держать!", "Точно!"]), `«${esc(pick(PHRASES.correct))}» — Палыч`);
      } else {
        mistakes++;
        combo = 0;
        failed.add(idx);
        noteMistake(`${lesson.id}#${idx}`);
        queue.push(idx); // повторим в конце урока
        play("wrong");
        vibrate([40, 40, 60]);
        const explain = "explain" in ex && ex.explain ? `<span class="explain">${esc(ex.explain)}</span>` : "";
        showSheet(false, "Неправильно", `Правильный ответ:<span class="answer">${esc(r.answer ?? "")}</span>${explain}`);
      }
      updateBar();
    };
  };

  const makeView = (ex: Exercise, onChange: () => void): View => {
    switch (ex.type) {
      case "choice":
        return choiceView(ex, onChange);
      case "fill":
        return fillView(ex, onChange);
      case "tiles":
        return tilesView(ex, onChange);
      default:
        return theoryView(ex as TheoryEx);
    }
  };

  const showTerminal = async (ex: TerminalEx, idx: number) => {
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
    const hintBtn = h("button", { class: "btn ghost small" }, "💡 Подсказка");
    hintBtn.onclick = () => {
      hintLevel++;
      hintBox.style.display = "";
      if (hintLevel === 1) {
        hintBox.innerHTML = `💡 ${esc(ex.hint)}`;
        hintBtn.textContent = "👀 Показать решение";
        mascot.react("hint");
      } else {
        hintBox.innerHTML = `Решение (одно из возможных):<br><code>${esc(ex.solution).replace(/\n/g, "<br>")}</code>`;
        hintBtn.style.display = "none";
        mascot.say("Перепиши руками. Пальцы тоже должны запомнить.");
        if (!failed.has(idx)) {
          failed.add(idx);
          mistakes++;
          noteMistake(`${lesson.id}#${idx}`);
        }
      }
    };
    footerRow.replaceChildren(hintBtn);

    term.onResult = async (r: RunResult) => {
      if (done) return;
      reactToCommand(mascot, r);
      const res = await ex.check({ world: w, shell });
      if (res === true) {
        done = true;
        solved++;
        if (!failed.has(idx)) combo++;
        updateBar();
        play("right");
        (document.activeElement as HTMLElement | null)?.blur();
        mascot.react("correct");
        showSheet(true, "Сервер принял!", `Проверка состояния пройдена. «${esc(pick(PHRASES.correct))}»`);
      } else if (typeof res === "string") {
        near.textContent = "🟡 " + res;
        mascot.react("near", "think", false);
        mascot.say(res, 5000);
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
