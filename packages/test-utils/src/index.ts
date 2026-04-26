// Server-side barrel for @familyhub/test-utils.
// Web-side helpers (RTL render + MSW) live at @familyhub/test-utils/web.
// k6 helpers (plain JS) live at @familyhub/test-utils/k6.

export { getTestDb, closeTestDb } from './db/client.js';
export { withTenant, currentTenantId } from './db/withTenant.js';
export { truncateAll } from './db/truncate.js';

export {
  buildTenant,
  buildUser,
  buildFamily,
  createTenant,
  createUser,
  createFamily,
  type Tenant,
  type User,
  type Family,
} from './factories/index.js';

export { seedFaker, resetFaker } from './factories/_seed.js';
export { makeRequest } from './request/makeRequest.js';
export { mintTestJwt } from './auth/jwt.js';
