// Нижний лист поверх экрана. Закрывается кнопкой, тапом по фону, свайпом вниз и системной кнопкой «Назад».
// Содержимое экрана под листом не пересоздаётся (терминал и задание сохраняются).
import { h } from "./dom";
import { icon } from "./icons";

let opened = false;

/** Роутер игнорирует popstate, пока лист открыт: «назад» закрывает лист, а не уходит с экрана. */
export const sheetOpen = (): boolean => opened;

export interface SheetHandle {
  /** Закрыть (через history.back, чтобы не оставлять лишнюю запись). */
  close(): void;
  /** Убрать без обращения к истории — при уничтожении экрана. */
  destroy(): void;
}

export function openSheet(host: HTMLElement, title: string, content: Node, onClosed?: () => void): SheetHandle {
  if (opened) throw new Error("sheet already open");
  opened = true;
  const closeBtn = h("button", { class: "bsheet__close", "aria-label": "Закрыть" }, icon("close", { size: 20 }));
  const head = h("div", { class: "bsheet__head" }, h("span", { class: "bsheet__grab", "aria-hidden": "true" }), h("h3", { class: "bsheet__title" }, title), closeBtn);
  const body = h("div", { class: "bsheet__body" }, content);
  const panel = h("div", { class: "bsheet__panel", role: "dialog", "aria-label": title }, head, body);
  const bg = h("div", { class: "bsheet" }, h("div", { class: "bsheet__scrim" }), panel);
  host.append(bg);
  requestAnimationFrame(() => bg.classList.add("bsheet--open"));

  let done = false;
  const teardown = () => {
    if (done) return;
    done = true;
    opened = false;
    window.removeEventListener("popstate", onPop);
    window.removeEventListener("keydown", onKey);
    bg.remove();
  };
  const onPop = () => {
    teardown();
    onClosed?.();
  };
  const close = () => {
    if (done) return;
    // history.back() вызовет popstate -> onPop
    history.back();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();

  history.pushState({ i: (history.state?.i ?? 0) + 1, sheet: 1 }, "");
  window.addEventListener("popstate", onPop);
  window.addEventListener("keydown", onKey);
  closeBtn.onclick = close;
  bg.querySelector(".bsheet__scrim")!.addEventListener("click", close);

  // свайп вниз за шапку
  let y0 = 0;
  let dy = 0;
  let drag = false;
  head.addEventListener("touchstart", (e) => {
    y0 = e.touches[0].clientY;
    dy = 0;
    drag = true;
    panel.style.transition = "none";
  }, { passive: true });
  head.addEventListener("touchmove", (e) => {
    if (!drag) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  const end = () => {
    if (!drag) return;
    drag = false;
    panel.style.transition = "";
    panel.style.transform = "";
    if (dy > 90) close();
  };
  head.addEventListener("touchend", end);
  head.addEventListener("touchcancel", end);

  return {
    close,
    destroy: () => {
      const had = !done;
      teardown();
      if (had && history.state?.sheet) history.replaceState({ i: Math.max(0, (history.state.i ?? 1) - 1) }, "");
    },
  };
}
