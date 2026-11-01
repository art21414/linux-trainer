import { describe, expect, it } from "vitest";
import { completeSet, continueTarget, markKnown, markRead, migrate, noteMistake, progress, resetProgress, topicProgress, topicStatus } from "../src/state/progress";

const T = (id: string) => ({ id, sets: [{ id: "1", exercises: [{ id: "a" }, { id: "b" }] }, { id: "2", exercises: [{ id: "c" }, { id: "d" }] }], exam: { exercises: [{ id: "e" }] } });

describe("progress v2", () => {
  it("миграция v1 сохраняет xp/streak/daily/unknown/settings и отбрасывает уроки", () => {
    const p = migrate({ v: 1, xp: 120, lessons: { u1l1: { best: 1, times: 1 } }, mistakes: { "u1l1#2": 3 }, streak: { count: 4, last: "2026-10-30" }, daily: { day: "2026-10-30", xp: 15 }, unknown: [{ cmd: "x", line: "x", at: "t", kind: "notfound" }], settings: { sound: false, dailyGoal: 40 } });
    expect(p.v).toBe(2);
    expect(p.xp).toBe(120);
    expect(p.streak.count).toBe(4);
    expect(p.daily.xp).toBe(15);
    expect(p.unknown).toHaveLength(1);
    expect(p.settings).toEqual({ sound: false, dailyGoal: 40 });
    expect(p.sets).toEqual({});
    expect(p.mistakes).toEqual({});
  });

  it("статусы и continueTarget", () => {
    resetProgress();
    const a = T("a");
    const b = T("b");
    expect(topicStatus(a)).toBe("new");
    expect(continueTarget([a, b])).toEqual({ topicId: "a", setId: "1" });
    markRead("a", "x");
    expect(topicStatus(a)).toBe("in-progress");
    completeSet("a", "1", 1, 10);
    expect(topicProgress(a)).toBe(0.5);
    expect(continueTarget([a, b])).toEqual({ topicId: "a", setId: "2" });
    completeSet("a", "exam", 0.8, 10);
    expect(progress.exams.a).toBeUndefined();
    completeSet("a", "exam", 1, 10);
    expect(topicStatus(a)).toBe("closed-by-exam");
    expect(continueTarget([a, b])).toEqual({ topicId: "b", setId: "1" });
    completeSet("a", "2", 1, 10);
    expect(topicStatus(a)).toBe("mastered");
    markKnown("b", "y");
    expect(topicStatus(b)).toBe("in-progress");
    noteMistake("b", "c");
    expect(progress.mistakes["b/c"].count).toBe(1);
    resetProgress();
  });
});
