import { UNITS, ALL_LESSONS } from "../content/units";
import { currentStreak, dailyXp, doneToday, progress } from "../state/progress";
import { h } from "./dom";
import { Mascot } from "./mascot";
import { navBar, topBar } from "./chrome";

const ZIGZAG = [0, 44, 66, 44, 0, -44, -66, -44];

export function isUnlocked(lessonId: string): boolean {
  const i = ALL_LESSONS.findIndex((l) => l.id === lessonId);
  return i === 0 || !!progress.lessons[ALL_LESSONS[i - 1]?.id];
}

export function renderHome(root: HTMLElement, go: (hash: string) => void): () => void {
  const mascot = new Mascot({ size: "lg", greet: true });
  const goal = progress.settings.dailyGoal;
  const dxp = dailyXp();
  const current = ALL_LESSONS.find((l) => !progress.lessons[l.id] && isUnlocked(l.id));

  const scroll = h("div", { class: "scroll" });
  scroll.append(
    h("div", { class: "hero" }, mascot.el),
    h(
      "div",
      { class: "goal" },
      h("div", { class: "goal-top" }, h("span", {}, doneToday() ? "🔥 Сегодня уже занимался" : "🎯 Цель дня"), h("b", {}, `${Math.min(dxp, goal)} / ${goal} XP`)),
      h("div", { class: "bar" }, h("i", { style: { width: `${Math.min(100, (dxp / goal) * 100)}%` } })),
    ),
  );

  let n = 0;
  UNITS.forEach((u, ui) => {
    const unitEl = h(
      "div",
      { class: "unit", style: { "--color": u.color, "--shade": u.shade } },
      h("small", {}, `Раздел ${ui + 1}`),
      h("h2", {}, u.title),
      h("p", {}, u.subtitle),
    );
    const path = h("div", { class: "path", style: { "--color": u.color, "--shade": u.shade } });
    for (const l of u.lessons) {
      const done = !!progress.lessons[l.id];
      const open = isUnlocked(l.id);
      const isCur = current?.id === l.id;
      const node = h(
        "button",
        {
          class: `node ${done ? "done" : ""} ${open ? "" : "locked"} ${isCur ? "current" : ""}`,
          "aria-label": l.title,
          onclick: () => {
            if (open) go(`#/lesson/${l.id}`);
            else mascot.say("Не спеши. Сначала предыдущий урок.");
          },
        },
        done ? "⭐" : open ? l.icon : "🔒",
      );
      const wrap = h(
        "div",
        { class: "node-wrap", style: { transform: `translateX(${ZIGZAG[n++ % ZIGZAG.length]}px)` } },
        isCur ? h("div", { class: "start-tip" }, progress.lessons[l.id] ? "ЕЩЁ РАЗ" : "НАЧАТЬ") : null,
        node,
        h("div", { class: "node-label" }, l.title),
      );
      path.append(wrap);
    }
    // стили CSS-переменных через setProperty (Object.assign не умеет --vars)
    for (const el of [unitEl, path]) {
      el.style.setProperty("--color", u.color);
      el.style.setProperty("--shade", u.shade);
    }
    scroll.append(unitEl, path);
  });
  scroll.append(h("div", { class: "soon" }, "Дальше: процессы, systemd, сеть, диски…\nПалыч уже варит кофе ☕"));

  root.append(h("div", { class: "screen" }, topBar(), scroll, navBar("home", go)));
  // прокрутить к текущему уроку
  requestAnimationFrame(() => {
    const cur = scroll.querySelector(".node.current");
    if (cur && cur.getBoundingClientRect().top > window.innerHeight * 0.75) cur.scrollIntoView({ block: "center" });
  });
  void currentStreak;
  return () => mascot.destroy();
}
