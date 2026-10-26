import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/nunito/900.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/app.css";
import "./styles/mascot.css";
import { ALL_LESSONS } from "./content/units";
import { renderHome, isUnlocked } from "./ui/home";
import { renderLesson } from "./ui/lesson";
import type { LessonOutcome } from "./ui/lesson";
import { renderFinish } from "./ui/finish";
import { renderSandbox } from "./ui/sandbox";
import { renderProfile } from "./ui/profile";

const app = document.getElementById("app")!;
let cleanup: () => void = () => {};

function mount(render: (root: HTMLElement) => () => void): void {
  cleanup();
  app.innerHTML = "";
  cleanup = render(app);
}

function go(hash: string): void {
  if (location.hash === hash || (hash === "#/" && !location.hash)) route();
  else location.hash = hash;
}

function showFinish(o: LessonOutcome): void {
  // финиш — не отдельный адрес: «назад» с него ведёт домой
  history.replaceState(null, "", "#/");
  mount((root) => renderFinish(root, o, () => route()));
}

function route(): void {
  const hash = location.hash || "#/";
  const lessonMatch = /^#\/lesson\/(\w+)$/.exec(hash);
  if (lessonMatch) {
    const lesson = ALL_LESSONS.find((l) => l.id === lessonMatch[1]);
    if (lesson && isUnlocked(lesson.id)) {
      mount((root) => renderLesson(root, lesson, showFinish, () => go("#/")));
      return;
    }
  }
  if (hash === "#/sandbox") return mount((root) => renderSandbox(root, go));
  if (hash === "#/profile") return mount((root) => renderProfile(root, go, route));
  mount((root) => renderHome(root, go));
}

window.addEventListener("hashchange", route);
route();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
