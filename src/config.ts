import 'dotenv/config';

import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  MOCK_PORT: z.coerce.number().int().positive().default(4000),
  API_KEY: z.string().min(1).default('change-me'),
  DATABASE_PATH: z.string().default('./data/workshops.db'),
  NOTIFIER_URL: z.string().url().default('http://localhost:4000'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  CLIENT_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(250),
  ERROR_RATE: z.coerce.number().min(0).max(1).default(0),
  TIMEOUT_RATE: z.coerce.number().min(0).max(1).default(0),
  DELAY_MS: z.coerce.number().int().nonnegative().default(0)
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
