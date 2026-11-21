import { inngest } from '../client';
import { app } from '@/lib/github';
import { prepareDiffsForReview, type FilteredFileDiff } from '@/lib/diff';
import {
  generatePRReview,
  type PRReviewResult,
  type GeneratePRReviewResult,
} from '@/lib/reviewer';
import { postPullRequestReview, type PostReviewResult } from '@/lib/github-review';
import { db } from '@/db';
import { prReviews, reviewComments } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * JSON-serializable representation of FilteredFileDiff for Inngest step output.
 * Set<number> must be serialized to number[] since Inngest step outputs must be JSON-serializable.
 */
export interface SerializedFileDiff {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  annotatedPatch: string;
  validRightLines: number[];
}

/**
 * Durable Inngest function for reviewing GitHub Pull Requests with full DB persistence.
 *
 * Key features:
 * - Idempotency: Deduplicates webhook deliveries for the same commit SHA.
 * - Auto-cancellation: Stale reviews for older commits are cancelled when a new commit is pushed.
 * - Concurrency limit: Prevents LLM and GitHub rate-limit spikes.
 * - Discrete retryable steps: Each stage (DB record, diff fetch, AI review, GitHub post, DB save)
 *   is independently retried on failure.
 * - Full telemetry: Token usage, latency, file count, comments, and GitHub review URL persisted.
 * - Failure tracking: onFailure handler marks the DB row as 'failed' with errorMessage.
 *
 * NOTE: Inngest v4 uses a 2-argument createFunction signature:
 *   createFunction(options, handler)
 * where `triggers` is supplied via `options.triggers` instead of a separate second argument.
 */
export const reviewPullRequest = inngest.createFunction(
  {
    id: 'review-pull-request',
    name: 'Review Pull Request',
    triggers: [{ event: 'vigilpr/pr.review.requested' as const }],
    idempotency:
      'event.data.owner + "/" + event.data.repo + "#" + event.data.pullNumber + "@" + event.data.commitSha',
    cancelOn: [
      {
        event: 'vigilpr/pr.review.requested',
        match: 'data.prKey',
      },
    ],
    concurrency: {
      limit: 5,
    },
    onFailure: async ({ event, error }) => {
      // Mark the DB row as 'failed' and record the error message.
      // The reviewId is passed through event.data so we can find the row even after a crash.
      const data = event.data as { reviewId?: number };
      if (!data.reviewId) return;

      try {
        await db
          .update(prReviews)
          .set({
            status: 'failed',
            errorMessage: error instanceof Error ? error.message : String(error),
            completedAt: new Date(),
          })
          .where(eq(prReviews.id, data.reviewId));
        console.log(`[VigilPR] Marked review #${data.reviewId} as failed in DB.`);
      } catch (dbErr) {
        console.error('[VigilPR] Failed to update DB on function failure:', dbErr);
      }
    },
  },
  async ({ event, step }: { event: { data: Record<string, unknown> }; step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> } }) => {
    const data = event.data as {
      installationId: number;
      owner: string;
      repo: string;
      pullNumber: number;
      commitSha: string;
      prTitle: string;
      prBody: string | null;
      prAuthor: string;
      action: string;
      prKey: string;
    };

    const { installationId, owner, repo, pullNumber, commitSha, prTitle, prBody, prAuthor, action } = data;

    // -------------------------------------------------------------------------
    // Step 0: Create a 'processing' row in pr_reviews for idempotency + telemetry
    // -------------------------------------------------------------------------
    const reviewId: number = await step.run('create-review-record', async () => {
      const [row] = await db
        .insert(prReviews)
        .values({
          owner,
          repo,
          pullNumber,
          prTitle,
          prAuthor: prAuthor ?? 'unknown',
          commitSha,
          action: action ?? 'opened',
          status: 'processing',
        })
        .returning({ id: prReviews.id });

      console.log(`[VigilPR] Created DB review record #${row.id} for ${owner}/${repo}#${pullNumber}`);
      return row.id;
    });

    // -------------------------------------------------------------------------
    // Step 1: Fetch changed files and prepare diffs
    // validRightLines: Set<number> is serialized to number[] for JSON transport compatibility
    // -------------------------------------------------------------------------
    const serializedFiles: SerializedFileDiff[] = await step.run(
      'fetch-and-prepare-diffs',
      async () => {
        const octokit = await app.getInstallationOctokit(installationId);
        const { data: files } = await octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number: pullNumber,
          per_page: 100,
        });

        const prepared = prepareDiffsForReview(files);

        return prepared.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          annotatedPatch: f.annotatedPatch,
          validRightLines: Array.from(f.validRightLines),
        }));
      }
    );

    // If no code changes are reviewable (e.g. only lockfiles or images), mark skipped and stop
    if (serializedFiles.length === 0) {
      await db
        .update(prReviews)
        .set({ status: 'skipped', completedAt: new Date() })
        .where(eq(prReviews.id, reviewId));

      console.log(`[VigilPR] Skipped review #${reviewId}: no reviewable files after filtering.`);
      return {
        status: 'skipped',
        reviewId,
        reason: 'No reviewable code files found after filtering.',
      };
    }

    // -------------------------------------------------------------------------
    // Step 2: Generate AI review using LLM (returns review + usage + latency)
    // -------------------------------------------------------------------------
    const aiResult: GeneratePRReviewResult = await step.run(
      'generate-ai-review',
      async () => {
        // Reconstruct Set<number> from serialized number[]
        const filesForReview: FilteredFileDiff[] = serializedFiles.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          annotatedPatch: f.annotatedPatch,
          validRightLines: new Set<number>(f.validRightLines),
        }));

        return await generatePRReview({
          prTitle,
          prBody,
          files: filesForReview,
        });
      }
    );

    // -------------------------------------------------------------------------
    // Step 3: Post the formatted batched review and inline comments to GitHub
    // -------------------------------------------------------------------------
    const postedResult: PostReviewResult = await step.run(
      'post-github-review',
      async () => {
        const octokit = await app.getInstallationOctokit(installationId);
        return await postPullRequestReview({
          octokit,
          owner,
          repo,
          pullNumber,
          commitSha,
          review: aiResult.review,
        });
      }
    );

    // -------------------------------------------------------------------------
    // Step 4: Persist review results and inline comments to DB
    // -------------------------------------------------------------------------
    await step.run('save-review-results', async () => {
      const reviewResult: PRReviewResult = aiResult.review;

      // Update the pr_reviews row with all telemetry and outcome data
      await db
        .update(prReviews)
        .set({
          status: 'completed',
          approvalRecommendation: reviewResult.approvalRecommendation,
          summary: reviewResult.summary,
          githubReviewUrl: postedResult.htmlUrl,
          filesReviewedCount: serializedFiles.length,
          commentsCount: postedResult.commentsCount,
          model: aiResult.usage.model,
          promptTokens: aiResult.usage.promptTokens,
          completionTokens: aiResult.usage.completionTokens,
          durationMs: aiResult.durationMs,
          completedAt: new Date(),
        })
        .where(eq(prReviews.id, reviewId));

      // Batch-insert all validated inline comments
      if (reviewResult.comments.length > 0) {
        await db.insert(reviewComments).values(
          reviewResult.comments.map((c) => ({
            reviewId,
            filePath: c.path,
            line: c.line,
            severity: c.severity,
            category: c.category,
            comment: c.comment,
            suggestedCode: c.suggestedCode ?? null,
          }))
        );
      }

      console.log(
        `[VigilPR] Saved review #${reviewId}: ${reviewResult.approvalRecommendation}, ` +
          `${reviewResult.comments.length} comments, ${aiResult.usage.promptTokens + aiResult.usage.completionTokens} tokens, ` +
          `${aiResult.durationMs}ms`
      );
    });

    return {
      status: 'completed',
      reviewId,
      postedReviewId: postedResult.id,
      htmlUrl: postedResult.htmlUrl,
      event: postedResult.event,
      commentsCount: postedResult.commentsCount,
      durationMs: aiResult.durationMs,
      tokens: aiResult.usage.promptTokens + aiResult.usage.completionTokens,
    };
  }
);
