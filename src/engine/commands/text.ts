// tail и wc: свои версии (just-bash не знает «Is a directory», ширину счётчиков coreutils и wc -L).
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { World } from "../world";
import { resolve } from "../path";
import { bytesToText, fail, invalidOpt, parseArgs } from "../util";
import { parseCount } from "./files";

/** Прочитать операнд: текст или текст ошибки (для head/tail/wc одинаково). */
async function readOperand(w: World, cwd: string, t: string): Promise<{ text?: string; dir?: boolean; err?: string; regularSize?: number }> {
  const abs = resolve(cwd, t);
  const inf = await w.info(abs, true);
  if (!inf) return { err: "No such file or directory" };
  if (!(await w.canTraverse(abs)) || (!inf.isDir && !w.permOn(inf, "r"))) return { err: "Permission denied" };
  if (inf.isDir) return { dir: true };
  const text = (await w.read(abs)) ?? "";
  return { text, regularSize: new TextEncoder().encode(text).length };
}

export function tailCommand(w: World): Command {
  return defineCommand("tail", async (args, ctx) => {
    const norm = args.map((a, i) => (/^-\d+$/.test(a) && !["-n", "-c", "--lines", "--bytes"].includes(args[i - 1] ?? "") ? `-n${a.slice(1)}` : a));
    const p = parseArgs(norm, { short: "qvz", withValue: ["n", "c"], long: { lines: "n", bytes: "c", quiet: "q", silent: "q", verbose: "v", "zero-terminated": "z" } });
    if (p.bad) return fail(invalidOpt("tail", p.bad));
    let mode: "n" | "c" = "n";
    let raw = "10";
    for (const a of norm) {
      if (a === "--") break;
      const m = /^-[a-zA-Z]*([nc])(.*)$/.exec(a) ?? /^--(lines|bytes)=(.*)$/.exec(a);
      if (m) {
        mode = m[1][0] as "n" | "c";
        raw = m[2] || p.values.get(mode) || raw;
      }
    }
    if (p.values.has("n") && mode === "n") raw = p.values.get("n")!;
    if (p.values.has("c") && mode === "c") raw = p.values.get("c")!;
    const from = raw.startsWith("+");
    const count = parseCount(raw.replace(/^[+-]/, ""));
    if (count === null) return fail(`tail: invalid number of ${mode === "n" ? "lines" : "bytes"}: '${raw}'`);
    const files = p.rest.length ? p.rest : ["-"];
    const header = files.length > 1 ? !p.flags.has("q") : p.flags.has("v");
    const sep = p.flags.has("z") ? "\0" : "\n";
    const take = (text: string): string => {
      if (mode === "c") {
        const b = new TextEncoder().encode(text);
        return new TextDecoder().decode(from ? b.slice(Math.max(0, count - 1)) : count === 0 ? b.slice(b.length) : b.slice(Math.max(0, b.length - count)));
      }
      const trailing = text.endsWith(sep);
      const lines = text.split(sep);
      if (trailing) lines.pop();
      const kept = from ? lines.slice(Math.max(0, count - 1)) : count === 0 ? [] : lines.slice(Math.max(0, lines.length - count));
      return kept.join(sep) + (kept.length && trailing ? sep : "");
    };
    let out = "";
    let err = "";
    let code = 0;
    let first = true;
    for (const t of files) {
      let text: string;
      let shown = t;
      if (t === "-") {
        text = bytesToText(ctx.stdin);
        shown = "standard input";
      } else {
        const r = await readOperand(w, ctx.cwd, t);
        if (r.err) {
          err += `tail: cannot open '${t}' for reading: ${r.err}\n`;
          code = 1;
          continue;
        }
        if (r.dir) {
          if (header) out += `${first ? "" : "\n"}==> ${shown} <==\n`;
          first = false;
          err += `tail: error reading '${t}': Is a directory\n`;
          code = 1;
          continue;
        }
        text = r.text!;
      }
      if (header) out += `${first ? "" : "\n"}==> ${shown} <==\n`;
      first = false;
      out += take(text);
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

export function wcCommand(w: World): Command {
  return defineCommand("wc", async (args, ctx) => {
    const p = parseArgs(args, { short: "lwcmL", long: { lines: "l", words: "w", bytes: "c", chars: "m", "max-line-length": "L" } });
    if (p.bad) return fail(invalidOpt("wc", p.bad));
    const f = p.flags;
    const any = ["l", "w", "c", "m", "L"].some((k) => f.has(k));
    const show = { l: !any || f.has("l"), w: !any || f.has("w"), m: f.has("m"), c: !any || f.has("c"), L: f.has("L") };
    const columns = Object.values(show).filter(Boolean).length;
    const files = p.rest.length ? p.rest : ["-"];

    type Row = { name: string; l: number; w: number; m: number; c: number; L: number };
    const rows: Row[] = [];
    let err = "";
    let code = 0;
    let minWidth = 1;
    let regTotal = 0;
    for (const t of files) {
      let text: string;
      if (t === "-") {
        text = bytesToText(ctx.stdin);
        minWidth = 7; // stdin — обычно пайп: coreutils берёт ширину 7
      } else {
        const r = await readOperand(w, ctx.cwd, t);
        if (r.err) {
          err += `wc: ${t}: ${r.err}\n`;
          code = 1;
          continue;
        }
        if (r.dir) {
          err += `wc: ${t}: Is a directory\n`;
          code = 1;
          minWidth = 7;
          rows.push({ name: t, l: 0, w: 0, m: 0, c: 0, L: 0 });
          continue;
        }
        text = r.text!;
        regTotal += r.regularSize!;
      }
      let maxLen = 0;
      for (const line of text.split("\n")) {
        let col = 0;
        for (const ch of line.replace(/\r$/, "")) col = ch === "\t" ? (Math.floor(col / 8) + 1) * 8 : col + 1;
        maxLen = Math.max(maxLen, col);
      }
      rows.push({
        name: t === "-" && p.rest.length === 0 ? "" : t,
        l: (text.match(/\n/g) ?? []).length,
        w: text.split(/\s+/).filter(Boolean).length,
        m: [...text].length,
        c: new TextEncoder().encode(text).length,
        L: maxLen,
      });
    }
    if (rows.length > 1) rows.push({ name: "total", l: 0, w: 0, m: 0, c: 0, L: 0 });
    if (rows.length > 1) {
      const real = rows.slice(0, -1);
      const tot = rows[rows.length - 1];
      for (const r of real) {
        tot.l += r.l;
        tot.w += r.w;
        tot.m += r.m;
        tot.c += r.c;
        tot.L = Math.max(tot.L, r.L);
      }
    }
    // ширина как у coreutils: цифры суммарного размера обычных файлов, не меньше 7 для пайпов/каталогов; одна колонка без файла — без отступа
    let width = Math.max(minWidth, String(regTotal).length);
    if (columns === 1 && files.length === 1) width = 1; // один счётчик и один файл — без отступа (`wc -l f` → «2 f»)
    const fmt = (r: Row) => {
      const cells: number[] = [];
      if (show.l) cells.push(r.l);
      if (show.w) cells.push(r.w);
      if (show.m) cells.push(r.m);
      if (show.c) cells.push(r.c);
      if (show.L) cells.push(r.L);
      return cells.map((n) => String(n).padStart(width)).join(" ") + (r.name ? " " + r.name : "") + "\n";
    };
    return { stdout: rows.map(fmt).join(""), stderr: err, exitCode: code };
  });
}
