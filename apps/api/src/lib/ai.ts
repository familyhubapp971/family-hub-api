// FHS-389: AI-generated Maths lessons via Anthropic Claude Haiku.
//
// Feature-flagged: aiEnabled() must return true before any Anthropic call
// is made. When the flag is off the helpers return null / disabled responses
// without touching the network: safe for local dev with no key.
//
// No child PII is ever sent to Anthropic. Prompts contain only the chosen
// maths operation, difficulty/table settings, and kid-safe pedagogy.

import { z } from 'zod';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('ai');

// ─── Feature flag ────────────────────────────────────────────────────────────

/** True only when LEARN_AI_ENABLED=true AND ANTHROPIC_API_KEY is set. */
export function aiEnabled(): boolean {
  return config.LEARN_AI_ENABLED && config.ANTHROPIC_API_KEY !== '';
}

// ─── Lesson shape (Zod-validated before it leaves the server) ─────────────

export const lessonPracticeSchema = z.object({
  emoji: z.string().min(1),
  groups: z.number().int().nonnegative(),
  perGroup: z.number().int().nonnegative(),
  question: z.string().min(1),
  answer: z.number().int().nonnegative(),
  choices: z.array(z.number().int().nonnegative()).length(4),
});

export const lessonSchema = z.object({
  concept: z.string().min(1),
  visual: z.object({
    description: z.string().min(1),
    emoji: z.string().min(1),
    groups: z.number().int().nonnegative(),
    perGroup: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    equation: z.string().min(1),
  }),
  stickyPhrase: z.string().min(1),
  gapCheck: z.string().min(1),
  practice: z.array(lessonPracticeSchema).length(3),
});

export type MathLesson = z.infer<typeof lessonSchema>;
export type MathLessonPractice = z.infer<typeof lessonPracticeSchema>;

// ─── Prompt helpers (ported faithfully from the legacy backend/routes/ai.ts) ──

const DIFFICULTY_RANGES: Record<string, string> = {
  easy: 'numbers between 1 and 5',
  medium: 'numbers between 3 and 10',
  hard: 'numbers between 5 and 20',
};

const DIFFICULTY_PEDAGOGY: Record<string, string> = {
  easy: `\n\nDIFFICULTY: EASY
- Use the simplest, most concrete examples (fingers, toys, sweets)
- One-step thinking only: no chaining of ideas
- Numbers 1-5: keep totals small enough to count on one hand
- Use "imagine you have..." and "now count..." framing
- Celebrate every small step ("you did it!")
- Use very short sentences: no more than 8 words each`,

  medium: `\n\nDIFFICULTY: MEDIUM
- Build on what the child already knows: reference familiar concepts
- Introduce one new twist per lesson (e.g. carrying, bigger groups)
- Numbers up to 10: use two-hand counting and grouping
- Use "remember when..." to connect new concepts to easy-level knowledge
- Encourage pattern-spotting: "notice how..."
- Slightly longer explanations are okay: up to 12 words per sentence`,

  hard: `\n\nDIFFICULTY: HARD
- Challenge with multi-step reasoning
- Use real-world scenarios (sharing pizza slices, arranging party bags, setting up rows of chairs)
- Numbers up to 20: encourage mental strategies like "break it into parts"
- Use "what if..." questions to stretch thinking
- Praise effort and strategy, not just the answer
- Introduce the idea of checking your work: "let's count again to be sure"`,
};

function getTableRange(operation: string, tableNumber: number): string {
  switch (operation) {
    case 'addition':
      return `adding ${tableNumber} to numbers 1 through 12 (e.g. 3 + ${tableNumber} = ${3 + tableNumber})`;
    case 'subtraction':
      return `subtracting ${tableNumber} from numbers (e.g. ${7 + tableNumber} - ${tableNumber} = 7)`;
    case 'multiplication':
      return `the ${tableNumber} times table (e.g. ${tableNumber} × 4 = ${tableNumber * 4})`;
    case 'division':
      return `dividing by ${tableNumber} (e.g. ${tableNumber * 6} ÷ ${tableNumber} = 6)`;
    default:
      return `numbers involving ${tableNumber}`;
  }
}

function getTablePedagogy(operation: string, tableNumber: number): string {
  const opLabel =
    operation === 'addition'
      ? `adding ${tableNumber}`
      : operation === 'subtraction'
        ? `subtracting ${tableNumber}`
        : operation === 'multiplication'
          ? `the ${tableNumber} times table`
          : `dividing by ${tableNumber}`;

  if (tableNumber <= 3) {
    return `\n\nTABLE TIER: BEGINNER (${opLabel})
- Use the simplest, most concrete examples (fingers, toys, sweets)
- One-step thinking only: no chaining of ideas
- Keep totals small enough to count on fingers
- Use "imagine you have..." and "now count..." framing
- Celebrate every small step ("you did it!")
- Use very short sentences: no more than 8 words each
- Focus exclusively on ${opLabel} facts`;
  }
  if (tableNumber <= 6) {
    return `\n\nTABLE TIER: DEVELOPING (${opLabel})
- Build on what the child already knows: reference earlier numbers
- Use pattern recognition and counting strategies
- Use "remember when..." to connect to earlier knowledge
- Encourage pattern-spotting
- Slightly longer explanations are okay: up to 12 words per sentence
- Focus exclusively on ${opLabel} facts`;
  }
  if (tableNumber <= 9) {
    return `\n\nTABLE TIER: ADVANCING (${opLabel})
- Challenge with mental strategies like breaking into parts
- Use real-world scenarios (sharing items, arranging rows, counting money)
- Use "what if..." questions to stretch thinking
- Praise effort and strategy, not just the answer
- Equations and mental maths over visual counting
- Focus exclusively on ${opLabel} facts`;
  }
  return `\n\nTABLE TIER: MASTERY (${opLabel})
- Teach rules and shortcuts for ${opLabel}
- Multi-step reasoning and checking strategies
- Use real-world scenarios (money, measurements, time)
- Encourage the child to explain their thinking back
- Confident tone: they know a lot already
- Up to 20-word explanations
- Focus exclusively on ${opLabel} facts`;
}

const OPERATION_NAMES: Record<string, { name: string; symbol: string }> = {
  addition: { name: 'addition', symbol: '+' },
  subtraction: { name: 'subtraction', symbol: '-' },
  multiplication: { name: 'multiplication', symbol: '×' },
  division: { name: 'division', symbol: '÷' },
};

function buildSystemPrompt(operation: string): string {
  const visualExample =
    operation === 'multiplication'
      ? `"description": "3 plates with 4 strawberries each",
    "emoji": "🍓",
    "groups": 3,
    "perGroup": 4,
    "total": 12,
    "equation": "3 × 4 = 12"`
      : operation === 'addition'
        ? `"description": "5 apples, then 3 more apples arrive",
    "emoji": "🍎",
    "groups": 2,
    "perGroup": 5,
    "total": 8,
    "equation": "5 + 3 = 8"`
        : operation === 'subtraction'
          ? `"description": "7 cookies on a plate, 2 get eaten",
    "emoji": "🍪",
    "groups": 2,
    "perGroup": 7,
    "total": 5,
    "equation": "7 - 2 = 5"`
          : `"description": "12 sweets shared equally into 3 bags",
    "emoji": "🍬",
    "groups": 3,
    "perGroup": 4,
    "total": 4,
    "equation": "12 ÷ 3 = 4"`;

  const visualNote =
    operation === 'addition'
      ? '- For addition: "groups" is 2 (the two addends shown side by side), "perGroup" is the first number, "total" is the sum. Show the two sets being combined.'
      : operation === 'subtraction'
        ? '- For subtraction: "groups" is 2 (the starting amount and the amount removed), "perGroup" is the starting number, "total" is what remains. Show taking away.'
        : operation === 'multiplication'
          ? '- For multiplication: "groups" is how many groups, "perGroup" is items in each group, "total" is the product.'
          : '- For division: "groups" is how many equal shares, "perGroup" is the original total, "total" is how many in each share.';

  const opSymbol =
    operation === 'addition'
      ? '+'
      : operation === 'subtraction'
        ? '-'
        : operation === 'multiplication'
          ? '×'
          : '÷';

  const exampleQuestion =
    operation === 'addition'
      ? '5 + 3 = ?'
      : operation === 'subtraction'
        ? '7 - 2 = ?'
        : operation === 'multiplication'
          ? '2 × 5 = ?'
          : '12 ÷ 3 = ?';

  return `You are a warm, encouraging children's math teacher using the Feynman Method combined with NLP learning techniques to teach a 5-year-old child.

Your approach:
1. Explain the concept in ONE short, vivid sentence a 5-year-old can picture (max 20 words)
2. Show it pictorially using emoji objects the child can count
3. Give a short, memorable "sticky sentence" the child can repeat (NLP anchor)
4. Address the one common misconception in ONE short, reassuring sentence (max 20 words)
5. Provide 3 practice questions with visual context

IMPORTANT: This lesson is about ${operation === 'addition' ? 'ADDITION (+)' : operation === 'subtraction' ? 'SUBTRACTION (-)' : operation === 'multiplication' ? 'MULTIPLICATION (×)' : 'DIVISION (÷)'}.
${operation === 'addition' ? 'Show combining two amounts together. Do NOT show repeated addition or groups: that is multiplication.' : ''}
${operation === 'subtraction' ? 'Show taking away from a starting amount. The result must be non-negative.' : ''}
${operation === 'multiplication' ? 'Show equal groups of items.' : ''}
${operation === 'division' ? 'Show sharing equally into groups. Use only clean division with no remainders.' : ''}

NLP rules woven throughout:
- Use "notice" and "imagine" to activate inner visualisation
- Use sensory words (crunchy, yummy, bright, super)
- Use alliteration or rhyme when possible
- Tone: warm, unhurried, never corrective
- Use simple words a 5-year-old understands
- Talk directly to the child using "you" and "your"
- Never use the word "children": always address the child directly with "you"
- Never refer to the child in third person: speak TO them, not ABOUT them

Return ONLY valid JSON (no markdown fences, no explanation outside the JSON). Use this exact structure:

{
  "concept": "ONE short vivid sentence (max 20 words) explaining the concept using a real-world picture",
  "visual": {
    ${visualExample}
  },
  "stickyPhrase": "One short memorable sentence the child repeats as their mental anchor",
  "gapCheck": "ONE short reassuring sentence (max 20 words) clearing up a common confusion",
  "practice": [
    {
      "emoji": "a single emoji for this question's objects",
      "groups": <number>,
      "perGroup": <number>,
      "question": "written question using the ${opSymbol} symbol (e.g. '${exampleQuestion}')",
      "answer": <correct number>,
      "choices": [<4 unique numbers including the answer, shuffled>]
    }
  ]
}

Rules:
- "practice" must have exactly 3 questions
- All numbers in choices must be non-negative integers
- Each choices array must have exactly 4 unique numbers including the answer
${visualNote}
- For subtraction: the first number must be larger than the second (no negatives)
- For division: use only numbers that divide evenly (no remainders)
- Keep all text warm, fun, and encouraging`;
}

// ─── Main generator ──────────────────────────────────────────────────────────

export interface GenerateMathLessonOptions {
  operation: 'addition' | 'subtraction' | 'multiplication' | 'division';
  difficulty?: 'easy' | 'medium' | 'hard';
  tableNumber?: number;
}

/**
 * Generate a kid-safe Maths lesson via Anthropic. Returns null when:
 * - the feature flag is off (aiEnabled() === false)
 * - the Anthropic API returns an error
 * - the response is not valid JSON matching the lesson schema
 *
 * Never call Anthropic with child PII. The prompt contains only the maths
 * operation and difficulty/table settings.
 */
export async function generateMathLesson(
  opts: GenerateMathLessonOptions,
): Promise<MathLesson | null> {
  if (!aiEnabled()) return null;

  const { operation, difficulty, tableNumber } = opts;
  const op = OPERATION_NAMES[operation];
  if (!op) return null;

  let range: string;
  let pedagogy: string;
  if (tableNumber !== undefined) {
    range = getTableRange(operation, tableNumber);
    pedagogy = getTablePedagogy(operation, tableNumber);
  } else {
    range = DIFFICULTY_RANGES[difficulty ?? 'easy'] ?? DIFFICULTY_RANGES.easy!;
    pedagogy = DIFFICULTY_PEDAGOGY[difficulty ?? 'easy'] ?? '';
  }

  const systemPrompt = buildSystemPrompt(operation) + pedagogy;
  const userPrompt = `Generate a ${op.name} lesson using ${range}. The operation symbol is "${op.symbol}". Make this lesson unique and fun!`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      log.error({ status: response.status, body: text }, 'anthropic api error');
      return null;
    }

    const data = (await response.json()) as { content: { type: string; text: string }[] };
    const raw = data.content?.[0]?.text;
    if (!raw) {
      log.error('anthropic returned empty content');
      return null;
    }

    // Strip markdown fences if model adds them despite the prompt.
    const jsonStr = raw
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    const parsed = JSON.parse(jsonStr) as unknown;

    const validated = lessonSchema.safeParse(parsed);
    if (!validated.success) {
      log.error({ issues: validated.error.issues }, 'ai lesson failed schema validation');
      return null;
    }

    log.info({ operation, difficulty, tableNumber }, 'ai math lesson generated');
    return validated.data;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      log.error('ai lesson generation timed out after 30s');
    } else {
      log.error({ error: (err as Error).message }, 'ai lesson generation failed');
    }
    return null;
  }
}
