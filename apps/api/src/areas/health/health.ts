import { Hono } from 'hono';
import { z } from 'zod';

const startupTime = Date.now();

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptime: z.number(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const healthRouter = new Hono().get('/', (c) => {
  const version = process.env.npm_package_version ?? '0.0.0';
  const response: HealthResponse = {
    status: 'ok',
    version,
    uptime: Math.round((Date.now() - startupTime) / 1000),
  };
  return c.json(healthResponseSchema.parse(response));
});
