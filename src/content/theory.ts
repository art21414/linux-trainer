// Теория темы: разбор theory.md на подтемы и безопасный рендер подмножества markdown в DOM.
// Никакого innerHTML: всё строится через createElement/textContent.

export interface TheorySection {
  anchor: string;
  title: string;
  body: string;
}

export interface ParsedTheory {
  /** Текст до первого `##` (может быть пустым). Заголовок `# …` отбрасывается. */
  intro: string;
  sections: TheorySection[];
}

const H2 = /^##\s+(.+?)\s*\{#([A-Za-z0-9_-]+)\}\s*$/;

export function parseTheory(md: string): ParsedTheory {
  const intro: string[] = [];
  const sections: TheorySection[] = [];
  let cur: { anchor: string; title: string; lines: string[] } | null = null;
  let fence = false;
  const flush = () => {
    if (cur) sections.push({ anchor: cur.anchor, title: cur.title, body: cur.lines.join("\n").trim() });
  };
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence ? H2.exec(line) : null;
    if (m) {
      flush();
      cur = { title: m[1], anchor: m[2], lines: [] };
    } else if (cur) cur.lines.push(line);
    else if (!/^#\s/.test(line)) intro.push(line);
  }
  flush();
  return { intro: intro.join("\n").trim(), sections };
}

// ---------- рендер ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Встроенная разметка: **жирный**, `код`. */
export function inlineNodes(text: string): Node[] {
  const out: Node[] = [];
  const re = /`([^`]+)`|\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) out.push(el("code", undefined, m[1]));
    else {
      const b = el("strong");
      // внутри жирного допускаем код
      b.append(...inlineNodes(m[2]));
      out.push(b);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

const CALLOUTS: Record<string, string> = { "ловушка": "trap", "на практике": "practice", "важно": "note", "запомни": "note" };

function calloutClass(text: string): string {
  const m = /^\*\*(.+?)\*\*/.exec(text);
  const key = m ? m[1].replace(/[.:!]+$/, "").trim().toLowerCase() : "";
  return CALLOUTS[key] ?? "note";
}

const splitRow = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

/** Рендер markdown-подмножества: абзацы, списки, таблицы, цитаты-выноски, блоки кода. */
export function renderMarkdown(md: string): HTMLElement {
  const root = el("div", "md theory-md");
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const isBlockStart = (l: string) => /^```/.test(l) || /^\s*([-*]|\d+\.)\s+/.test(l) || /^>/.test(l) || /^\s*\|/.test(l) || /^#{3,4}\s/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const pre = el("pre", `codeblock lang-${fence[1] || "text"}`);
      pre.append(el("code", undefined, buf.join("\n")));
      root.append(pre);
      continue;
    }
    const hh = /^(#{3,4})\s+(.+)$/.exec(line);
    if (hh) {
      const h = el(hh[1].length === 3 ? "h4" : "h5");
      h.append(...inlineNodes(hh[2]));
      root.append(h);
      i++;
      continue;
    }
    if (/^>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      const text = buf.join("\n").trim();
      const box = el("blockquote", `callout ${calloutClass(text)}`);
      for (const para of text.split(/\n\s*\n/)) {
        const p = el("p");
        p.append(...inlineNodes(para.replace(/\n/g, " ")));
        box.append(p);
      }
      root.append(box);
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      const table = el("table");
      const tr = el("tr");
      for (const c of head) {
        const th = el("th");
        th.append(...inlineNodes(c));
        tr.append(th);
      }
      const thead = el("thead");
      thead.append(tr);
      table.append(thead);
      const tb = el("tbody");
      for (const r of rows) {
        const row = el("tr");
        for (const c of r) {
          const td = el("td");
          td.append(...inlineNodes(c));
          row.append(td);
        }
        tb.append(row);
      }
      table.append(tb);
      const wrap = el("div", "table-wrap");
      wrap.append(table);
      root.append(wrap);
      continue;
    }
    const list = /^\s*([-*]|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const ul = el(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let t = lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, "");
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) t += " " + lines[i++].trim();
        const li = el("li");
        li.append(...inlineNodes(t));
        ul.append(li);
      }
      root.append(ul);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++].trim());
    if (!buf.length) buf.push(lines[i++]);
    const p = el("p");
    p.append(...inlineNodes(buf.join(" ")));
    root.append(p);
  }
  return root;
}
