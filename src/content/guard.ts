import type { World } from "../engine/world";
import type { Topic } from "./types";

// ---------- «соседи целы» (content-standard §4) ----------
// После setup запоминаем состояние деревьев keep; check сначала проверяет, что ничего из них не пострадало
// (кроме except — того, что задание и должно менять). Для файлов — содержимое, mtime, права, владелец;
// для каталогов и ссылок — тип, права, владелец (и цель ссылки). Новые файлы не мешают.
// Разрушительные решения для reject (по одному на задание минимум) — в GUARDS.reject, дописываются в reject задания.
interface Snap { kind: "f" | "d" | "l"; mode: number; uid: number; gid: number; content?: string; mtime?: number; target?: string }
const snaps = new WeakMap<World, Map<string, Snap>>();
async function snapOf(w: World, p: string): Promise<Snap | null> {
  const i = await w.info(p);
  if (!i) return null;
  const s: Snap = { kind: i.isLink ? "l" : i.isDir ? "d" : "f", mode: i.mode & 0o7777, uid: i.uid, gid: i.gid };
  if (s.kind === "f") {
    s.content = await w.base.readFile(p).catch(() => ""); // без w.read: тот сдвигает atime
    s.mtime = i.mtime.getTime();
  }
  if (s.kind === "l") s.target = await w.base.readlink(p).catch(() => "");
  return s;
}
async function keep(w: World, roots: string[]): Promise<void> {
  const m = new Map<string, Snap>();
  for (const r of roots) for (const p of w.subtree(r)) {
    const s = await snapOf(w, p);
    if (s) m.set(p, s);
  }
  snaps.set(w, m);
}
async function damaged(w: World, except: string[] = []): Promise<string | null> {
  for (const [p, s] of snaps.get(w) ?? []) {
    if (except.some((e) => p === e || p.startsWith(e + "/"))) continue;
    const now = await snapOf(w, p);
    if (!now) return `Пропал ${p} — его трогать было нельзя. Начни заново.`;
    if (now.kind !== s.kind) return `${p} подменён — его трогать было нельзя. Начни заново.`;
    if (now.mode !== s.mode || now.uid !== s.uid || now.gid !== s.gid)
      return `У ${p} изменились права или владелец — его трогать было нельзя. Начни заново.`;
    if (now.content !== s.content || now.mtime !== s.mtime || now.target !== s.target)
      return `Изменён ${p} — его трогать было нельзя. Начни заново.`;
  }
  return null;
}
export interface Guard { keep: string[]; except?: string[]; reject?: string[] }
/** Навесить «соседи целы» на задания темы. */
export function guarded(t: Topic, guards: Record<string, Guard>): Topic {
  for (const set of [...t.sets, t.exam])
    for (const e of set.exercises) {
      const g = guards[e.id];
      if (!g || e.type !== "terminal") continue;
      const setup = e.setup;
      const check = e.check;
      e.setup = async (w) => {
        if (setup) await setup(w);
        await keep(w, g.keep);
      };
      e.check = async (c) => (await damaged(c.world, g.except)) ?? check(c);
      if (g.reject) e.reject = [...(e.reject ?? []), ...g.reject];
    }
  return t;
}
