// FHS-717: report an issue with photos. The form rules, the photo type check
// and the route's gates, with the database mocked.
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PHOTO_BYTES,
  MAX_REQUEST_BYTES,
  createIssueReportsRouter,
  readIssueReportForm,
  sniffImageType,
} from '../../../../../src/areas/feedback/issue-reports.js';
import { _resetRateLimitForTests } from '../../../../../src/security/rate-limit.js';
import type { User } from '../../../../../src/database/schema.js';

const dbMock = { select: vi.fn(), transaction: vi.fn() };
vi.mock('../../../../../src/database/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000717';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const REPORT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ROW: User = {
  id: USER_ID,
  email: 'mum@example.com',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = new Uint8Array(
  [...'RIFF']
    .map((ch) => ch.charCodeAt(0))
    .concat(
      [0x24, 0, 0, 0],
      [...'WEBPVP8 '].map((ch) => ch.charCodeAt(0)),
    ),
);
const TEXT = new TextEncoder().encode('just some words, not a photo');

const file = (bytes: Uint8Array, name = 'photo.jpg', type = 'image/jpeg') =>
  new File([bytes], name, { type });

// ─── The photo type check ─────────────────────────────────────────────────────

describe('sniffImageType', () => {
  it('knows a JPEG from its first bytes', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
  });

  it('knows a PNG from its first bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
  });

  it('knows a WebP from its first bytes', () => {
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('refuses plain text', () => {
    expect(sniffImageType(TEXT)).toBeNull();
  });

  it('refuses another RIFF file, such as a WAV sound', () => {
    const wav = new Uint8Array([...'RIFF\x24\x00\x00\x00WAVEfmt '].map((ch) => ch.charCodeAt(0)));
    expect(sniffImageType(wav)).toBeNull();
  });

  it('refuses a GIF', () => {
    expect(sniffImageType(new TextEncoder().encode('GIF89a......'))).toBeNull();
  });

  it('refuses an empty or cut-off file', () => {
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

// ─── The form rules ───────────────────────────────────────────────────────────

describe('readIssueReportForm', () => {
  it('takes words only, trimmed', async () => {
    const r = await readIssueReportForm({
      screen: 'today',
      description: '  The button is stuck  ',
    });
    expect(r).toEqual({
      ok: true,
      report: { screen: 'today', description: 'The button is stuck', visitId: null, photos: [] },
    });
  });

  it('takes a photo only, typed from its bytes not its name', async () => {
    const r = await readIssueReportForm({ screen: 'meals', photos: file(PNG, 'shot.jpg') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.description).toBe('');
    expect(r.report.photos).toHaveLength(1);
    expect(r.report.photos[0]!.type).toBe('image/png');
    expect(Buffer.compare(r.report.photos[0]!.bytes, Buffer.from(PNG))).toBe(0);
  });

  it('keeps the visit id', async () => {
    const visitId = '44444444-4444-4444-8444-444444444444';
    const r = await readIssueReportForm({ screen: 'today', description: 'x', visitId });
    expect(r.ok && r.report.visitId).toBe(visitId);
  });

  it('treats empty boxes as not given', async () => {
    const r = await readIssueReportForm({ screen: 'today', description: 'x', visitId: '' });
    expect(r.ok && r.report.visitId).toBeNull();
  });

  it('refuses an empty report', async () => {
    const r = await readIssueReportForm({ screen: 'today' });
    expect(r).toMatchObject({ ok: false, status: 400, body: { errorCode: 'EMPTY_REPORT' } });
  });

  it('refuses a report of only spaces', async () => {
    const r = await readIssueReportForm({ screen: 'today', description: '    ' });
    expect(r).toMatchObject({ ok: false, status: 400, body: { errorCode: 'EMPTY_REPORT' } });
  });

  it('needs a screen', async () => {
    const r = await readIssueReportForm({ description: 'x' });
    expect(r).toMatchObject({ ok: false, status: 400, body: { errorCode: 'INVALID_FIELDS' } });
  });

  it('refuses a screen name outside a-z, 0-9 and dashes', async () => {
    const r = await readIssueReportForm({ screen: 'Today!', description: 'x' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a screen name longer than 40 characters', async () => {
    const r = await readIssueReportForm({ screen: 'a'.repeat(41), description: 'x' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('takes 2000 characters of description', async () => {
    const r = await readIssueReportForm({ screen: 'today', description: 'a'.repeat(2000) });
    expect(r.ok).toBe(true);
  });

  it('refuses 2001 characters of description', async () => {
    const r = await readIssueReportForm({ screen: 'today', description: 'a'.repeat(2001) });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a visit id that is not a uuid', async () => {
    const r = await readIssueReportForm({ screen: 'today', description: 'x', visitId: 'abc' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a screen sent twice', async () => {
    const r = await readIssueReportForm({ screen: ['today', 'meals'], description: 'x' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('takes 3 photos', async () => {
    const r = await readIssueReportForm({
      screen: 'today',
      photos: [file(JPEG), file(PNG), file(WEBP)],
    });
    expect(r.ok && r.report.photos.map((p) => p.type)).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it('refuses a 4th photo', async () => {
    const r = await readIssueReportForm({
      screen: 'today',
      photos: [file(JPEG), file(JPEG), file(JPEG), file(JPEG)],
    });
    expect(r).toMatchObject({ ok: false, status: 400, body: { errorCode: 'TOO_MANY_PHOTOS' } });
  });

  it('refuses text sent in the photos box', async () => {
    const r = await readIssueReportForm({ screen: 'today', photos: 'not a file' });
    expect(r).toMatchObject({ ok: false, status: 400, body: { errorCode: 'PHOTO_NOT_A_FILE' } });
  });

  it('refuses a text file named like a photo', async () => {
    const r = await readIssueReportForm({ screen: 'today', photos: file(TEXT, 'fake.jpg') });
    expect(r).toMatchObject({ ok: false, status: 400, body: { errorCode: 'PHOTO_TYPE' } });
  });

  it('takes a photo of exactly 1 MB', async () => {
    const big = new Uint8Array(MAX_PHOTO_BYTES);
    big.set(JPEG);
    const r = await readIssueReportForm({ screen: 'today', photos: file(big) });
    expect(r.ok).toBe(true);
  });

  it('refuses a photo over 1 MB with 413', async () => {
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
    big.set(JPEG);
    const r = await readIssueReportForm({ screen: 'today', photos: file(big) });
    expect(r).toMatchObject({ ok: false, status: 413, body: { errorCode: 'PHOTO_TOO_LARGE' } });
  });
});

// ─── The route ────────────────────────────────────────────────────────────────

function chain(rows: unknown): unknown {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}

interface Inserted {
  report?: Record<string, unknown>;
  photos?: Array<Record<string, unknown>>;
}

function buildApp(opts: { role: string | null; tenant?: boolean; perHour?: number }) {
  const inserted: Inserted = {};
  dbMock.select.mockImplementation(() =>
    chain(opts.role ? [{ id: MEMBER_ID, role: opts.role }] : []),
  );
  dbMock.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    let call = 0;
    const tx = {
      insert: () => ({
        values: (v: unknown) => {
          call += 1;
          if (call === 1) {
            inserted.report = v as Record<string, unknown>;
            return { returning: () => Promise.resolve([{ id: REPORT_ID }]) };
          }
          inserted.photos = v as Array<Record<string, unknown>>;
          return Promise.resolve();
        },
      }),
    };
    return fn(tx);
  });

  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: USER_ROW.email, claims: {} });
    c.set('userRow', USER_ROW);
    if (opts.tenant !== false) c.set('tenantId', TENANT_ID);
    await next();
  };
  const app = new Hono();
  app.use('*', seed);
  app.route('/api/feedback/issues', createIssueReportsRouter({ perHour: opts.perHour ?? 100 }));
  return { app, inserted };
}

function form(fields: Record<string, string>, photos: File[] = []): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const p of photos) fd.append('photos', p);
  return fd;
}

const post = (app: Hono, body: BodyInit, headers: Record<string, string> = {}) =>
  app.request('/api/feedback/issues', { method: 'POST', body, headers });

describe('POST /api/feedback/issues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    _resetRateLimitForTests();
  });

  it('saves a grown-up report and answers 201 with its id', async () => {
    const { app, inserted } = buildApp({ role: 'adult' });
    const res = await post(app, form({ screen: 'today', description: 'Stuck' }, [file(JPEG)]));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: REPORT_ID });
    expect(inserted.report).toMatchObject({
      tenantId: TENANT_ID,
      submittedByUserId: USER_ID,
      submittedByMemberId: MEMBER_ID,
      screen: 'today',
      description: 'Stuck',
      visitId: null,
    });
    expect(inserted.photos).toHaveLength(1);
    expect(inserted.photos![0]).toMatchObject({
      reportId: REPORT_ID,
      tenantId: TENANT_ID,
      contentType: 'image/jpeg',
      sizeBytes: JPEG.length,
    });
  });

  it('lets a family admin report too', async () => {
    const { app } = buildApp({ role: 'admin' });
    const res = await post(app, form({ screen: 'today', description: 'x' }));
    expect(res.status).toBe(201);
  });

  it('skips the photo insert when there are no photos', async () => {
    const { app, inserted } = buildApp({ role: 'adult' });
    await post(app, form({ screen: 'today', description: 'x' }));
    expect(inserted.photos).toBeUndefined();
  });

  it.each(['child', 'teen', 'guest'])('refuses a %s with 403', async (role) => {
    const { app } = buildApp({ role });
    const res = await post(app, form({ screen: 'today', description: 'x' }));
    expect(res.status).toBe(403);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('refuses someone outside the family with 403', async () => {
    const { app } = buildApp({ role: null });
    const res = await post(app, form({ screen: 'today', description: 'x' }));
    expect(res.status).toBe(403);
  });

  it('needs a family with 400', async () => {
    const { app } = buildApp({ role: 'adult', tenant: false });
    const res = await post(app, form({ screen: 'today', description: 'x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errorCode: 'TENANT_REQUIRED' });
  });

  it('refuses a JSON body with 400', async () => {
    const { app } = buildApp({ role: 'adult' });
    const res = await post(app, JSON.stringify({ screen: 'today', description: 'x' }), {
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errorCode: 'MULTIPART_REQUIRED' });
  });

  it('passes the form rules through: an empty report is 400', async () => {
    const { app } = buildApp({ role: 'adult' });
    const res = await post(app, form({ screen: 'today' }));
    expect(res.status).toBe(400);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('refuses a request declared over 3.5 MB with 413 before reading it', async () => {
    const { app } = buildApp({ role: 'adult' });
    const res = await post(app, form({ screen: 'today', description: 'x' }), {
      'Content-Length': String(MAX_REQUEST_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: 'request too large',
      errorCode: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('refuses a streamed request that grows past 3.5 MB with 413', async () => {
    const { app } = buildApp({ role: 'adult' });
    const chunk = new Uint8Array(512 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_REQUEST_BYTES + chunk.length) return controller.close();
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const res = await app.request('/api/feedback/issues', {
      method: 'POST',
      body: stream,
      headers: { 'Content-Type': 'multipart/form-data; boundary=xyz' },
      // @ts-expect-error duplex is needed for a streamed body in Node.
      duplex: 'half',
    });
    expect(res.status).toBe(413);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('refuses a kid before looking at an oversized body', async () => {
    const { app } = buildApp({ role: 'child' });
    const res = await post(app, form({ screen: 'today', description: 'x' }), {
      'Content-Length': String(MAX_REQUEST_BYTES + 1),
    });
    expect(res.status).toBe(403);
  });

  it('allows each person a set number of reports an hour', async () => {
    const { app } = buildApp({ role: 'adult', perHour: 2 });
    expect((await post(app, form({ screen: 'today', description: '1' }))).status).toBe(201);
    expect((await post(app, form({ screen: 'today', description: '2' }))).status).toBe(201);
    const third = await post(app, form({ screen: 'today', description: '3' }));
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
  });
});
