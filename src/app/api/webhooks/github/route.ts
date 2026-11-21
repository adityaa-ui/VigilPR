import { NextRequest, NextResponse } from 'next/server';
import {
  pullRequestPayloadSchema,
  verifyWebhookSignature,
} from '@/lib/github';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Health check endpoint for checking webhook route availability.
 */
export async function GET() {
  return NextResponse.json({
    service: 'VigilPR Webhook Ingestion API',
    status: 'active',
    endpoint: '/api/webhooks/github',
    supportedEvents: ['pull_request (actions: opened, synchronize)'],
    mode: 'asynchronous (inngest)',
  });
}

/**
 * Ingestion handler for GitHub Webhook POST events.
 * Immediately verifies signatures, validates payloads, dispatches background
 * durable execution to Inngest, and responds with 202 Accepted.
 */
export async function POST(req: NextRequest) {
  try {
    // 1. Read the raw text before any JSON parsing so signature verification never breaks
    const rawBody = await req.text();

    // 2. Verify the x-hub-signature-256 header using HMAC-SHA256 & timingSafeEqual
    const signatureHeader = req.headers.get('x-hub-signature-256');
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!secret) {
      console.error('[VigilPR] GITHUB_WEBHOOK_SECRET is not configured in the environment.');
      return NextResponse.json(
        { error: 'Server configuration error: missing webhook secret' },
        { status: 500 }
      );
    }

    const isValidSignature = verifyWebhookSignature(rawBody, signatureHeader, secret);
    if (!isValidSignature) {
      console.warn('[VigilPR] Unauthorized webhook request: Invalid x-hub-signature-256 header.');
      return NextResponse.json(
        { error: 'Unauthorized: Invalid signature' },
        { status: 401 }
      );
    }

    // 3. Inspect GitHub event header
    const githubEvent = req.headers.get('x-github-event');
    if (githubEvent !== 'pull_request') {
      return NextResponse.json(
        { message: `Event '${githubEvent}' ignored. VigilPR only processes 'pull_request' events.` },
        { status: 200 }
      );
    }

    // 4. Parse JSON payload
    let jsonBody: unknown;
    try {
      jsonBody = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: 'Bad Request: Malformed JSON payload' },
        { status: 400 }
      );
    }

    // 5. Filter pull_request action: only process 'opened' or 'synchronize'
    const action = (jsonBody as { action?: string })?.action;
    if (action !== 'opened' && action !== 'synchronize') {
      return NextResponse.json(
        {
          message: `Ignored pull_request action '${action}'. Only 'opened' and 'synchronize' are processed.`,
        },
        { status: 200 }
      );
    }

    // 6. Validate payload structure using Zod
    const parseResult = pullRequestPayloadSchema.safeParse(jsonBody);
    if (!parseResult.success) {
      console.warn('[VigilPR] Invalid pull_request payload schema:', parseResult.error.flatten());
      return NextResponse.json(
        {
          error: 'Bad Request: Incompatible pull_request payload structure',
          details: parseResult.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const payload = parseResult.data;
    const { installation, repository, pull_request } = payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pull_request.number;
    const commitSha = pull_request.head.sha;
    const prTitle = pull_request.title;
    const prBody = pull_request.body ?? null;
    const prAuthor = pull_request.user.login;
    const prKey = `${owner}/${repo}#${pullNumber}`;

    console.log('\n============================================================');
    console.log(' [VigilPR] Webhook Ingested -> Dispatching to Inngest');
    console.log('============================================================');
    console.log(`PR Key:       ${prKey}`);
    console.log(`Action:       ${action}`);
    console.log(`Title:        ${prTitle}`);
    console.log(`Author:       ${pull_request.user.login}`);
    console.log(`Commit SHA:   ${commitSha}`);
    console.log(`Installation: ${installation.id}`);
    console.log('============================================================\n');

    // 7. Emit Inngest background event
    await inngest.send({
      name: 'vigilpr/pr.review.requested',
      data: {
        installationId: installation.id,
        owner,
        repo,
        pullNumber,
        commitSha,
        prTitle,
        prBody,
        prAuthor,
        action,
        prKey,
      },
    });

    // 8. Immediately return 202 Accepted to prevent GitHub webhook timeout
    return NextResponse.json(
      {
        status: 'queued',
        message: `Review job queued for PR #${pullNumber} (${action})`,
        prKey,
        commitSha,
      },
      { status: 202 }
    );
  } catch (error) {
    console.error('[VigilPR] Error handling GitHub webhook:', error);
    return NextResponse.json(
      {
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
