/**
 * Environment configuration, validated once at boot.
 *
 * A misconfigured deployment fails at startup with a list of what is wrong,
 * rather than at 3am on the first request that touches the missing value. The
 * driver selections are also validated against each other: choosing the real
 * gateway without credentials is a configuration error, not a runtime surprise.
 */
import { z } from 'zod';
import { loadEnv } from './load-env.js';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(['local', 'ci', 'development', 'staging', 'production']).default('local'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),

    DATABASE_URL: z.string().url(),
    DIRECT_DATABASE_URL: z.string().url().optional(),
    REDIS_URL: z.string().url(),

    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    CREDENTIAL_ENCRYPTION_KEY: z
      .string()
      .min(1)
      .refine((v) => Buffer.from(v, 'base64').length === 32, {
        message: 'CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, base64 encoded',
      }),

    PAYMENT_GATEWAY_DRIVER: z.enum(['fake', 'numbers']).default('fake'),
    ACCOUNTING_DRIVER: z.enum(['fake', 'zoho']).default('fake'),
    MAIL_DRIVER: z.enum(['smtp', 'postmark', 'console']).default('console'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),

    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().default('Fenwick Invoicing <billing@localhost>'),
    POSTMARK_SERVER_TOKEN: z.string().optional(),

    STORAGE_LOCAL_PATH: z.string().default('./storage'),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_ENDPOINT: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    NUMBERS_API_BASE_URL: z.string().optional(),
    NUMBERS_API_KEY: z.string().optional(),
    NUMBERS_WEBHOOK_SECRET: z.string().optional(),

    ZOHO_CLIENT_ID: z.string().optional(),
    ZOHO_CLIENT_SECRET: z.string().optional(),
    ZOHO_REDIRECT_URI: z.string().optional(),
    ZOHO_API_DOMAIN: z.string().default('https://www.zohoapis.com'),
    ZOHO_ACCOUNTS_DOMAIN: z.string().default('https://accounts.zoho.com'),

    API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
    ADMIN_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
    PAYMENT_PUBLIC_URL: z.string().url().default('http://localhost:3001'),

    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    ENABLE_SCHEDULER: booleanish.default(true),
  })
  .superRefine((env, ctx) => {
    const require = (value: unknown, key: string, because: string) => {
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required ${because}`,
        });
      }
    };

    if (env.PAYMENT_GATEWAY_DRIVER === 'numbers') {
      require(env.NUMBERS_API_BASE_URL, 'NUMBERS_API_BASE_URL', 'when PAYMENT_GATEWAY_DRIVER=numbers');
      require(env.NUMBERS_API_KEY, 'NUMBERS_API_KEY', 'when PAYMENT_GATEWAY_DRIVER=numbers');
      require(env.NUMBERS_WEBHOOK_SECRET, 'NUMBERS_WEBHOOK_SECRET', 'when PAYMENT_GATEWAY_DRIVER=numbers');
    }
    if (env.ACCOUNTING_DRIVER === 'zoho') {
      require(env.ZOHO_CLIENT_ID, 'ZOHO_CLIENT_ID', 'when ACCOUNTING_DRIVER=zoho');
      require(env.ZOHO_CLIENT_SECRET, 'ZOHO_CLIENT_SECRET', 'when ACCOUNTING_DRIVER=zoho');
      require(env.ZOHO_REDIRECT_URI, 'ZOHO_REDIRECT_URI', 'when ACCOUNTING_DRIVER=zoho');
    }
    if (env.STORAGE_DRIVER === 's3') {
      require(env.S3_BUCKET, 'S3_BUCKET', 'when STORAGE_DRIVER=s3');
    }
    if (env.MAIL_DRIVER === 'postmark') {
      require(env.POSTMARK_SERVER_TOKEN, 'POSTMARK_SERVER_TOKEN', 'when MAIL_DRIVER=postmark');
    }

    // A fake adapter in production would silently swallow real money and real
    // customer email. Refuse to boot rather than discover it later.
    if (env.APP_ENV === 'production') {
      if (env.PAYMENT_GATEWAY_DRIVER === 'fake') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PAYMENT_GATEWAY_DRIVER'],
          message: 'the fake payment gateway must never run in production',
        });
      }
      if (env.MAIL_DRIVER === 'console') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_DRIVER'],
          message: 'the console mailer must never run in production',
        });
      }
      if (env.STORAGE_DRIVER === 'local') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STORAGE_DRIVER'],
          message: 'local disk storage must never run in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  loadEnv();
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached environment. */
export function resetEnvCache(): void {
  cached = null;
}

export const ENV = Symbol('ENV');
