// FHS-382: Shared Reading Log schemas.
//
// Extracted from routes/reading-log.ts so kid.ts and registry.ts can import
// them without pulling in the (now-deleted) parent /api/reading-log router.
// The parent Reading Log route was removed in FHS-382. See ADR 0017.

import { z } from 'zod';

// Shape returned for each book in list + create responses.
export const bookSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  author: z.string().nullable(),
  finished: z.boolean(),
  createdAt: z.string().datetime(),
});

export const listBooksResponseSchema = z.object({ books: z.array(bookSchema) });
