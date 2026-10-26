// Мини-помощники для DOM без фреймворка.
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** **жирный**, `код`, пустая строка — абзац. */
export function md(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map(
      (p) =>
        "<p>" +
        esc(p)
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\n/g, "<br>") +
        "</p>",
    )
    .join("");
}

/** Встроенная разметка без абзацев (для заголовков). */
export function mdInline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** Подсветка приглашения ($ / #) в блоках кода. */
export function codeHtml(code: string): string {
  return code
    .split("\n")
    .map((l) => {
      const m = /^(\[[^\]]+\][$#] |[$#] )(.*)$/.exec(l);
      return m ? `<span class="ps">${esc(m[1])}</span>${esc(m[2])}` : esc(l);
    })
    .join("\n");
}

export function toast(text: string, ms = 2200): void {
  const t = h("div", { class: "toast" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* нет вибро */
  }
}

export function confirmModal(title: string, text: string, okText: string, cancelText = "Отмена"): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (v: boolean) => {
      bg.remove();
      resolve(v);
    };
    const bg = h(
      "div",
      { class: "modal-bg", onclick: (e: Event) => e.target === bg && close(false) },
      h(
        "div",
        { class: "modal" },
        h("h3", {}, title),
        h("p", {}, text),
        h("button", { class: "btn red", onclick: () => close(true) }, okText),
        h("button", { class: "btn ghost", onclick: () => close(false) }, cancelText),
      ),
    );
    document.body.append(bg);
  });
}
