import { Hono } from 'hono';
import { helloResponseSchema, type HelloResponse } from '@familyhub/shared';

export const helloRouter = new Hono().get('/', (c) => {
  const payload: HelloResponse = {
    message: 'hello from @familyhub/api',
    timestamp: new Date().toISOString(),
  };
  return c.json(helloResponseSchema.parse(payload));
});
