// Повторение: задания, где ошибся. Темы, закрытые зачётом, в повторение не попадают (product.md).
import { findExercise } from "../content/topics";
import type { Exercise } from "../content/types";
import { mistakesDue, progress } from "./progress";

export interface ReviewItem {
  topicId: string;
  ex: Exercise;
}

export const REVIEW_MAX = 8;

function due(): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const m of mistakesDue()) {
    if (progress.exams[m.topicId]) continue;
    const f = findExercise(m.exId);
    if (f && f.topic.id === m.topicId) out.push({ topicId: m.topicId, ex: f.ex });
  }
  return out;
}

export const reviewCount = (): number => due().length;

/** До 8 самых старых ошибок. */
export const reviewQueue = (max = REVIEW_MAX): ReviewItem[] => due().slice(0, max);
