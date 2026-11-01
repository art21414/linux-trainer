import { describe, expect, it } from "vitest";
import { ALL_TOPICS, allExercises, allSets, SECTIONS } from "../src/content/topics";
import { parseTheory, renderMarkdown } from "../src/content/theory";
import { createServer, Shell } from "../src/engine/shell";
import type { TerminalEx } from "../src/content/types";

async function runScript(shell: Shell, script: string) {
  for (const line of script.split("\n")) await shell.run(line);
}

async function fresh(t: TerminalEx) {
  const w = await createServer();
  if (t.setup) await t.setup(w);
  const shell = new Shell(w, { user: t.user ?? "root", cwd: t.cwd });
  return { w, shell };
}

describe("content: структура", () => {
  it("id разделов, тем и наборов уникальны", () => {
    const topics = ALL_TOPICS.map((t) => t.id);
    expect(new Set(topics).size).toBe(topics.length);
    expect(new Set(SECTIONS.map((s) => s.id)).size).toBe(SECTIONS.length);
    for (const t of ALL_TOPICS) {
      const ids = allSets(t).map((s) => s.id);
      expect(new Set(ids).size, `${t.id}: наборы`).toBe(ids.length);
      expect(t.exam.id).toBe("exam");
    }
  });

  it("id заданий уникальны глобально", () => {
    const ids = ALL_TOPICS.flatMap((t) => allExercises(t).map((e) => e.id));
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  for (const topic of ALL_TOPICS) {
    describe(`тема ${topic.id}`, () => {
      const parsed = parseTheory(topic.theory);
      const anchors = parsed.sections.map((s) => s.anchor);

      it("якоря theory.md уникальны, подтем 3–8 (временная тема-пример: ≥ 1)", () => {
        expect(new Set(anchors).size).toBe(anchors.length);
        expect(anchors.length).toBeGreaterThan(0);
      });

      it("каждый якорь из заданий существует", () => {
        for (const e of allExercises(topic)) if (e.theory) expect(anchors, `${e.id}: theory="${e.theory}"`).toContain(e.theory);
      });

      it("terminal ≥ 75 %", () => {
        const all = allExercises(topic);
        const term = all.filter((e) => e.type === "terminal").length;
        expect(term / all.length).toBeGreaterThanOrEqual(0.75);
      });

      it("зачёт: 4–6 заданий", () => {
        expect(topic.exam.exercises.length).toBeGreaterThanOrEqual(4);
        expect(topic.exam.exercises.length).toBeLessThanOrEqual(6);
      });

      for (const ex of allExercises(topic)) {
        if (ex.type === "choice") {
          it(`${ex.id} choice: answer валиден, explain есть`, () => {
            expect(ex.options[ex.answer]).toBeDefined();
            expect(ex.explain.trim().length).toBeGreaterThan(0);
            expect(new Set(ex.options).size).toBe(ex.options.length);
          });
          continue;
        }
        it(`${ex.id} terminal: старт не решён, solution решает`, async () => {
          const { w, shell } = await fresh(ex);
          expect(await ex.check({ world: w, shell })).not.toBe(true);
          for (const line of ex.solution.split("\n")) {
            const r = await shell.run(line);
            expect(r.code, `${line}: ${r.out}`).toBe(0);
          }
          expect(await ex.check({ world: w, shell })).toBe(true);
        });
        (ex.accept ?? []).forEach((sol, i) => {
          it(`${ex.id} accept[${i}] засчитывается`, async () => {
            const { w, shell } = await fresh(ex);
            await runScript(shell, sol);
            expect(await ex.check({ world: w, shell }), sol).toBe(true);
          });
        });
        (ex.reject ?? []).forEach((sol, i) => {
          it(`${ex.id} reject[${i}] не засчитывается`, async () => {
            const { w, shell } = await fresh(ex);
            await runScript(shell, sol);
            expect(await ex.check({ world: w, shell }), sol).not.toBe(true);
          });
        });
      }
    });
  }
});

describe("theory: парсер", () => {
  it("делит на подтемы, не путает заголовки внутри блоков кода", () => {
    const p = parseTheory("# T\nвведение\n\n## Раз {#one}\nтекст\n```bash\n## не заголовок {#fake}\n```\n## Два {#two}\nещё");
    expect(p.intro).toBe("введение");
    expect(p.sections.map((s) => s.anchor)).toEqual(["one", "two"]);
    expect(p.sections[0].body).toContain("## не заголовок");
  });
});

// Рендер в DOM проверяется в браузере (vitest идёт в node); здесь — только что функция экспортируется.
describe("theory: рендер", () => {
  it("renderMarkdown экспортируется", () => expect(typeof renderMarkdown).toBe("function"));
});
