import { pino, type LoggerOptions } from 'pino';
import { config } from './config.js';

// Single-line JSON to stdout outside dev. Redaction list keeps obvious
// secrets out of the log even if a caller passes an entire request /
// headers object by accident — defence in depth, not a substitute for
// never-log-secrets discipline.
const baseOptions: LoggerOptions = {
  level: config.LOG_LEVEL,
  base: {
    service: '@familyhub/api',
    env: config.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.body.password',
      'req.body.token',
      'req.body.refreshToken',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.refreshToken',
      '*.apiKey',
    ],
    censor: '[REDACTED]',
  },
};

export const logger = pino(
  config.NODE_ENV === 'development'
    ? {
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : baseOptions,
);

export function createLogger(component: string) {
  return logger.child({ component });
}
