// FHS-283 — the Learn lesson question bank.
//
// Server-side so grading is authoritative: the GET endpoint sends questions
// WITHOUT the answer, and the POST endpoint grades a chosen index against this
// bank. Subjects with an interactive lesson are Maths / Science / Logic — World
// Flags keeps its own dedicated experience (FHS-284 / earlier).

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

/**
 * Correct answers needed for a subject's progress to hit 100% + a certificate.
 * MVP note: repeats count — re-answering the same question correctly still
 * advances progress (the bank is small, so this is deliberate "practice makes
 * the certificate"). Swap to first-correct-per-question dedup once the bank is
 * big enough to require distinct answers.
 */
export const CERTIFICATE_TARGET = 10;

/** Subjects that have an interactive lesson (others drill into their own view). */
export const LESSON_SUBJECTS = ['Maths', 'Science', 'Logic'] as const;
export type LessonSubject = (typeof LESSON_SUBJECTS)[number];

// FHS-371 — Logic sub-topics.
export const LOGIC_SUBTOPICS = [
  { slug: 'patterns', label: 'Patterns' },
  { slug: 'odd-one-out', label: 'Odd One Out' },
  { slug: 'if-then', label: 'If…Then' },
  { slug: 'sorting', label: 'Sorting' },
] as const;

export type LogicSubtopic = (typeof LOGIC_SUBTOPICS)[number]['slug'];

interface Question {
  id: string;
  prompt: string;
  choices: string[];
  answerIndex: number;
  subtopic?: LogicSubtopic;
}
export interface PublicQuestion {
  id: string;
  prompt: string;
  choices: string[];
  subtopic?: LogicSubtopic;
}

type Bank = Record<LessonSubject, Record<Difficulty, Question[]>>;

const BANK: Bank = {
  Maths: {
    easy: [
      { id: 'maths-e1', prompt: '2 + 3 = ?', choices: ['4', '5', '6', '7'], answerIndex: 1 },
      { id: 'maths-e2', prompt: '7 - 4 = ?', choices: ['2', '3', '4', '5'], answerIndex: 1 },
      { id: 'maths-e3', prompt: '6 + 1 = ?', choices: ['5', '6', '7', '8'], answerIndex: 2 },
    ],
    medium: [
      { id: 'maths-m1', prompt: '4 × 3 = ?', choices: ['7', '12', '14', '9'], answerIndex: 1 },
      { id: 'maths-m2', prompt: '15 - 8 = ?', choices: ['6', '7', '8', '9'], answerIndex: 1 },
      { id: 'maths-m3', prompt: '12 ÷ 4 = ?', choices: ['2', '3', '4', '6'], answerIndex: 1 },
    ],
    hard: [
      { id: 'maths-h1', prompt: '9 × 7 = ?', choices: ['56', '63', '72', '64'], answerIndex: 1 },
      { id: 'maths-h2', prompt: '48 ÷ 6 = ?', choices: ['6', '7', '8', '9'], answerIndex: 2 },
      { id: 'maths-h3', prompt: '13 × 4 = ?', choices: ['52', '48', '56', '44'], answerIndex: 0 },
    ],
  },
  Science: {
    easy: [
      {
        id: 'sci-e1',
        prompt: 'True or false: the Sun is a star.',
        choices: ['True', 'False'],
        answerIndex: 0,
      },
      {
        id: 'sci-e2',
        prompt: 'Which one is a mammal?',
        choices: ['Shark', 'Dog', 'Frog', 'Eagle'],
        answerIndex: 1,
      },
      {
        id: 'sci-e3',
        prompt: 'What do plants need to grow?',
        choices: ['Sunlight', 'Darkness', 'Plastic', 'Noise'],
        answerIndex: 0,
      },
    ],
    medium: [
      {
        id: 'sci-m1',
        prompt: 'Water turns to ice when it gets…',
        choices: ['Hotter', 'Colder', 'Louder', 'Brighter'],
        answerIndex: 1,
      },
      {
        id: 'sci-m2',
        prompt: 'Which is NOT a planet?',
        choices: ['Mars', 'Venus', 'Moon', 'Jupiter'],
        answerIndex: 2,
      },
      {
        id: 'sci-m3',
        prompt: 'Classify: which lives in water?',
        choices: ['Fish', 'Lion', 'Camel', 'Owl'],
        answerIndex: 0,
      },
    ],
    hard: [
      {
        id: 'sci-h1',
        prompt: 'What gas do we breathe in to live?',
        choices: ['Oxygen', 'Helium', 'Neon', 'Hydrogen'],
        answerIndex: 0,
      },
      {
        id: 'sci-h2',
        prompt: 'True or false: sound travels faster than light.',
        choices: ['True', 'False'],
        answerIndex: 1,
      },
      {
        id: 'sci-h3',
        prompt: 'Which is a reptile?',
        choices: ['Crocodile', 'Whale', 'Bat', 'Penguin'],
        answerIndex: 0,
      },
    ],
  },
  Logic: {
    // ── easy ────────────────────────────────────────────────────────────────
    easy: [
      // patterns (≥2)
      {
        id: 'log-pat-e1',
        prompt: 'Next in the pattern: 2, 4, 6, …?',
        choices: ['7', '8', '9', '10'],
        answerIndex: 1,
        subtopic: 'patterns',
      },
      {
        id: 'log-pat-e2',
        prompt: 'Which shape comes next: ▲ ● ▲ ● …?',
        choices: ['▲', '●', '■', '★'],
        answerIndex: 0,
        subtopic: 'patterns',
      },
      // odd-one-out (≥2)
      {
        id: 'log-odd-e1',
        prompt: 'Which one does NOT belong: Cat, Dog, Fish, Car?',
        choices: ['Cat', 'Dog', 'Fish', 'Car'],
        answerIndex: 3,
        subtopic: 'odd-one-out',
      },
      {
        id: 'log-odd-e2',
        prompt: 'Odd one out: Red, Blue, Green, Happy?',
        choices: ['Red', 'Blue', 'Green', 'Happy'],
        answerIndex: 3,
        subtopic: 'odd-one-out',
      },
      // if-then (≥2)
      {
        id: 'log-if-e1',
        prompt: 'If it is raining, you take an…',
        choices: ['Umbrella', 'Ice cream', 'Kite', 'Pillow'],
        answerIndex: 0,
        subtopic: 'if-then',
      },
      {
        id: 'log-if-e2',
        prompt: 'If the light is red, a car should…',
        choices: ['Speed up', 'Stop', 'Honk', 'Turn'],
        answerIndex: 1,
        subtopic: 'if-then',
      },
      // sorting (≥2)
      {
        id: 'log-sort-e1',
        prompt: 'Which is the smallest: elephant, mouse, dog, horse?',
        choices: ['Elephant', 'Mouse', 'Dog', 'Horse'],
        answerIndex: 1,
        subtopic: 'sorting',
      },
      {
        id: 'log-sort-e2',
        prompt: 'Put in order smallest to biggest: 5, 1, 3. What comes first?',
        choices: ['5', '3', '1', 'They are the same'],
        answerIndex: 2,
        subtopic: 'sorting',
      },
    ],
    // ── medium ──────────────────────────────────────────────────────────────
    medium: [
      // patterns (≥2)
      {
        id: 'log-pat-m1',
        prompt: 'Next number: 5, 10, 15, …?',
        choices: ['16', '18', '20', '25'],
        answerIndex: 2,
        subtopic: 'patterns',
      },
      {
        id: 'log-pat-m2',
        prompt: 'What comes next: A, C, E, …?',
        choices: ['F', 'G', 'H', 'I'],
        answerIndex: 1,
        subtopic: 'patterns',
      },
      // odd-one-out (≥2)
      {
        id: 'log-odd-m1',
        prompt: 'Odd one out: Apple, Banana, Carrot, Cherry?',
        choices: ['Apple', 'Banana', 'Carrot', 'Cherry'],
        answerIndex: 2,
        subtopic: 'odd-one-out',
      },
      {
        id: 'log-odd-m2',
        prompt: 'Which does NOT belong: Piano, Guitar, Trumpet, Paintbrush?',
        choices: ['Piano', 'Guitar', 'Trumpet', 'Paintbrush'],
        answerIndex: 3,
        subtopic: 'odd-one-out',
      },
      // if-then (≥2)
      {
        id: 'log-if-m1',
        prompt: 'If all cats purr and Tom is a cat, then Tom…',
        choices: ['Barks', 'Purrs', 'Flies', 'Swims'],
        answerIndex: 1,
        subtopic: 'if-then',
      },
      {
        id: 'log-if-m2',
        prompt: 'If it is night time, the sky is…',
        choices: ['Sunny', 'Rainy', 'Dark', 'Cloudy'],
        answerIndex: 2,
        subtopic: 'if-then',
      },
      // sorting (≥2)
      {
        id: 'log-sort-m1',
        prompt: 'Which group has the most items: 3 apples, 5 oranges, 2 bananas?',
        choices: ['Apples', 'Oranges', 'Bananas', 'They are equal'],
        answerIndex: 1,
        subtopic: 'sorting',
      },
      {
        id: 'log-sort-m2',
        prompt: 'Order by age (youngest first): Baby, Toddler, Adult, Teen. Who is first?',
        choices: ['Adult', 'Teen', 'Toddler', 'Baby'],
        answerIndex: 3,
        subtopic: 'sorting',
      },
    ],
    // ── hard ────────────────────────────────────────────────────────────────
    hard: [
      // patterns (≥2)
      {
        id: 'log-pat-h1',
        prompt: 'Next: 1, 2, 4, 8, …?',
        choices: ['10', '12', '16', '20'],
        answerIndex: 2,
        subtopic: 'patterns',
      },
      {
        id: 'log-pat-h2',
        prompt: 'Complete: 3, 6, 9, 12, …?',
        choices: ['13', '14', '15', '18'],
        answerIndex: 2,
        subtopic: 'patterns',
      },
      // odd-one-out (≥2)
      {
        id: 'log-odd-h1',
        prompt: 'Odd one out: Mercury, Venus, Earth, Moon?',
        choices: ['Mercury', 'Venus', 'Earth', 'Moon'],
        answerIndex: 3,
        subtopic: 'odd-one-out',
      },
      {
        id: 'log-odd-h2',
        prompt: 'Which does NOT belong: Addition, Subtraction, Grammar, Multiplication?',
        choices: ['Addition', 'Subtraction', 'Grammar', 'Multiplication'],
        answerIndex: 2,
        subtopic: 'odd-one-out',
      },
      // if-then (≥2)
      {
        id: 'log-if-h1',
        prompt: 'If A>B and B>C, then…',
        choices: ['A>C', 'C>A', 'A=C', 'B>A'],
        answerIndex: 0,
        subtopic: 'if-then',
      },
      {
        id: 'log-if-h2',
        prompt: 'If every square is a rectangle, is every rectangle a square?',
        choices: ['Yes', 'No', 'Sometimes', 'Always'],
        answerIndex: 1,
        subtopic: 'if-then',
      },
      // sorting (≥2)
      {
        id: 'log-sort-h1',
        prompt: 'Sort these fractions smallest to largest: 1/4, 1/2, 1/8. Which is smallest?',
        choices: ['1/4', '1/2', '1/8', 'They are equal'],
        answerIndex: 2,
        subtopic: 'sorting',
      },
      {
        id: 'log-sort-h2',
        prompt: 'A red ball is heavier than blue, blue is heavier than green. Which is lightest?',
        choices: ['Red', 'Blue', 'Green', 'They weigh the same'],
        answerIndex: 2,
        subtopic: 'sorting',
      },
    ],
  },
};

export function isLessonSubject(subject: string): subject is LessonSubject {
  return (LESSON_SUBJECTS as readonly string[]).includes(subject);
}

/** Public questions for a subject + difficulty (answer stripped).
 *  For Logic, an optional subtopic filters to that sub-topic only.
 *  Non-Logic subjects ignore the subtopic argument. */
export function getQuestions(
  subject: LessonSubject,
  difficulty: Difficulty,
  subtopic?: LogicSubtopic,
): PublicQuestion[] {
  const all = BANK[subject][difficulty];
  const filtered =
    subject === 'Logic' && subtopic !== undefined
      ? all.filter((q) => q.subtopic === subtopic)
      : all;
  return filtered.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    choices: q.choices,
    ...(q.subtopic !== undefined ? { subtopic: q.subtopic } : {}),
  }));
}

/** Grade a chosen index for a question. Returns null if the question is unknown. */
export function gradeAnswer(
  subject: LessonSubject,
  questionId: string,
  choiceIndex: number,
): { correct: boolean; answerIndex: number } | null {
  for (const difficulty of DIFFICULTIES) {
    const q = BANK[subject][difficulty].find((x) => x.id === questionId);
    if (q) return { correct: q.answerIndex === choiceIndex, answerIndex: q.answerIndex };
  }
  return null;
}
