// touch: создание файлов и установка atime/mtime (-a -m -c -d -t -r --time), ctime ставит мир.
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { World } from "../world";
import { dirname, resolve } from "../path";
import { parseDateSpec, parseTouchT } from "../datespec";
import { errnoText, fail, invalidOpt, parseArgs } from "../util";

const TRY = "Try 'touch --help' for more information.";

export function touchCommand(w: World): Command {
  return defineCommand("touch", async (args, ctx) => {
    const p = parseArgs(args, {
      short: "acfmh",
      withValue: ["d", "r", "t", "time"],
      long: { date: "d", reference: "r", "no-create": "c", "no-dereference": "h", time: "time" },
    });
    if (p.bad) return fail(invalidOpt("touch", p.bad));
    const f = p.flags;
    if (!p.rest.length) return fail(`touch: missing file operand\n${TRY}`);

    let setA = f.has("a");
    let setM = f.has("m");
    const word = p.values.get("time");
    if (word !== undefined) {
      if (["atime", "access", "use"].includes(word)) setA = true;
      else if (["mtime", "modify"].includes(word)) setM = true;
      else return fail(`touch: invalid argument ‘${word}’ for ‘--time’\nValid arguments are:\n  - ‘atime’, ‘access’, ‘use’\n  - ‘mtime’, ‘modify’\n${TRY}`);
    }
    if (!setA && !setM) setA = setM = true;

    const now = new Date();
    const tStr = p.values.get("t");
    const dStr = p.values.get("d");
    const rStr = p.values.get("r");
    if (tStr !== undefined && (dStr !== undefined || rStr !== undefined)) return fail(`touch: cannot specify times from more than one source\n${TRY}`);
    let aTime = now;
    let mTime = now;
    let explicit = false;
    if (tStr !== undefined) {
      const d = parseTouchT(tStr, now);
      if (!d) return fail(`touch: invalid date format ‘${tStr}’`);
      aTime = mTime = d;
      explicit = true;
    } else if (dStr !== undefined) {
      const d = parseDateSpec(dStr, now);
      if (!d) return fail(`touch: invalid date format ‘${dStr}’`);
      aTime = mTime = d;
      explicit = true;
    } else if (rStr !== undefined) {
      const ref = resolve(ctx.cwd, rStr);
      const inf = await w.info(ref, !f.has("h"));
      if (!inf || !(await w.canTraverse(ref))) return fail(`touch: failed to get attributes of '${rStr}': ${inf ? "Permission denied" : "No such file or directory"}`);
      aTime = inf.atime;
      mTime = inf.mtime;
      explicit = true;
    }

    let err = "";
    let code = 0;
    const me = w.cur;
    for (const name of p.rest) {
      if (name === "-") continue; // touch - работает со stdout: у нас ничего не делает
      const abs = resolve(ctx.cwd, name);
      const target = f.has("h") ? abs : await w.resolveFinal(abs);
      const bad = (msg: string) => {
        err += `touch: ${msg}\n`;
        code = 1;
      };
      if (!(await w.canTraverse(target))) {
        if (!f.has("c") || (await w.info(target))) bad(`cannot touch '${name}': Permission denied`);
        continue;
      }
      let inf = await w.info(target);
      if (!inf) {
        if (f.has("c")) continue;
        if (!(await w.exists(dirname(target)))) {
          bad(`cannot touch '${name}': No such file or directory`);
          continue;
        }
        if (name.endsWith("/")) {
          bad(`cannot touch '${name}': No such file or directory`);
          continue;
        }
        try {
          await w.fs.writeFile(target, "");
        } catch (e) {
          bad(`cannot touch '${name}': ${errnoText(e)}`);
          continue;
        }
        inf = (await w.info(target))!;
        if (!explicit && setA && setM) continue; // время создания уже «сейчас»
      } else {
        const owner = me.uid === 0 || me.uid === inf.uid;
        const canWrite = w.permOn(inf, "w");
        if (!canWrite && !owner) {
          bad(`cannot touch '${name}': Permission denied`);
          continue;
        }
        if (explicit && !owner) {
          bad(`setting times of '${name}': Operation not permitted`);
          continue;
        }
      }
      await w.setTimes(target, { atime: setA ? aTime : undefined, mtime: setM ? mTime : undefined });
    }
    return { stdout: "", stderr: err, exitCode: code };
  });
}
