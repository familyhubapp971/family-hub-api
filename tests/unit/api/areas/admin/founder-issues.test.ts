// FHS-717: the founder's issue report routes, with the database mocked.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFounderRouter, issueFounderToken } from '../../../../../src/areas/admin/founder.js';

const dbMock = { execute: vi.fn() };
vi.mock('../../../../../src/database/client.js', () => ({ getDb: () => dbMock }));

const SECRETS = { passcode: '246810', secret: 'unit-test-secret-at-least-32-characters' };
const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PHOTO_ID = '22222222-2222-4222-8222-222222222222';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

function buildApp(secrets: typeof SECRETS | null = SECRETS) {
  return new Hono().route(
    '/api/founder',
    createFounderRouter(() => secrets),
  );
}

const auth = () => ({ 'x-founder-token': issueFounderToken(SECRETS) });

describe('founder issue routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('every route needs the page token', () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/founder/issues'],
      ['GET', `/api/founder/issues/${ISSUE_ID}/photos/${PHOTO_ID}`],
      ['PATCH', `/api/founder/issues/${ISSUE_ID}`],
    ];

    it.each(routes)('%s %s answers 401 with no token', async (method, path) => {
      const res = await buildApp().request(path, { method });
      expect(res.status).toBe(401);
      expect(dbMock.execute).not.toHaveBeenCalled();
    });

    it.each(routes)('%s %s answers 401 with a forged token', async (method, path) => {
      const res = await buildApp().request(path, {
        method,
        headers: { 'x-founder-token': `${Date.now() + 60_000}.forged` },
      });
      expect(res.status).toBe(401);
    });

    it.each(routes)('%s %s answers 404 when the page is switched off', async (method, path) => {
      const res = await buildApp(null).request(path, { method, headers: auth() });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/founder/issues', () => {
    it('shapes each report for the page, with photo details only', async () => {
      dbMock.execute.mockResolvedValue({
        rows: [
          {
            id: ISSUE_ID,
            created_at: new Date('2026-11-01T10:00:00Z'),
            screen: 'today',
            description: 'Stuck',
            status: 'fixed',
            fixed_at: new Date('2026-11-01T12:00:00Z'),
            family_name: 'Khan Family',
            reporter_email: 'mum@example.com',
            reporter_name: 'Mum',
            photos: [{ id: PHOTO_ID, contentType: 'image/png', sizeBytes: 10 }],
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            created_at: '2026-10-31T10:00:00Z',
            screen: 'meals',
            description: '',
            status: 'new',
            fixed_at: null,
            family_name: 'Ali Family',
            reporter_email: null,
            reporter_name: null,
            photos: null,
          },
        ],
      });
      const res = await buildApp().request('/api/founder/issues', { headers: auth() });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        issues: [
          {
            id: ISSUE_ID,
            createdAt: '2026-11-01T10:00:00.000Z',
            screen: 'today',
            description: 'Stuck',
            status: 'fixed',
            fixedAt: '2026-11-01T12:00:00.000Z',
            familyName: 'Khan Family',
            reporterEmail: 'mum@example.com',
            reporterName: 'Mum',
            photos: [{ id: PHOTO_ID, contentType: 'image/png', sizeBytes: 10 }],
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            createdAt: '2026-10-31T10:00:00.000Z',
            screen: 'meals',
            description: '',
            status: 'new',
            fixedAt: null,
            familyName: 'Ali Family',
            reporterEmail: null,
            reporterName: null,
            photos: [],
          },
        ],
      });
    });
  });

  describe('GET /api/founder/issues/:id/photos/:photoId', () => {
    it('sends the stored bytes with safe headers', async () => {
      dbMock.execute.mockResolvedValue({
        rows: [{ content_type: 'image/png', size_bytes: PNG.length, data: PNG }],
      });
      const res = await buildApp().request(`/api/founder/issues/${ISSUE_ID}/photos/${PHOTO_ID}`, {
        headers: auth(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-disposition')).toBe('inline');
      expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), PNG)).toBe(0);
    });

    it('answers 404 when the photo is not part of that report', async () => {
      dbMock.execute.mockResolvedValue({ rows: [] });
      const res = await buildApp().request(`/api/founder/issues/${ISSUE_ID}/photos/${PHOTO_ID}`, {
        headers: auth(),
      });
      expect(res.status).toBe(404);
    });

    it('answers 404 for ids that are not uuids, without asking the database', async () => {
      const res = await buildApp().request(`/api/founder/issues/nope/photos/${PHOTO_ID}`, {
        headers: auth(),
      });
      expect(res.status).toBe(404);
      expect(dbMock.execute).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/founder/issues/:id', () => {
    const patch = (body: unknown, id = ISSUE_ID) =>
      buildApp().request(`/api/founder/issues/${id}`, {
        method: 'PATCH',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('marks a report fixed', async () => {
      dbMock.execute.mockResolvedValue({
        rows: [{ id: ISSUE_ID, status: 'fixed', fixed_at: new Date('2026-11-01T12:00:00Z') }],
      });
      const res = await patch({ status: 'fixed' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: ISSUE_ID,
        status: 'fixed',
        fixedAt: '2026-11-01T12:00:00.000Z',
      });
    });

    it('reopens a report and clears fixedAt', async () => {
      dbMock.execute.mockResolvedValue({ rows: [{ id: ISSUE_ID, status: 'new', fixed_at: null }] });
      const res = await patch({ status: 'new' });
      expect(await res.json()).toEqual({ id: ISSUE_ID, status: 'new', fixedAt: null });
    });

    it('answers 404 for an unknown report', async () => {
      dbMock.execute.mockResolvedValue({ rows: [] });
      expect((await patch({ status: 'fixed' })).status).toBe(404);
    });

    it('answers 404 for an id that is not a uuid', async () => {
      expect((await patch({ status: 'fixed' }, 'nope')).status).toBe(404);
      expect(dbMock.execute).not.toHaveBeenCalled();
    });

    it.each([{ status: 'done' }, {}, null])('refuses %j with 400', async (body) => {
      expect((await patch(body)).status).toBe(400);
      expect(dbMock.execute).not.toHaveBeenCalled();
    });
  });
});
