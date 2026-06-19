import { describe, it, expect } from 'vitest';
import {
  getQuestions,
  gradeAnswer,
  isLessonSubject,
  LESSON_SUBJECTS,
  DIFFICULTIES,
} from '../../../../apps/api/src/lib/learn-questions.js';

// FHS-283 — the lesson question bank: questions never leak their answer, and
// grading is correct.

describe('FHS-283 — learn question bank', () => {
  it('every lesson subject has questions at every difficulty', () => {
    for (const subject of LESSON_SUBJECTS) {
      for (const d of DIFFICULTIES) {
        expect(getQuestions(subject, d).length).toBeGreaterThan(0);
      }
    }
  });

  it('public questions never include the answer index', () => {
    const qs = getQuestions('Maths', 'easy');
    for (const q of qs) {
      expect(q).not.toHaveProperty('answerIndex');
      expect(q.choices.length).toBeGreaterThan(1);
    }
  });

  it('grades the correct choice as correct and a wrong choice as wrong', () => {
    const q = getQuestions('Maths', 'easy')[0]!;
    const graded = gradeAnswer('Maths', q.id, 0);
    expect(graded).not.toBeNull();
    // Try every choice; exactly one is correct and matches answerIndex.
    const correctIndexes = q.choices
      .map((_, i) => gradeAnswer('Maths', q.id, i)!)
      .filter((g) => g.correct);
    expect(correctIndexes).toHaveLength(1);
    expect(correctIndexes[0]!.answerIndex).toBe(graded!.answerIndex);
  });

  it('returns null for an unknown question', () => {
    expect(gradeAnswer('Maths', 'does-not-exist', 0)).toBeNull();
  });

  it('isLessonSubject accepts lesson subjects and rejects others', () => {
    expect(isLessonSubject('Maths')).toBe(true);
    expect(isLessonSubject('World Flags')).toBe(false);
    expect(isLessonSubject('Nonsense')).toBe(false);
  });
});
