import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Zod schema to validate required GitHub App and Reviewer environment variables.
 */
export const githubEnvSchema = z.object({
  GITHUB_APP_ID: z.string().min(1, 'GITHUB_APP_ID is required'),
  GITHUB_PRIVATE_KEY: z.string().min(1, 'GITHUB_PRIVATE_KEY is required'),
  GITHUB_WEBHOOK_SECRET: z.string().min(1, 'GITHUB_WEBHOOK_SECRET is required'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required').optional(),
  VIGILPR_MODEL: z.string().default('gpt-4o-mini'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection URL').optional(),
});

export type GitHubEnv = z.infer<typeof githubEnvSchema>;

/**
 * Zod schema specifically for the AI review engine.
 */
export const reviewerEnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  VIGILPR_MODEL: z.string().default('gpt-4o-mini'),
});

export type ReviewerEnv = z.infer<typeof reviewerEnvSchema>;

/**
 * Typed App instance configured with @octokit/rest.
 */
export type GitHubAppInstance = App<{ Octokit: typeof Octokit }>;

/**
 * Safely parse and format a PEM private key from environment variables.
 * Handles escaped literal '\n' sequences, surrounding quotes, and whitespace.
 */
export function formatPrivateKey(key: string): string {
  let cleaned = key.trim();
  // Strip enclosing quotes if present (e.g. from .env files)
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  // Replace escaped \n with actual newlines
  return cleaned.replace(/\\n/g, '\n');
}

/**
 * Validates and retrieves GitHub App environment variables.
 */
export function getGitHubEnv(): GitHubEnv {
  const result = githubEnvSchema.safeParse({
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    VIGILPR_MODEL: process.env.VIGILPR_MODEL,
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    throw new Error(`[VigilPR] Invalid GitHub App configuration: ${issues}`);
  }

  return result.data;
}

/**
 * Create a fresh GitHub App instance configured with @octokit/rest.
 */
export function createGitHubApp(): GitHubAppInstance {
  const env = getGitHubEnv();
  return new App({
    appId: env.GITHUB_APP_ID,
    privateKey: formatPrivateKey(env.GITHUB_PRIVATE_KEY),
    webhooks: {
      secret: env.GITHUB_WEBHOOK_SECRET,
    },
    Octokit: Octokit,
  });
}

// Lazy-loaded cached App instance
let cachedApp: GitHubAppInstance | null = null;

export function getGitHubApp(): GitHubAppInstance {
  if (!cachedApp) {
    cachedApp = createGitHubApp();
  }
  return cachedApp;
}

/**
 * GitHub App client proxy allowing direct usage like `app.getInstallationOctokit(id)`
 * while deferring environment evaluation until runtime.
 */
export const app = new Proxy({} as GitHubAppInstance, {
  get(_target, prop) {
    const instance = getGitHubApp();
    const value = Reflect.get(instance, prop);
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  },
});

/**
 * Constant-time HMAC-SHA256 signature verification against GITHUB_WEBHOOK_SECRET.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret?: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const webhookSecret = secret || process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[VigilPR] GITHUB_WEBHOOK_SECRET is not set in environment.');
    return false;
  }

  const receivedSignatureHex = signatureHeader.slice('sha256='.length);
  const hmac = crypto.createHmac('sha256', webhookSecret);
  hmac.update(rawBody, 'utf8');
  const expectedSignatureHex = hmac.digest('hex');

  const receivedBuffer = Buffer.from(receivedSignatureHex, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignatureHex, 'utf8');

  // crypto.timingSafeEqual requires buffers of identical length
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * Zod validation schema for incoming Pull Request webhook payloads.
 */
export const pullRequestPayloadSchema = z.object({
  action: z.string(),
  number: z.number().optional(),
  installation: z.object({
    id: z.number(),
  }),
  repository: z.object({
    name: z.string(),
    full_name: z.string(),
    owner: z.object({
      login: z.string(),
    }),
  }),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    user: z.object({
      login: z.string(),
    }),
    head: z.object({
      sha: z.string(),
      ref: z.string(),
    }),
    base: z.object({
      sha: z.string(),
      ref: z.string(),
    }),
    html_url: z.string().optional(),
  }),
});

export type PullRequestPayload = z.infer<typeof pullRequestPayloadSchema>;
