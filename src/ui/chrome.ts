// Общие элементы экранов: верхняя панель и нижняя навигация.
import { currentStreak, doneToday, progress } from "../state/progress";
import { h } from "./dom";
import { icon } from "./icons";
import type { IconName } from "./icons";

export function topBar(): HTMLElement {
  const streak = currentStreak();
  return h(
    "div",
    { class: "topbar" },
    h("div", { class: "brand", html: "linux<b>_</b>trainer" }),
    h("div", { class: `chip streak ${doneToday() ? "" : "off"}`, title: "Стрик" }, icon("flame", { size: 16 }), String(streak)),
    h("div", { class: "chip xp", title: "Опыт" }, icon("bolt", { size: 16 }), String(progress.xp)),
  );
}

export function navBar(active: "home" | "sandbox" | "profile", go: (hash: string) => void): HTMLElement {
  const item = (id: typeof active, ico: IconName, label: string, hash: string) =>
    h("button", { class: active === id ? "active" : "", onclick: () => go(hash) }, h("span", { class: "nav__ico" }, icon(ico, { size: 22 })), label);
  return h(
    "nav",
    { class: "nav" },
    item("home", "program", "Программа", "#/"),
    item("sandbox", "terminal", "Терминал", "#/sandbox"),
    item("profile", "profile", "Профиль", "#/profile"),
  );
}
