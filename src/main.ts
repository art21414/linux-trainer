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
import { reviewQueue } from "./state/review";
import { renderHome } from "./ui/home";
import { renderTopic } from "./ui/topic";
import { renderReader } from "./ui/reader";
import { renderLesson } from "./ui/lesson";
import type { LessonOutcome } from "./ui/lesson";
import { renderFinish } from "./ui/finish";
import { renderSandbox } from "./ui/sandbox";
import { renderProfile } from "./ui/profile";
import { back, go, onRoute } from "./ui/nav";
import { sheetOpen } from "./ui/sheet";
import { initViewport } from "./ui/viewport";

initViewport();
const app = document.getElementById("app")!;
let cleanup: () => void = () => {};

function mount(render: (root: HTMLElement) => () => void): void {
  cleanup();
  app.innerHTML = "";
  cleanup = render(app);
}

function showFinish(o: LessonOutcome): void {
  // финиш — не отдельный адрес: «назад» с него ведёт на главную
  history.replaceState({ i: history.state?.i ?? 0 }, "", "#/");
  mount((root) => renderFinish(root, o, go));
}

function route(): void {
  const hash = location.hash || "#/";
  const topicMatch = /^#\/topic\/([\w-]+)$/.exec(hash);
  if (topicMatch) return mount((root) => renderTopic(root, topicMatch[1], go, () => back("#/")));
  const theoryMatch = /^#\/theory\/([\w-]+)(?:\/([\w-]+))?$/.exec(hash);
  if (theoryMatch) return mount((root) => renderReader(root, theoryMatch[1], theoryMatch[2], go, () => back(`#/topic/${theoryMatch[1]}`)));
  const setMatch = /^#\/set\/([\w-]+)\/([\w-]+)$/.exec(hash);
  if (setMatch) {
    const topic = topicById(setMatch[1]);
    const set = topic && setOf(topic, setMatch[2]);
    if (topic && set) {
      const kind = setMatch[2] === "exam" ? "exam" : "set";
      const spec = { kind, topicId: topic.id, setId: set.id, title: set.title, items: set.exercises.map((ex) => ({ topicId: topic.id, ex })) } as const;
      return mount((root) => renderLesson(root, spec, showFinish, () => back(`#/topic/${topic.id}`)));
    }
  }
  if (hash === "#/review") {
    const items = reviewQueue();
    if (items.length) return mount((root) => renderLesson(root, { kind: "review", topicId: null, setId: "review", title: "Повторение", items }, showFinish, () => back("#/")));
    history.replaceState({ i: history.state?.i ?? 0 }, "", "#/");
  }
  if (hash === "#/sandbox") return mount((root) => renderSandbox(root, go));
  if (hash === "#/profile") return mount((root) => renderProfile(root, go, route));
  mount((root) => renderHome(root, go));
}

onRoute(route);
// popstate срабатывает и на «назад», и на смену хэша; пока открыт лист теории, «назад» закрывает только его
window.addEventListener("popstate", () => {
  if (!sheetOpen()) route();
});
route();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
