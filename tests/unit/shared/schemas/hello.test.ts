import { describe, it, expect } from 'vitest';
import { helloResponseSchema } from '@familyhub/shared';

describe('helloResponseSchema', () => {
  it('accepts a valid payload', () => {
    const valid = {
      message: 'hello',
      timestamp: '2025-01-01T00:00:00.000Z',
    };
    expect(helloResponseSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an empty message', () => {
    const result = helloResponseSchema.safeParse({
      message: '',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-datetime timestamp', () => {
    const result = helloResponseSchema.safeParse({
      message: 'hello',
      timestamp: 'not a date',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing fields', () => {
    const result = helloResponseSchema.safeParse({ message: 'hello' });
    expect(result.success).toBe(false);
  });
});
