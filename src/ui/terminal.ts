// Терминал для телефона: вывод с ANSI-цветами, строка ввода, панель символов, история, Tab.
import type { RunResult, Shell } from "../engine/shell";
import { esc, h } from "./dom";

/** ANSI SGR → HTML со span-классами. */
export function ansiToHtml(s: string): string {
  let out = "";
  let classes: string[] = [];
  const parts = s.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const text = esc(parts[i].replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
      if (!text) continue;
      out += classes.length ? `<span class="${classes.join(" ")}">${text}</span>` : text;
      continue;
    }
    for (const code of (parts[i] || "0").split(";").map(Number)) {
      if (code === 0) classes = [];
      else if (code === 1) classes.push("a-b");
      else if ((code >= 30 && code <= 37) || (code >= 40 && code <= 47)) classes.push(`a-${code}`);
      else if (code >= 90 && code <= 97) classes.push(`a-${code - 60}`, "a-b");
    }
  }
  return out;
}

const KEYS = ["Tab", "↑", "↓", "|", "-", "/", "~", ">", "*", ".", "_", "$", "&", ";", ":", "=", "'", '"', "^C"];

export class TerminalView {
  readonly el: HTMLElement;
  private out: HTMLElement;
  private input: HTMLInputElement;
  private promptEl: HTMLElement;
  private title: HTMLElement;
  private histIdx = 0;
  private draft = "";
  private busy = false;
  private ro?: ResizeObserver;
  onResult?: (r: RunResult, line: string) => void;

  constructor(
    readonly shell: Shell,
    opts: { motd?: string } = {},
  ) {
    this.out = h("div", { class: "term-out" });
    this.promptEl = h("span", { class: "pr" });
    this.input = h("input", {
      type: "text",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      spellcheck: "false",
      enterkeyhint: "send",
      "aria-label": "Команда",
    });
    const form = h("form", { class: "term-input", onsubmit: (e: Event) => (e.preventDefault(), void this.submit()) }, this.promptEl, this.input);
    this.title = h("span", {});
    const head = h(
      "div",
      { class: "term-head" },
      h("i", { style: { background: "#ff5f57" } }),
      h("i", { style: { background: "#febc2e" } }),
      h("i", { style: { background: "#28c840" } }),
      this.title,
    );
    const keys = h("div", { class: "keys" });
    for (const k of KEYS) {
      const b = h("button", { type: "button", class: k.length > 1 && k !== "^C" ? "wide" : "" }, k === "Tab" ? "TAB ⇥" : k);
      // pointerdown + preventDefault: фокус остаётся в поле, клавиатура не прячется
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        void this.key(k);
      });
      keys.append(b);
    }
    this.el = h("div", { class: "term" }, head, this.out, form, keys);
    this.out.addEventListener("click", () => {
      if (!window.getSelection()?.toString()) this.focus(false);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        void this.key("Tab");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        void this.key("↑");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        void this.key("↓");
      } else if (e.key === "c" && e.ctrlKey) {
        e.preventDefault();
        void this.key("^C");
      } else if (e.key === "l" && e.ctrlKey) {
        e.preventDefault();
        this.out.innerHTML = "";
      }
    });
    this.input.addEventListener("focus", () => setTimeout(() => this.scrollDown(), 300));
    if (opts.motd) this.print(opts.motd, "note");
    this.updatePrompt();
  }

  mount(): void {
    this.measure();
    this.ro = new ResizeObserver(() => {
      this.measure();
      this.scrollDown();
    });
    this.ro.observe(this.out);
  }

  destroy(): void {
    this.ro?.disconnect();
  }

  /** Сколько символов влезает в строку — для ls в колонках. */
  private measure(): void {
    const probe = h("span", { style: { visibility: "hidden", position: "absolute" } }, "MMMMMMMMMM");
    this.out.append(probe);
    const cw = probe.getBoundingClientRect().width / 10 || 8;
    probe.remove();
    const width = this.out.clientWidth - 20;
    this.shell.world.cols = Math.max(20, Math.floor(width / cw));
  }

  focus(scroll = true): void {
    this.input.focus({ preventScroll: !scroll });
  }

  private updatePrompt(): void {
    this.promptEl.textContent = this.shell.prompt();
    const u = this.shell.user;
    this.title.textContent = `${u.name}@${this.shell.world.hostname.split(".")[0]}: ${this.shell.cwd.replace(this.shell.env.HOME, "~")}`;
  }

  print(text: string, cls = ""): void {
    const div = h("div", { class: `line ${cls}`.trim() });
    div.innerHTML = ansiToHtml(text);
    this.out.append(div);
    while (this.out.childElementCount > 800) this.out.firstElementChild?.remove();
    this.scrollDown();
  }

  private scrollDown(): void {
    this.out.scrollTop = this.out.scrollHeight;
  }

  /** Выполнить строку так, будто её ввели руками. */
  async run(line: string): Promise<void> {
    this.input.value = line;
    await this.submit();
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const line = this.input.value;
    this.input.value = "";
    const echo = h("div", { class: "line" }, h("span", { class: "pr" }, this.shell.prompt()), h("span", { class: "cmd" }, line));
    this.out.append(echo);
    if (!line.trim()) {
      this.scrollDown();
      return;
    }
    this.busy = true;
    this.el.classList.add("busy");
    let r: RunResult;
    try {
      r = await this.shell.run(line);
    } catch (e) {
      r = { out: `тренажёр: внутренняя ошибка: ${e instanceof Error ? e.message : e}\n`, code: 1, kind: "error", cmd: "" };
    }
    this.busy = false;
    this.el.classList.remove("busy");
    if (/\x1b\[2J|\x1bc/.test(r.out) || r.kind === "clear") this.out.innerHTML = "";
    else if (r.out) this.print(r.out.replace(/\n$/, ""));
    this.histIdx = this.shell.history.length;
    this.draft = "";
    this.updatePrompt();
    this.scrollDown();
    this.onResult?.(r, line);
  }

  private async key(k: string): Promise<void> {
    const inp = this.input;
    const hist = this.shell.history;
    if (k === "Tab") {
      const pos = inp.selectionStart ?? inp.value.length;
      const head = inp.value.slice(0, pos);
      const tail = inp.value.slice(pos);
      const res = await this.shell.complete(head);
      if (res.options.length) {
        this.out.append(h("div", { class: "line" }, h("span", { class: "pr" }, this.shell.prompt()), h("span", { class: "cmd" }, inp.value)));
        this.print(res.options.join("  "));
      }
      inp.value = res.line + tail;
      inp.setSelectionRange(res.line.length, res.line.length);
    } else if (k === "↑") {
      if (this.histIdx === hist.length) this.draft = inp.value;
      if (this.histIdx > 0) this.histIdx--;
      inp.value = hist[this.histIdx] ?? inp.value;
      inp.setSelectionRange(inp.value.length, inp.value.length);
    } else if (k === "↓") {
      if (this.histIdx < hist.length) this.histIdx++;
      inp.value = this.histIdx === hist.length ? this.draft : hist[this.histIdx];
      inp.setSelectionRange(inp.value.length, inp.value.length);
    } else if (k === "^C") {
      this.out.append(h("div", { class: "line" }, h("span", { class: "pr" }, this.shell.prompt()), h("span", { class: "cmd" }, inp.value + "^C")));
      inp.value = "";
      this.scrollDown();
    } else {
      const s = inp.selectionStart ?? inp.value.length;
      const e = inp.selectionEnd ?? s;
      inp.setRangeText(k, s, e, "end");
    }
    inp.focus({ preventScroll: true });
  }
}
