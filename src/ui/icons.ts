// Иконки «Консоли»: сетка 24, линия 2px, квадратные окончания и острые углы (как рамки TUI), без заливок
// (кроме точечных акцентов). Цвет — currentColor. Использование: icon("flame", { size: 20 }).
export type IconName =
  | "program" | "terminal" | "profile" | "book" | "check" | "cross" | "lock" | "flame" | "bolt" | "play"
  | "back" | "close" | "chevron" | "hint" | "star" | "exam" | "known" | "warning" | "sound-on" | "sound-off"
  | "export" | "import" | "trash" | "refresh" | "dot";

// Каждая иконка — набор <path d>, у части есть "f:" — залитый элемент.
const P: Record<IconName, string[]> = {
  program: ["M3 4h18v4H3z", "M3 10h18v4H3z", "M3 16h12v4H3z"],
  terminal: ["M3 4h18v16H3z", "M7 9l4 3-4 3", "M13 16h4"],
  profile: ["M8 4h8v7H8z", "M4 21v-4l4-3h8l4 3v4z"],
  book: ["M4 4h7v16H4z", "M13 4h7v16h-7z", "M7 8h1M16 8h1"],
  check: ["M4 12.5l5 5L20 6.5"],
  cross: ["M5 5l14 14M19 5L5 19"],
  lock: ["M6 11h12v9H6z", "M8 11V7l2-3h4l2 3v4", "f:M11 14h2v3h-2z"],
  flame: ["M12 3c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-4 3-6 1 1 1 2 2 2 1-3 0-5 1-8z"],
  bolt: ["M13 3L5 13h6l-1 8 8-11h-6z"],
  play: ["M7 4l13 8-13 8z"],
  back: ["M20 12H5", "M11 6l-6 6 6 6"],
  close: ["M5 5l14 14M19 5L5 19"],
  chevron: ["M9 5l7 7-7 7"],
  hint: ["M9 17h6", "M10 21h4", "M8 14c-2-1-3-3-3-5a7 7 0 0 1 14 0c0 2-1 4-3 5v3H8z"],
  star: ["M12 3l2.7 6 6.3.6-4.8 4.2 1.5 6.2L12 16.6 6.3 20l1.5-6.2L3 9.6 9.3 9z"],
  exam: ["M5 3h14v18H5z", "M9 8h6M9 12h6", "M9 16l2 2 4-4"],
  known: ["M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z", "f:M10 10h4v4h-4z"],
  warning: ["M12 3l10 18H2z", "M12 10v5", "f:M11 17.5h2v2h-2z"],
  "sound-on": ["M4 9h4l5-4v14l-5-4H4z", "M16 9c1.5 1.5 1.5 4.5 0 6", "M19 6c3 3 3 9 0 12"],
  "sound-off": ["M4 9h4l5-4v14l-5-4H4z", "M17 9l5 6M22 9l-5 6"],
  export: ["M12 15V3", "M7 8l5-5 5 5", "M4 14v7h16v-7"],
  import: ["M12 3v12", "M7 10l5 5 5-5", "M4 14v7h16v-7"],
  trash: ["M4 6h16", "M9 6V3h6v3", "M6 6l1 15h10l1-15", "M10 10v7M14 10v7"],
  refresh: ["M20 5v6h-6", "M4 19v-6h6", "M5.5 9A8 8 0 0 1 19 11M18.5 15A8 8 0 0 1 5 13"],
  dot: ["f:M8 8h8v8H8z"],
};

const NS = "http://www.w3.org/2000/svg";

export function icon(name: IconName, opts: { size?: number; class?: string } = {}): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  const size = opts.size ?? 24;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "square");
  svg.setAttribute("stroke-linejoin", "miter");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `ico ico-${name}${opts.class ? " " + opts.class : ""}`);
  for (const d of P[name]) {
    const p = document.createElementNS(NS, "path");
    if (d.startsWith("f:")) {
      p.setAttribute("d", d.slice(2));
      p.setAttribute("fill", "currentColor");
      p.setAttribute("stroke", "none");
    } else p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

export const ICON_NAMES = Object.keys(P) as IconName[];
