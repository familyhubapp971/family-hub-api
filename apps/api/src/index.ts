import { helloResponseSchema, type HelloResponse } from '@familyhub/shared';

// Placeholder — actual Hono server wired in FHS-150.
// This file exists to prove the workspace dependency on @familyhub/shared
// resolves and the shared Zod schema is consumable by the API.
export function buildHello(): HelloResponse {
  const payload: HelloResponse = {
    message: 'hello from @familyhub/api',
    timestamp: new Date().toISOString(),
  };
  return helloResponseSchema.parse(payload);
}
