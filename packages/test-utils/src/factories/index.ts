// Factory exports. Two flavours per entity:
//   - buildX(overrides?)    — pure object construction (no DB)
//   - createX(db, overrides?) — build + INSERT (throws until FHS-1+ adds the table)
//
// Once Sprint 1 (FHS-1) adds the tenants/users/families tables in
// apps/api/src/db/schema.ts, the createX implementations get wired
// against Drizzle inserts. Until then the build* helpers cover all
// tier-1 unit-test needs (typed object construction).

export {
  buildTenant,
  createTenant,
  type Tenant,
} from './tenant.js';

export {
  buildUser,
  createUser,
  type User,
} from './user.js';

export {
  buildFamily,
  createFamily,
  type Family,
} from './family.js';
