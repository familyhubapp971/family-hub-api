// FHS-270: static journal content shared between API and web.
//
// These arrays are the single source of truth for quotes, creativity
// questions, and mood options. The API uses them for `GET /api/journal/content`
// and for computing `quoteIndex` server-side. The web imports the same
// constants so the UI never has to re-fetch content on every page load.

// ─── Quotes ──────────────────────────────────────────────────────────────────

export interface JournalQuote {
  text: string;
  author: string;
}

export const JOURNAL_QUOTES: JournalQuote[] = [
  { text: 'You get to choose who you want to be.', author: 'Unknown' },
  { text: 'Be the reason someone smiles today.', author: 'Unknown' },
  { text: 'Mistakes are proof that you are trying.', author: 'Unknown' },
  { text: 'You are braver than you believe.', author: 'A.A. Milne' },
  { text: 'Every day is a chance to be better.', author: 'Unknown' },
];

// ─── Creativity questions ─────────────────────────────────────────────────────

export interface JournalCreativityQuestion {
  emoji: string;
  label: string;
  placeholder: string;
  color: string;
}

export const JOURNAL_CREATIVITY_QUESTIONS: JournalCreativityQuestion[] = [
  {
    emoji: '✨',
    label: 'What are you happy about right now?',
    placeholder: 'Write your thoughts here...',
    color: 'bg-yellow-100',
  },
  {
    emoji: '🏆',
    label: 'What makes you feel like a champion?',
    placeholder: 'Tell me about it...',
    color: 'bg-orange-100',
  },
  {
    emoji: '🌈',
    label: 'What would you do if you could do anything?',
    placeholder: 'Dream big...',
    color: 'bg-cyan-100',
  },
  {
    emoji: '💡',
    label: 'What did you learn today that surprised you?',
    placeholder: 'Share your discovery...',
    color: 'bg-lime-100',
  },
  {
    emoji: '🦸',
    label: 'If you were a superhero, what would your power be?',
    placeholder: 'Tell me your superpower...',
    color: 'bg-purple-100',
  },
  {
    emoji: '🎨',
    label: 'What would you create if you had all the supplies?',
    placeholder: 'Imagine it...',
    color: 'bg-pink-100',
  },
];

// ─── Moods ────────────────────────────────────────────────────────────────────

export type JournalMoodValue =
  | 'happy'
  | 'smiling'
  | 'excited'
  | 'laughing'
  | 'surprised'
  | 'nervous'
  | 'grumpy'
  | 'sad';

export interface JournalMoodOption {
  value: JournalMoodValue;
  emoji: string;
  label: string;
}

export const JOURNAL_MOODS: JournalMoodOption[] = [
  { value: 'happy', emoji: '😁', label: 'Happy' },
  { value: 'smiling', emoji: '😊', label: 'Smiling' },
  { value: 'excited', emoji: '🤩', label: 'Excited' },
  { value: 'laughing', emoji: '😂', label: 'Laughing' },
  { value: 'surprised', emoji: '😮', label: 'Surprised' },
  { value: 'nervous', emoji: '😰', label: 'Nervous' },
  { value: 'grumpy', emoji: '😠', label: 'Grumpy' },
  { value: 'sad', emoji: '😢', label: 'Sad' },
];

// ─── Quote-of-the-day helper ─────────────────────────────────────────────────

/**
 * Deterministic hash of a YYYY-MM-DD date string, mapped to a quote index.
 *
 * Same date → same index, every time, on both server and client. The hash
 * is a simple djb2-style accumulator: fast, dependency-free, consistent
 * across JS engines. The result is `hash mod JOURNAL_QUOTES.length`.
 *
 * Example: quoteIndexForDate('2026-06-14') → 2  (always)
 */
export function quoteIndexForDate(dateISO: string): number {
  let h = 5381;
  for (let i = 0; i < dateISO.length; i++) {
    // djb2: h = h * 33 ^ charCode
    h = ((h << 5) + h) ^ dateISO.charCodeAt(i);
    // Keep within 32-bit signed integer range to avoid float drift.
    h = h | 0;
  }
  // Modulo on absolute value so negative hash values still land in range.
  return Math.abs(h) % JOURNAL_QUOTES.length;
}
