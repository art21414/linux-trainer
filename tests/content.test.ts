import { describe, expect, it } from "vitest";
import { ALL_LESSONS } from "../src/content/units";
import { createServer, Shell } from "../src/engine/shell";
import type { TerminalEx } from "../src/content/types";

describe("content", () => {
  for (const lesson of ALL_LESSONS) {
    lesson.exercises.forEach((ex, i) => {
      if (ex.type === "choice" || ex.type === "fill") {
        it(`${lesson.id}#${i} answer index valid`, () => expect(ex.options[ex.answer]).toBeDefined());
      }
      if (ex.type !== "terminal") return;
      const t = ex as TerminalEx;
      it(`${lesson.id}#${i} terminal: not solved at start, solved by solution`, async () => {
        const w = await createServer();
        if (t.setup) await t.setup(w);
        const shell = new Shell(w, { user: t.user ?? "root", cwd: t.cwd });
        expect(await t.check({ world: w, shell })).not.toBe(true);
        for (const line of t.solution.split("\n")) {
          const r = await shell.run(line);
          expect(r.code, `${line}: ${r.out}`).toBe(0);
        }
        expect(await t.check({ world: w, shell })).toBe(true);
      });
    });
  }

  it("dev write task accepts alternative solutions", async () => {
    const t = ALL_LESSONS.find((l) => l.id === "u2l2")!.exercises.find((e) => e.type === "terminal") as TerminalEx;
    for (const sol of ["chown :dev /srv/project; chmod 775 /srv/project", "chown root:dev /srv/project && chmod g=rwx /srv/project", "chgrp dev /srv/project; chmod 2775 /srv/project"]) {
      const w = await createServer();
      await t.setup!(w);
      const shell = new Shell(w, { user: "root" });
      await shell.run(sol);
      expect(await t.check({ world: w, shell }), sol).toBe(true);
    }
    const w = await createServer();
    await t.setup!(w);
    const shell = new Shell(w, { user: "root" });
    await shell.run("chmod 777 /srv/project");
    expect(typeof (await t.check({ world: w, shell }))).toBe("string");
  });
});
