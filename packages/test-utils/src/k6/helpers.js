// k6 helpers re-export. k6 runs Go-bound JS, NOT Node — so we cannot
// import this through the TypeScript package boundary. k6 scenarios
// import directly from tests/performance/scripts/helpers.js (already
// wired in FHS-153 / FHS-183).
//
// This file exists so consumers writing future k6 scenarios from inside
// packages/test-utils/* (e.g. shared scenario libraries) can `import`
// the same helpers without reaching across the tests/ boundary.

export * from '../../../../tests/performance/scripts/helpers.js';
