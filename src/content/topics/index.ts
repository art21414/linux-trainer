// Реестр тем. Порядок разделов и тем — порядок отображения.
import type { Exercise, PracticeSet, Section, Topic } from "../types";
import { permissions } from "./02-permissions";

// Каждая тема добавляет себя в свой раздел. Пустые разделы на экране не показываются.
export const SECTIONS: Section[] = [
  { id: "files", title: "Файлы и доступ", topics: [permissions] },
  { id: "search", title: "Поиск и потоки", topics: [] },
  { id: "disks", title: "Диски и файловые системы", topics: [] },
  { id: "procs", title: "Процессы", topics: [] },
  { id: "bash", title: "Bash", topics: [] },
].filter((s) => s.topics.length > 0);

export const ALL_TOPICS: Topic[] = SECTIONS.flatMap((s) => s.topics);

export const topicById = (id: string): Topic | undefined => ALL_TOPICS.find((t) => t.id === id);

/** Все наборы темы, зачёт — последним. */
export const allSets = (t: Topic): PracticeSet[] => [...t.sets, t.exam];

export const setOf = (t: Topic, setId: string): PracticeSet | undefined => allSets(t).find((s) => s.id === setId);

export function allExercises(t: Topic): Exercise[] {
  return allSets(t).flatMap((s) => s.exercises);
}

/** Найти задание по глобальному id: тема, набор, само задание. */
export function findExercise(id: string): { topic: Topic; set: PracticeSet; ex: Exercise } | undefined {
  for (const topic of ALL_TOPICS)
    for (const set of allSets(topic)) {
      const ex = set.exercises.find((e) => e.id === id);
      if (ex) return { topic, set, ex };
    }
  return undefined;
}
