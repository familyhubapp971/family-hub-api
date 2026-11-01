import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { getDb } from '../../database/client.js';
import { issueReportPhotos, issueReports } from '../../database/schema.js';
import { getAuthenticatedUser } from '../../security/auth.js';
import { isAdminOrAdult, loadCaller } from '../../security/permissions.js';
import { rateLimit } from '../../security/rate-limit.js';

// FHS-717: report an issue with photos.
//
// Single route: POST /api/feedback/issues, sent as multipart/form-data with
// the fields screen, description, visitId and up to 3 files named `photos`.
// Auth: Bearer token + x-tenant-slug, like POST /api/feedback. Only grown-ups
// (admin or adult members of the family) may send one.
//
// The founder chose to keep photos in our own database, so every limit here
// protects it: 3 photos, 1 MB each, the whole request about 3.5 MB, and 20
// reports an hour per person. A photo's type comes from its first bytes, never
// from the name or type the browser sent, so a renamed text file is refused.

export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 1_048_576;
// Three full-size photos plus the words and the form's own wrapping.
export const MAX_REQUEST_BYTES = 3_670_016;
export const REPORTS_PER_HOUR = 20;

export type PhotoType = 'image/jpeg' | 'image/png' | 'image/webp';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasAscii(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** The real image type, read from the file's first bytes, or null if it is not a photo we take. */
export function sniffImageType(bytes: Uint8Array): PhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 12 && hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP')) {
    return 'image/webp';
  }
  return null;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

// A form sends an empty box as "", which here means "not given".
const blankAsMissing = (v: unknown) => (v === '' ? undefined : v);

export const issueReportFieldsSchema = z.object({
  screen: z.string().regex(/^[a-z0-9-]{1,40}$/),
  description: z.preprocess(blankAsMissing, z.string().trim().max(2000).optional()),
  visitId: z.preprocess(blankAsMissing, z.string().uuid().optional()),
});

export const issueReportCreatedSchema = z.object({ id: z.string().uuid() });

// ─── Form reading ─────────────────────────────────────────────────────────────

export type FormValue = string | File;
export type ParsedForm = Record<string, FormValue | FormValue[]>;

export interface IssueReportInput {
  screen: string;
  description: string;
  visitId: string | null;
  photos: Array<{ type: PhotoType; bytes: Buffer }>;
}

export type IssueReportCheck =
  | { ok: true; report: IssueReportInput }
  | { ok: false; status: 400 | 413; body: Record<string, unknown> };

function invalid(errorCode: string, error = 'invalid request'): IssueReportCheck {
  return { ok: false, status: 400, body: { error, errorCode } };
}

/** Checks a parsed form and reads each photo. Every rule of the contract lives here. */
export async function readIssueReportForm(form: ParsedForm): Promise<IssueReportCheck> {
  const parsed = issueReportFieldsSchema.safeParse({
    screen: form['screen'],
    description: form['description'],
    visitId: form['visitId'],
  });
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid request',
        errorCode: 'INVALID_FIELDS',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  }

  const raw = form['photos'];
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (entries.length > MAX_PHOTOS) return invalid('TOO_MANY_PHOTOS', 'at most 3 photos');

  const photos: IssueReportInput['photos'] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') return invalid('PHOTO_NOT_A_FILE', 'photos must be files');
    if (entry.size > MAX_PHOTO_BYTES) {
      return {
        ok: false,
        status: 413,
        body: { error: 'photo too large', errorCode: 'PHOTO_TOO_LARGE', maxBytes: MAX_PHOTO_BYTES },
      };
    }
    const bytes = Buffer.from(await entry.arrayBuffer());
    const type = sniffImageType(bytes);
    if (!type) return invalid('PHOTO_TYPE', 'photos must be JPEG, PNG or WebP');
    photos.push({ type, bytes });
  }

  const description = parsed.data.description ?? '';
  if (description === '' && photos.length === 0) {
    return invalid('EMPTY_REPORT', 'add a few words or a photo');
  }

  return {
    ok: true,
    report: {
      screen: parsed.data.screen,
      description,
      visitId: parsed.data.visitId ?? null,
      photos,
    },
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

const tooLarge = (c: Context) =>
  c.json({ error: 'request too large', errorCode: 'PAYLOAD_TOO_LARGE' }, 413);

// Only grown-ups of the family get past this, before any of the body is read.
const requireGrownUp = createMiddleware<{ Variables: { reporterMemberId: string } }>(
  async (c, next) => {
    getAuthenticatedUser(c);
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    // No mirror row means no membership: members point at the mirror row.
    const userRow = c.get('userRow');
    const caller = userRow ? await loadCaller(getDb(), tenantId, userRow.id) : null;
    if (!caller || !isAdminOrAdult(caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'GROWN_UPS_ONLY', detail: 'only grown-ups can report' },
        403,
      );
    }
    c.set('reporterMemberId', caller.id);
    await next();
  },
);

export function createIssueReportsRouter(opts: { perHour: number }) {
  return new Hono<{ Variables: { reporterMemberId: string } }>().post(
    '/',
    // Counted per signed-in person, not per address, so a family behind one
    // home router does not share the allowance.
    rateLimit({
      capacity: opts.perHour,
      windowMs: 60 * 60_000,
      keyFor: (ip, c) => `issue-reports:${c.get('user')?.id ?? ip ?? 'unknown'}`,
    }),
    requireGrownUp,
    bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: tooLarge }),
    async (c) => {
      const tenantId = c.get('tenantId') as string;
      const userRow = c.get('userRow');

      const contentType = c.req.header('content-type') ?? '';
      if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        return c.json(
          { error: 'send the report as multipart/form-data', errorCode: 'MULTIPART_REQUIRED' },
          400,
        );
      }

      let form: ParsedForm;
      try {
        form = await c.req.parseBody({ all: true });
      } catch (err) {
        // A body with no declared length is counted as it streams in; going
        // over the cap surfaces here as a read error.
        if (err instanceof Error && err.name === 'BodyLimitError') return tooLarge(c);
        return c.json({ error: 'invalid request', errorCode: 'INVALID_FORM' }, 400);
      }

      const check = await readIssueReportForm(form);
      if (!check.ok) return c.json(check.body, check.status);
      const { report } = check;

      // Report and photos land together or not at all.
      const id = await getDb().transaction(async (tx) => {
        const [row] = await tx
          .insert(issueReports)
          .values({
            tenantId,
            submittedByUserId: userRow?.id ?? null,
            submittedByMemberId: c.get('reporterMemberId'),
            screen: report.screen,
            description: report.description,
            visitId: report.visitId,
          })
          .returning({ id: issueReports.id });
        if (!row) throw new Error('issue report insert returned no row');
        if (report.photos.length > 0) {
          await tx.insert(issueReportPhotos).values(
            report.photos.map((p) => ({
              reportId: row.id,
              tenantId,
              contentType: p.type,
              sizeBytes: p.bytes.length,
              data: p.bytes,
            })),
          );
        }
        return row.id;
      });

      return c.json(issueReportCreatedSchema.parse({ id }), 201);
    },
  );
}

export const issueReportsRouter = createIssueReportsRouter({ perHour: REPORTS_PER_HOUR });
