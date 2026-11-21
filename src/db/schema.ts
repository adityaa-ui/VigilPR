import { pgTable, serial, text, integer, timestamp } from 'drizzle-orm/pg-core';

/**
 * Stores every PR review execution with full metadata for observability.
 *
 * status values:
 *   'processing' – Inngest function has started, review in progress
 *   'completed'  – Review posted to GitHub successfully
 *   'skipped'    – No reviewable code files found (all filtered out)
 *   'failed'     – Unrecoverable error; errorMessage captures the reason
 */
export const prReviews = pgTable('pr_reviews', {
  id: serial('id').primaryKey(),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  pullNumber: integer('pull_number').notNull(),
  prTitle: text('pr_title').notNull(),
  prAuthor: text('pr_author').notNull(),
  commitSha: text('commit_sha').notNull(),
  action: text('action').notNull(), // 'opened' | 'synchronize'
  status: text('status').notNull(), // 'processing' | 'completed' | 'skipped' | 'failed'

  // AI review output (populated on completion)
  approvalRecommendation: text('approval_recommendation'), // 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  summary: text('summary'),
  githubReviewUrl: text('github_review_url'),

  // Statistics
  filesReviewedCount: integer('files_reviewed_count').default(0),
  commentsCount: integer('comments_count').default(0),

  // AI telemetry
  model: text('model'),
  promptTokens: integer('prompt_tokens').default(0),
  completionTokens: integer('completion_tokens').default(0),
  durationMs: integer('duration_ms'),

  // Error tracking
  errorMessage: text('error_message'),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

export type PrReview = typeof prReviews.$inferSelect;
export type NewPrReview = typeof prReviews.$inferInsert;

/**
 * Stores individual inline review comments linked to a pr_reviews row.
 * Cascade-deleted when the parent pr_reviews row is removed.
 */
export const reviewComments = pgTable('review_comments', {
  id: serial('id').primaryKey(),
  reviewId: integer('review_id')
    .notNull()
    .references(() => prReviews.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
  line: integer('line').notNull(),
  severity: text('severity').notNull(), // 'critical' | 'warning' | 'suggestion'
  category: text('category').notNull(), // 'bug' | 'security' | 'performance' | 'maintainability'
  comment: text('comment').notNull(),
  suggestedCode: text('suggested_code'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type ReviewCommentRow = typeof reviewComments.$inferSelect;
export type NewReviewComment = typeof reviewComments.$inferInsert;
