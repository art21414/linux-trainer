// Видимая область над экранной клавиатурой.
// Android Chrome с `interactive-widget=resizes-content` сам сжимает layout-viewport, но не все браузеры/режимы PWA это делают
// (iOS, старые Chrome, WebView: клавиатура только накрывает страницу). Поэтому высоту приложения берём из visualViewport:
// #app всегда ровно в видимой области, а строка ввода и панель кнопок терминала не оказываются под клавиатурой.
let started = false;

export function initViewport(): void {
  if (started) return;
  started = true;
  const root = document.documentElement;
  const vv = window.visualViewport;

  const apply = () => {
    const zoomed = !!vv && vv.scale > 1.01; // при щипке-зуме visualViewport сжимается — это не клавиатура
    const h = vv && !zoomed ? vv.height : window.innerHeight;
    root.style.setProperty("--app-h", `${Math.round(h)}px`);
    root.style.setProperty("--app-top", vv && !zoomed ? `${Math.round(vv.offsetTop)}px` : "0px");
    // страницу и #app никто не должен прокручивать: иначе фокус в поле ввода уводит шапку и панель за экран
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    const app = document.getElementById("app");
    if (app && (app.scrollTop || app.scrollLeft)) {
      app.scrollTop = 0;
      app.scrollLeft = 0;
    }
  };

  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", () => setTimeout(apply, 250));
  window.addEventListener("scroll", apply, { passive: true });
  // клавиатура выезжает с анимацией: добираем итоговые размеры после фокуса/потери фокуса
  document.addEventListener("focusin", () => [0, 150, 350, 700].forEach((t) => setTimeout(apply, t)));
  document.addEventListener("focusout", () => [0, 150, 350].forEach((t) => setTimeout(apply, t)));
  apply();
}
