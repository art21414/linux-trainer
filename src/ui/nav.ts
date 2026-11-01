// Навигация по хэшу с собственным счётчиком глубины (history.state.i):
// «назад» из экрана возвращает на предыдущий, а при заходе по прямой ссылке — на родителя.
let route: () => void = () => {};

export function onRoute(fn: () => void): void {
  route = fn;
}

const depth = (): number => (history.state && typeof history.state.i === "number" ? history.state.i : 0);

const norm = (hash: string): string => (hash === "" ? "#/" : hash);

export function go(hash: string): void {
  if (norm(location.hash) === hash) return route();
  history.pushState({ i: depth() + 1 }, "", hash);
  route();
}

/** Заменить текущую запись истории (без нового шага «назад»). */
export function replace(hash: string, rerender = true): void {
  history.replaceState({ i: depth() }, "", hash);
  if (rerender) route();
}

export function back(fallback: string): void {
  if (depth() > 0) history.back();
  else replace(fallback);
}
