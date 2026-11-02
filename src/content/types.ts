import type { World } from "../engine/world";
import type { Shell } from "../engine/shell";

export interface CheckCtx {
  world: World;
  shell: Shell;
}

/** true — выполнено; false — нет; строка — «почти»: подсказка, что не так (показывается Палычем). */
export type CheckResult = boolean | string;

interface ExBase {
  /** Уникальный глобально, стабильный (на нём прогресс и повторение). Формат: `<тема>-<набор>-<N>`, напр. `perm-1-03`. */
  id: string;
  /** Якорь подтемы из theory.md темы (`## Название {#anchor}`): кнопка «Теория» открывает её. */
  theory?: string;
}

/** Задание в терминале. Проверяется по итоговому состоянию мира, а не по тексту команды. */
export interface TerminalEx extends ExBase {
  type: "terminal";
  prompt: string;
  user?: string;
  cwd?: string;
  setup?: (w: World) => Promise<void>;
  check: (c: CheckCtx) => Promise<CheckResult>;
  hint: string;
  /** Рабочее решение: строки через \n выполняются по очереди. Тест его прогоняет. */
  solution: string;
  /** Альтернативные верные решения (по 1–3). Тест: после каждого check === true. */
  accept?: string[];
  /** Неверные решения. Тест: после каждого check !== true. */
  reject?: string[];
  /** Короткий разбор после выполнения: почему так и какая ловушка. */
  explain?: string;
}

/** Выбор одного ответа — только неочевидное. kind: предскажи вывод / найди ошибку / тонкий выбор. */
export interface ChoiceEx extends ExBase {
  type: "choice";
  kind: "predict" | "bug" | "choice";
  prompt: string;
  code?: string;
  options: string[];
  answer: number;
  explain: string;
}

export type Exercise = TerminalEx | ChoiceEx;

export interface PracticeSet {
  /** Уникальный в пределах темы, напр. "1", "2". Для зачёта — "exam". */
  id: string;
  title: string;
  exercises: Exercise[];
}

export interface Topic {
  /** Глобально уникальный короткий id, напр. "perm". Используется в прогрессе. */
  id: string;
  /** Порядковый номер темы в курсе. */
  n: number;
  title: string;
  /** Одна строка: о чём тема. */
  summary: string;
  level: "base" | "mid";
  /** Сырой markdown (import ... from "./theory.md?raw"). */
  theory: string;
  /** Наборы практики по 5–8 заданий. */
  sets: PracticeSet[];
  /** Зачёт: 4–6 показательных заданий. */
  exam: PracticeSet;
}

export interface Section {
  id: string;
  title: string;
  topics: Topic[];
}
