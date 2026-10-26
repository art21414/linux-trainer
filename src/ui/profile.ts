import { ALL_LESSONS } from "../content/units";
import { currentStreak, exportProgress, importProgress, progress, resetProgress, save } from "../state/progress";
import { confirmModal, h, toast } from "./dom";
import { navBar, topBar } from "./chrome";

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function download(name: string, text: string): void {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function renderProfile(root: HTMLElement, go: (hash: string) => void, rerender: () => void): () => void {
  const done = ALL_LESSONS.filter((l) => progress.lessons[l.id]).length;
  const stat = (icon: string, value: string, label: string) =>
    h("div", { class: "big-stat" }, h("span", {}, icon), h("div", {}, h("b", {}, value), h("small", {}, label)));

  const sw = h("button", { class: `switch ${progress.settings.sound ? "on" : ""}`, "aria-label": "Звук" });
  sw.onclick = () => {
    progress.settings.sound = !progress.settings.sound;
    sw.classList.toggle("on", progress.settings.sound);
    save();
  };

  const unknownText = progress.unknown.length
    ? progress.unknown.map((u) => `${u.at.slice(0, 16).replace("T", " ")}  [${u.kind === "notfound" ? "нет такой" : "не умею"}]  ${u.line}`).join("\n")
    : "Пусто. Вводи команды в терминале — всё, что тренажёр не понял, попадёт сюда.";

  const fileInput = h("input", { type: "file", accept: "application/json,.json", style: { display: "none" } });
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    if (importProgress(await f.text())) {
      toast("Прогресс загружен");
      rerender();
    } else toast("Не похоже на файл прогресса");
  };

  const scroll = h(
    "div",
    { class: "scroll" },
    h(
      "div",
      { class: "profile" },
      h(
        "div",
        { class: "grid2" },
        stat("⚡", String(progress.xp), "опыт"),
        stat("🔥", String(currentStreak()), "дней подряд"),
        stat("⭐", `${done}/${ALL_LESSONS.length}`, "уроков"),
        stat("🧠", String(Object.keys(progress.mistakes).length), "заданий на повтор"),
      ),
      h("div", { class: "card" }, h("div", { class: "toggle" }, h("span", {}, "🔊 Звуки"), sw)),
      h(
        "div",
        { class: "card" },
        h("h3", {}, "📓 Журнал неизвестных команд"),
        h("p", {}, "Команды, которых тренажёр пока не знает. Скопируй и пришли разработчику — добавим."),
        h("div", { class: "log" }, unknownText),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn blue small",
              onclick: async () => toast((await copy(unknownText)) ? "Скопировано" : "Не удалось скопировать"),
            },
            "Копировать",
          ),
          h(
            "button",
            {
              class: "btn ghost small",
              onclick: () => {
                progress.unknown = [];
                save();
                rerender();
              },
            },
            "Очистить",
          ),
        ),
      ),
      h(
        "div",
        { class: "card" },
        h("h3", {}, "💾 Прогресс"),
        h("p", {}, "Хранится только на этом телефоне. Сохрани файл, чтобы перенести на другое устройство."),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn blue small", onclick: () => download(`linux-trainer-${new Date().toISOString().slice(0, 10)}.json`, exportProgress()) }, "Экспорт"),
          h("button", { class: "btn ghost small", onclick: () => fileInput.click() }, "Импорт"),
        ),
        fileInput,
      ),
      h(
        "button",
        {
          class: "btn ghost small",
          style: { color: "var(--red)" },
          onclick: async () => {
            if (await confirmModal("Сбросить прогресс?", "XP, стрик и уроки обнулятся. Палыч сделает вид, что тебя не знает.", "Сбросить")) {
              resetProgress();
              rerender();
            }
          },
        },
        "Сбросить прогресс",
      ),
      h("p", { style: { textAlign: "center", color: "var(--muted)", fontSize: "12px", fontWeight: "700" } }, `linux-trainer ${__APP_VERSION__} · Палыч одобряет`),
    ),
  );
  root.append(h("div", { class: "screen" }, topBar(), scroll, navBar("profile", go)));
  return () => {};
}
