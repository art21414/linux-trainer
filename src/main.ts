import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/nunito/900.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/cyrillic-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/cyrillic-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/cyrillic-400.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "@fontsource/ibm-plex-mono/cyrillic-600.css";
import "@fontsource/pixelify-sans/latin-600.css";
import "@fontsource/pixelify-sans/cyrillic-600.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/mascot.css";
import { topicById, setOf } from "./content/topics";
import { renderHome } from "./ui/home";
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
  const setMatch = /^#\/set\/([\w-]+)\/([\w-]+)$/.exec(hash);
  if (setMatch) {
    const topic = topicById(setMatch[1]);
    const set = topic && setOf(topic, setMatch[2]);
    if (topic && set) {
      mount((root) => renderLesson(root, topic.id, set, showFinish, () => go("#/")));
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
