// file: тип по содержимому (подмножество libmagic из Rocky 9: текст, скрипты, gzip, ELF, пустой, каталог, ссылка).
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { World } from "../world";
import { resolve } from "../path";
import { fail, parseArgs } from "../util";

const TRY = "Usage: file [OPTION...] [FILE...]\nTry `file --help' for more information.";
const CHARDEV: Record<string, string> = { "/dev/null": "1/3", "/dev/zero": "1/5", "/dev/full": "1/7", "/dev/random": "1/8", "/dev/urandom": "1/9", "/dev/tty": "5/0", "/dev/console": "5/1" };

interface Kind {
  text: string;
  mime: string;
}

function shebang(first: string): { text: string; mime: string } | null {
  const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(first);
  if (!m) return null;
  const prog = (m[1].endsWith("/env") ? m[2] ?? "" : m[1]).replace(/^.*\//, "");
  if (prog === "bash") return { text: "Bourne-Again shell script", mime: "text/x-shellscript" };
  if (prog === "sh") return { text: "POSIX shell script", mime: "text/x-shellscript" };
  if (/^python/.test(prog)) return { text: "Python script", mime: "text/x-script.python" };
  if (prog === "perl") return { text: "Perl script text executable", mime: "text/x-perl" };
  return { text: `a ${m[1].endsWith("/env") ? (m[2] ?? "") : m[1]} script`, mime: "text/x-shellscript" };
}

function describeContent(buf: Uint8Array, path: string): Kind {
  if (buf.length === 0) return { text: "empty", mime: "application/x-empty; charset=binary" };
  if (buf[0] === 0x1f && buf[1] === 0x8b) return { text: "gzip compressed data, from Unix", mime: "application/gzip; charset=binary" };
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4) return { text: "Zip archive data, at least v2.0 to extract", mime: "application/zip; charset=binary" };
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46)
    return { text: "ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked", mime: "application/x-pie-executable; charset=binary" };
  let ascii = true;
  let bin = false;
  for (const b of buf) {
    if (b > 0x7f) ascii = false;
    if (b === 0 || (b < 32 && ![9, 10, 11, 12, 13, 27].includes(b))) bin = true;
  }
  let utf8 = false;
  if (!ascii && !bin) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buf);
      utf8 = true;
    } catch {
      utf8 = false;
    }
  }
  if (bin || (!ascii && !utf8 && false)) return { text: "data", mime: "application/octet-stream; charset=binary" };
  const text = new TextDecoder("latin1").decode(buf);
  const lines = text.split("\n");
  const sb = shebang(lines[0]);
  // скрипты и обычный текст
  let desc = sb ? sb.text + ", " : "";
  const charset = ascii ? "ASCII" : utf8 ? "Unicode" : "ISO-8859";
  desc += ascii ? "ASCII text" : utf8 ? "Unicode text, UTF-8 text" : "ISO-8859 text";
  if (sb) desc += " executable";
  const long = Math.max(...lines.map((l) => l.replace(/\r$/, "").length));
  if (long > 300) desc += `, with very long lines (${long})`;
  const crlf = lines.slice(0, -1).filter((l) => l.endsWith("\r")).length;
  if (crlf > 0) desc += crlf === lines.length - 1 ? ", with CRLF line terminators" : ", with CRLF, LF line terminators";
  if (!text.includes("\n")) desc += ", with no line terminators";
  void path;
  const mimeType = sb ? sb.mime : "text/plain";
  const cs = ascii ? "us-ascii" : utf8 ? "utf-8" : "iso-8859-1";
  void charset;
  return { text: desc, mime: `${mimeType}; charset=${cs}` };
}

export function fileCommand(w: World): Command {
  return defineCommand("file", async (args, ctx) => {
    const p = parseArgs(args, {
      short: "ibLhsz",
      long: { mime: "i", brief: "b", dereference: "L", "no-dereference": "h", "mime-type": "mime-type", "mime-encoding": "mime-encoding" },
    });
    if (p.bad) return fail(p.bad.startsWith("--") ? `file: unrecognized option '${p.bad}'\n${TRY}` : `file: invalid option -- '${p.bad}'\n${TRY}`, 1);
    if (!p.rest.length) return fail(TRY, 1);
    const f = p.flags;
    const mime = f.has("i") || f.has("mime-type") || f.has("mime-encoding");
    const rows: { name: string; text: string }[] = [];
    for (const t of p.rest) {
      const abs = resolve(ctx.cwd, t);
      let text: string;
      if (!(await w.canTraverse(abs))) {
        text = "cannot open `" + t + "' (Permission denied)";
        rows.push({ name: t, text });
        continue;
      }
      const lin = await w.info(abs);
      const inf = (await w.info(abs, f.has("L"))) ?? lin;
      if (!lin || !inf) {
        rows.push({ name: t, text: "cannot open `" + t + "' (No such file or directory)" });
        continue;
      }
      let k: Kind;
      if (inf.isLink) {
        const target = await w.base.readlink(inf.path);
        const ok = !!(await w.info(inf.path, true));
        k = { text: `${ok ? "" : "broken "}symbolic link to ${w.files.displayTarget(target)}`, mime: "inode/symlink; charset=binary" };
      } else if (inf.isDir) {
        k = { text: "directory", mime: "inode/directory; charset=binary" };
      } else if (CHARDEV[inf.path]) {
        k = { text: `character special (${CHARDEV[inf.path]})`, mime: "inode/chardevice; charset=binary" };
      } else {
        let buf: Uint8Array;
        try {
          if (!(await w.canAccess(inf.path, "r"))) throw new Error("EACCES");
          buf = await w.fs.readFileBuffer(inf.path);
        } catch {
          rows.push({ name: t, text: "cannot open `" + t + "' (Permission denied)" });
          continue;
        }
        k = describeContent(buf, inf.path);
        // заглушки команд в /usr/bin — для пользователя это настоящие исполняемые ELF
        const real = await w.resolveFinal(inf.path);
        if (/^\/usr\/s?bin\//.test(real) && /^#!\/bin\/bash\n# Built-in command/.test(new TextDecoder().decode(buf))) {
          const id = (w.inodes.ino(real) * 2654435761).toString(16).padStart(8, "0").slice(-8);
          k = {
            text: `ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, BuildID[sha1]=${id.repeat(5)}, for GNU/Linux 3.2.0, stripped`,
            mime: "application/x-pie-executable; charset=binary",
          };
        }
      }
      let text2 = k.text;
      if (mime) {
        const [type, cs] = k.mime.split("; charset=");
        text2 = f.has("mime-type") ? type : f.has("mime-encoding") ? cs : k.mime.replace("; ", "; ");
      }
      rows.push({ name: t, text: text2 });
    }
    const brief = f.has("b");
    const width = Math.max(...rows.map((r) => r.name.length));
    const out = rows.map((r) => (brief ? r.text : `${(r.name + ":").padEnd(width + 1)} ${r.text}`)).join("\n") + "\n";
    return { stdout: out, stderr: "", exitCode: 0 };
  });
}
