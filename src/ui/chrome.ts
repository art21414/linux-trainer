// Общие элементы экранов: верхняя панель и нижняя навигация.
import { currentStreak, doneToday, progress } from "../state/progress";
import { h } from "./dom";

export function topBar(): HTMLElement {
  const streak = currentStreak();
  return h(
    "div",
    { class: "topbar" },
    h("div", { class: "brand", html: "linux<b>_</b>trainer" }),
    h("div", { class: `chip streak ${doneToday() ? "" : "off"}`, title: "Стрик" }, "🔥", String(streak)),
    h("div", { class: "chip xp", title: "Опыт" }, "⚡", String(progress.xp)),
  );
}

export function navBar(active: "home" | "sandbox" | "profile", go: (hash: string) => void): HTMLElement {
  const item = (id: typeof active, icon: string, label: string, hash: string) =>
    h("button", { class: active === id ? "active" : "", onclick: () => go(hash) }, h("span", {}, icon), label);
  return h(
    "nav",
    { class: "nav" },
    item("home", "🏠", "Учёба", "#/"),
    item("sandbox", "💻", "Терминал", "#/sandbox"),
    item("profile", "👤", "Профиль", "#/profile"),
  );
}
