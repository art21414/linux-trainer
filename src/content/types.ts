import type { World } from "../engine/world";
import type { Shell } from "../engine/shell";

/** Карточка теории. В body: **жирный**, `код`, пустая строка — новый абзац. */
export interface TheoryEx {
  type: "theory";
  title: string;
  body: string;
  code?: string;
}

/** Выбор одного ответа. kind меняет заголовок: обычный вопрос / предскажи вывод / найди ошибку. */
export interface ChoiceEx {
  type: "choice";
  kind?: "choice" | "predict" | "bug";
  prompt: string;
  code?: string;
  options: string[];
  answer: number;
  explain?: string;
}

/** Заполни пропуск: в template место пропуска — ___ */
export interface FillEx {
  type: "fill";
  prompt: string;
  template: string;
  options: string[];
  answer: number;
  explain?: string;
}

/** Собери команду из плиток. answer — правильный порядок, extra — лишние плитки. */
export interface TilesEx {
  type: "tiles";
  prompt: string;
  answer: string[];
  extra: string[];
  /** Другие верные варианты (последовательности плиток). */
  accept?: string[][];
  explain?: string;
}

export interface CheckCtx {
  world: World;
  shell: Shell;
}

/** true — выполнено; строка — «почти»: подсказка, что не так (показывается Палычем). */
export type CheckResult = boolean | string;

/** Задание в терминале. Проверяется по итоговому состоянию мира, а не по тексту команды. */
export interface TerminalEx {
  type: "terminal";
  prompt: string;
  user?: string;
  cwd?: string;
  setup?: (w: World) => Promise<void>;
  check: (c: CheckCtx) => Promise<CheckResult>;
  hint: string;
  solution: string;
}

export type Exercise = TheoryEx | ChoiceEx | FillEx | TilesEx | TerminalEx;

export interface Lesson {
  id: string;
  title: string;
  icon: string;
  exercises: Exercise[];
}

export interface Unit {
  id: string;
  title: string;
  subtitle: string;
  color: string;
  shade: string;
  lessons: Lesson[];
}
