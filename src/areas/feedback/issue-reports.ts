import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { bodyLimit } from 'hono/body-limit';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, runWithRequestDb, type Database } from '../../database/client.js';
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
// protects it: 3 photos, 1 MB each, the whole request about 3.5 MB, 20
// reports an hour per person and 30 a day per family. A photo's type comes
// from its first bytes, never from the name or type the browser sent, so a
// renamed text file is refused.
//
// This route opens its own short database connections (see request-db.ts):
// one to check the caller, none while the photos upload, and one to save.
// A slow phone therefore never holds a connection the rest of the app needs.

export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 1_048_576;
// Three full-size photos plus the words and the form's own wrapping.
export const MAX_REQUEST_BYTES = 3_670_016;
export const REPORTS_PER_HOUR = 20;
export const FAMILY_REPORTS_PER_DAY = 30;
export const READ_TIMEOUT_MS = 60_000;

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

// Every invisible control character except tab and line break. A zero byte
// would otherwise make Postgres refuse the whole report.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Browsers send each line break in a form as two characters (CRLF). Turn
 * every line break into one LF, so 2000 typed characters stay 2000, then
 * drop control characters.
 */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

// A form sends an empty box as "", which here means "not given".
const blankAsMissing = (v: unknown) => (v === '' ? undefined : v);

export const issueReportFieldsSchema = z.object({
  screen: z.string().regex(/^[a-z0-9-]{1,40}$/),
  description: z.preprocess(
    (v) => (typeof v === 'string' ? cleanText(v) : v),
    z.string().trim().max(2000).optional(),
  ),
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
  // A file anywhere but `photos` would otherwise be dropped without a word.
  for (const [key, value] of Object.entries(form)) {
    const values = Array.isArray(value) ? value : [value];
    if (key !== 'photos' && values.some((v) => typeof v !== 'string')) {
      return invalid('UNEXPECTED_FILE', 'send photos in the photos field only');
    }
  }

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

// ─── Database ─────────────────────────────────────────────────────────────────

/** Reports this family sent in the last 24 hours. RLS keeps it to the pinned family too. */
export async function countRecentReports(db: Database, tenantId: string): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from issue_reports
        where tenant_id = ${tenantId} and created_at > now() - interval '24 hours'`,
  );
  return rows[0]?.n ?? 0;
}

// ─── Router ───────────────────────────────────────────────────────────────────

const tooLarge = (c: Context) =>
  c.json({ error: 'request too large', errorCode: 'PAYLOAD_TOO_LARGE' }, 413);

const familyLimit = (c: Context) =>
  c.json(
    {
      error: 'this family has sent 30 reports today; try again tomorrow',
      errorCode: 'FAMILY_DAILY_LIMIT',
    },
    429,
  );

/** The parsed form, or 'timeout' if it has not fully arrived within `ms`. */
async function readFormWithin(c: Context, ms: number): Promise<ParsedForm | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const parse = c.req.parseBody({ all: true });
  // If we stop waiting, a later failure of the abandoned read is expected.
  parse.catch(() => undefined);
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([parse, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type Vars = { Variables: { reporterMemberId: string } };

export interface IssueReportsOptions {
  /** Reports each person may send an hour. */
  perHour: number;
  /** Reports each family may send in any 24 hours. */
  familyPerDay?: number;
  /** How long the whole form may take to arrive. */
  readTimeoutMs?: number;
}

export function createIssueReportsRouter(opts: IssueReportsOptions) {
  const familyPerDay = opts.familyPerDay ?? FAMILY_REPORTS_PER_DAY;
  const readTimeoutMs = opts.readTimeoutMs ?? READ_TIMEOUT_MS;

  // Only grown-ups of the family get past this, before any of the body is
  // read. One short connection, released before the upload starts.
  const requireGrownUp = createMiddleware<Vars>(async (c, next) => {
    getAuthenticatedUser(c);
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    // No mirror row means no membership: members point at the mirror row.
    const userRow = c.get('userRow');
    const { caller, recent } = await runWithRequestDb(
      async () => {
        const found = userRow ? await loadCaller(getDb(), tenantId, userRow.id) : null;
        const allowed = found && isAdminOrAdult(found) ? found : null;
        return {
          caller: allowed,
          recent: allowed ? await countRecentReports(getDb(), tenantId) : 0,
        };
      },
      { tenantId },
    );
    if (!caller) {
      return c.json(
        { error: 'forbidden', errorCode: 'GROWN_UPS_ONLY', detail: 'only grown-ups can report' },
        403,
      );
    }
    // Checked again when saving; this early check spares a pointless upload.
    if (recent >= familyPerDay) return familyLimit(c);
    c.set('reporterMemberId', caller.id);
    await next();
  });

  return new Hono<Vars>().post(
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

      // No database connection is held while the form arrives.
      let form: ParsedForm | 'timeout';
      try {
        form = await readFormWithin(c, readTimeoutMs);
      } catch (err) {
        // A body with no declared length is counted as it streams in; going
        // over the cap surfaces here as a read error.
        if (err instanceof Error && err.name === 'BodyLimitError') return tooLarge(c);
        return c.json({ error: 'invalid request', errorCode: 'INVALID_FORM' }, 400);
      }
      if (form === 'timeout') {
        // Close the connection too, so a stalled phone stops sending.
        c.header('Connection', 'close');
        return c.json({ error: 'the upload took too long', errorCode: 'UPLOAD_TIMEOUT' }, 408);
      }

      const check = await readIssueReportForm(form);
      if (!check.ok) return c.json(check.body, check.status);
      const { report } = check;

      // A second short connection. Report and photos land together or not at
      // all, and the family's daily count is taken under a per-family lock
      // so two reports sent at once cannot both squeeze past it.
      const id = await runWithRequestDb(
        () =>
          getDb().transaction(async (tx) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`issue-reports:${tenantId}`}))`,
            );
            if ((await countRecentReports(tx, tenantId)) >= familyPerDay) return null;
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
          }),
        { tenantId },
      );
      if (id === null) return familyLimit(c);

      return c.json(issueReportCreatedSchema.parse({ id }), 201);
    },
  );
}

export const issueReportsRouter = createIssueReportsRouter({ perHour: REPORTS_PER_HOUR });
