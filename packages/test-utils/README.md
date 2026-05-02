# @familyhub/test-utils

Shared test machinery for the Family Hub monorepo. Single source of truth
for tenant scoping, factories, request helpers, and test JWT minting.

## Three subpath exports

| Subpath                     | Use from                                | Pulls in                     |
| --------------------------- | --------------------------------------- | ---------------------------- |
| `@familyhub/test-utils`     | api + integration specs (Node)          | drizzle, pg, hono types only |
| `@familyhub/test-utils/web` | apps/web vitest + future RTL specs      | React + RTL                  |
| `@familyhub/test-utils/k6`  | k6 scenarios under `tests/performance/` | plain JS only                |

Server-side specs **must not** import from `/web` or they'll pull React + jsdom into a node environment.

## Key exports

### Tenant scoping (per [ADR 0001](../../documents/decisions/0001-multi-tenancy.md))

```ts
import { withTenant, currentTenantId, setTenantOnTransaction } from '@familyhub/test-utils';

await withTenant(tenantId, async () => {
  // currentTenantId() returns tenantId here
  // any AsyncLocalStorage-aware code reads the tenant
});

await db.transaction(async (tx) => {
  await setTenantOnTransaction(tx, tenantId); // SET LOCAL app.tenant_id = '<uuid>'
  // queries here run as that tenant; RLS filters at the storage layer
});
```

`setTenantOnTransaction` accepts UUIDs only. Slugs are resolved to UUIDs by the prod tenant middleware (FHS-12) before reaching this helper.

### HTTP requests (per [ADR 0002](../../documents/decisions/0002-subdomain-tenant-routing.md))

```ts
import { makeRequest } from '@familyhub/test-utils';
import { app } from '@familyhub/api/app';

// Builds http://acme.familyhub.app/health so the prod subdomain
// middleware sees the tenant exactly as it would in production.
const res = await makeRequest(app, 'GET', '/health', { tenantSlug: 'acme' });
```

### Factories (build vs create)

```ts
import { buildTenant, buildUser, buildFamily } from '@familyhub/test-utils';

// Pure object construction — works today.
const t = buildTenant({ slug: 'acme' });
const u = buildUser({ tenantId: t.id });

// Persisted variants throw until FHS-1 lands the tables. Use buildX
// for object construction; switch to createX once Sprint 1 lands.
import { createTenant } from '@familyhub/test-utils';
await createTenant(getTestDb(), { slug: 'acme' }); // throws today
```

Determinism via faker seed:

```ts
import { seedFaker } from '@familyhub/test-utils';
beforeEach(() => seedFaker(42)); // reproducible factory output per test
```

### Test DB

```ts
import { getTestDb, closeTestDb } from '@familyhub/test-utils';

const db = getTestDb(); // pg.Pool against DATABASE_URL_TEST

// MUST be wired in a global afterAll, otherwise vitest --watch will hang.
afterAll(async () => {
  await closeTestDb();
});
```

### Web rendering

```ts
import { renderWithProviders } from '@familyhub/test-utils/web';

renderWithProviders(<MyComponent />); // currently a passthrough wrapper
                                       // — QueryClient / Router land later
```

### Test JWT

```ts
import { mintTestJwt } from '@familyhub/test-utils';

// Refuses to mint outside NODE_ENV=test or VITEST=true.
const token = mintTestJwt({ sub: 'user-1', tenant_id: 'uuid-...' });
```

`alg=none` placeholder until Supabase JWTs land in [FHS-191](https://qualicion2.atlassian.net/browse/FHS-191).

## Open follow-ups

- **`truncateAll` table list is empty** until Sprint 1 (FHS-1) adds tenant-scoped tables. Calls today are silent no-ops; a spec relying on it must check the list when writing the test.
- **`createX` factories throw** with a clear FHS-1 reference. Use `buildX` until Sprint 1.
- **`renderWithProviders` is a passthrough** until QueryClient + Router land in later sprints.
- **`getTestDb` defaults** to `localhost:5433` matching the [FHS-181](https://qualicion2.atlassian.net/browse/FHS-181) docker-compose.test.yml. CI sets `DATABASE_URL_TEST` explicitly.
