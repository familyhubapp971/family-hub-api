import { describe, it, expect } from 'vitest';
import {
  getQuestions,
  gradeAnswer,
  isLessonSubject,
  LESSON_SUBJECTS,
  DIFFICULTIES,
  LOGIC_SUBTOPICS,
} from '../../../../apps/api/src/lib/learn-questions.js';

// FHS-283: the lesson question bank: questions never leak their answer, and
// grading is correct.
// FHS-371: Logic sub-topics: all four present, filterable by subtopic.

describe('FHS-283: learn question bank', () => {
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

describe('FHS-371: Logic sub-topics', () => {
  const SUBTOPIC_SLUGS = LOGIC_SUBTOPICS.map((s) => s.slug);

  it('LOGIC_SUBTOPICS exports all four slugs', () => {
    expect(SUBTOPIC_SLUGS).toEqual(
      expect.arrayContaining(['patterns', 'odd-one-out', 'if-then', 'sorting']),
    );
    expect(SUBTOPIC_SLUGS).toHaveLength(4);
  });

  it('every (subtopic × difficulty) pair has at least 2 Logic questions', () => {
    for (const subtopic of SUBTOPIC_SLUGS) {
      for (const difficulty of DIFFICULTIES) {
        const qs = getQuestions('Logic', difficulty, subtopic as never);
        expect(qs.length, `Logic/${difficulty}/${subtopic}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("getQuestions with subtopic returns only that sub-topic's questions", () => {
    const qs = getQuestions('Logic', 'easy', 'patterns');
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      expect(q.subtopic).toBe('patterns');
    }
  });

  it('getQuestions without subtopic returns all Logic questions for that difficulty', () => {
    const all = getQuestions('Logic', 'easy');
    const perSubtopic = SUBTOPIC_SLUGS.flatMap((st) => getQuestions('Logic', 'easy', st as never));
    // All questions returned without filter should equal the union of all subtopic filters
    expect(all).toHaveLength(perSubtopic.length);
  });

  it('non-Logic subjects ignore the subtopic argument', () => {
    const withoutSubtopic = getQuestions('Maths', 'easy');
    const withSubtopic = getQuestions('Maths', 'easy', 'patterns' as never);
    expect(withSubtopic).toEqual(withoutSubtopic);
  });

  it('subtopic is present on Logic public questions', () => {
    const qs = getQuestions('Logic', 'medium');
    for (const q of qs) {
      expect(q).toHaveProperty('subtopic');
      expect(SUBTOPIC_SLUGS).toContain(q.subtopic);
    }
  });

  it('gradeAnswer still finds any Logic question by id regardless of subtopic', () => {
    for (const difficulty of DIFFICULTIES) {
      const qs = getQuestions('Logic', difficulty);
      for (const q of qs) {
        const result = gradeAnswer('Logic', q.id, 0);
        expect(result, `gradeAnswer('Logic', '${q.id}', 0)`).not.toBeNull();
      }
    }
  });
});
