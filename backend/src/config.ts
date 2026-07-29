import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().default(5000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  // Optional: the AI endpoints are stateless. Set it only to re-enable the
  // database-backed routes and the pg-boss job queue.
  DATABASE_URL: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s.split(',').map((o) => o.trim()).filter(Boolean)
        : [],
    ),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    console.error(
      `[config] Environment validation failed — startup aborted.\n` +
        `Missing or invalid variables:\n${issues}`,
    );
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
