import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import type { FilteredFileDiff } from './diff';

/**
 * Strict schema for individual line-specific code review comments.
 */
export const reviewCommentSchema = z.object({
  path: z.string().describe('Exact relative file path matching the diff'),
  line: z
    .number()
    .int()
    .describe('Line number corresponding to an [L<number>] line on the RIGHT side of the diff'),
  severity: z
    .enum(['critical', 'warning', 'suggestion'])
    .describe('Severity level of the issue'),
  category: z
    .enum(['bug', 'security', 'performance', 'maintainability'])
    .describe('Classification of the issue'),
  comment: z
    .string()
    .describe('Concise, actionable explanation of the issue and why it matters'),
  suggestedCode: z
    .string()
    .optional()
    .describe('Clean replacement code snippet without markdown fences, if applicable'),
});

export type ReviewComment = z.infer<typeof reviewCommentSchema>;

/**
 * Strict schema for the overall pull request review result.
 */
export const prReviewResultSchema = z.object({
  summary: z
    .string()
    .describe('2–4 sentence high-level assessment of the PR changes'),
  approvalRecommendation: z
    .enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
    .describe('Overall approval recommendation for this pull request'),
  comments: z
    .array(reviewCommentSchema)
    .describe('List of line-specific review comments'),
});

export type PRReviewResult = z.infer<typeof prReviewResultSchema>;

/**
 * Focused senior engineer system prompt enforcing high signal and line number fidelity.
 */
const SYSTEM_PROMPT = `You are VigilPR, an expert Principal Security Engineer and Senior Code Reviewer.
Your role is to perform rigorous, high-signal, zero-noise code reviews and security audits on incoming GitHub Pull Requests.

CRITICAL INSTRUCTIONS:
1. Signal-to-Noise Ratio:
   - Focus exclusively on real bugs, security vulnerabilities (e.g., injection, authorization flaws, hardcoded secrets, SSRF, memory leaks, race conditions), performance bottlenecks, and dangerous edge cases.
   - DO NOT comment on style, formatting, whitespace, or minor naming conventions unless they cause bugs.

2. Line Numbering Rules (STRICT):
   - Every reviewable line in the diff is explicitly annotated with [L<number>], which indicates its exact new-file (RIGHT-side) line number.
   - Lines prefixed with [DEL] are deleted lines from the old file. NEVER cite or comment on [DEL] lines because GitHub cannot attach review comments to deleted lines.
   - You MUST ONLY cite line numbers that appear with [L<number>] in the provided diff. Citing any line number not marked with [L<number>] will break the review.

3. Suggested Code:
   - When suggesting a fix, provide ONLY the raw replacement code snippet for the cited line(s) in \`suggestedCode\`. Do NOT wrap it in markdown code blocks (\`\`\`).

4. Approval Recommendations:
   - APPROVE: The code is solid, safe, and bug-free (return an empty comments array []).
   - REQUEST_CHANGES: Critical bugs, security flaws, or breaking regressions are present.
   - COMMENT: Non-critical warnings, performance improvements, or suggestions are present.

5. Solid Code:
   - If the changes are well-engineered, safe, and free of defects, return an empty comments array ([]) and recommend APPROVE. Do not invent speculative issues.`;

/**
 * Post-LLM Line Validation:
 * Validates comments against the file map and validRightLines set.
 * Drops any comment pointing to non-existent file paths or invalid lines,
 * preventing GitHub API 422 Unprocessable Entity errors.
 */
export function validateAndFilterReviewComments(
  comments: ReviewComment[],
  files: FilteredFileDiff[]
): ReviewComment[] {
  const fileMap = new Map<string, FilteredFileDiff>();
  for (const file of files) {
    fileMap.set(file.filename, file);
  }

  const validComments: ReviewComment[] = [];

  for (const comment of comments) {
    const file = fileMap.get(comment.path);
    if (!file) {
      console.warn(
        `[VigilPR] Dropping comment: file path "${comment.path}" does not exist in reviewable diffs.`
      );
      continue;
    }

    if (!file.validRightLines.has(comment.line)) {
      console.warn(
        `[VigilPR] Dropping comment on "${comment.path}:${comment.line}": line ${comment.line} is not a valid commentable RIGHT-side line.`
      );
      continue;
    }

    validComments.push(comment);
  }

  return validComments;
}

export interface GeneratePRReviewParams {
  prTitle: string;
  prBody: string | null;
  files: FilteredFileDiff[];
  model?: string;
  apiKey?: string;
}

/**
 * Usage and latency telemetry returned alongside the review result.
 */
export interface ReviewUsage {
  promptTokens: number;
  completionTokens: number;
  model: string;
}

/**
 * Combined result returned by generatePRReview including AI telemetry.
 */
export interface GeneratePRReviewResult {
  review: PRReviewResult;
  usage: ReviewUsage;
  durationMs: number;
}

/**
 * Generates structured AI review feedback for a pull request using Vercel AI SDK.
 * Returns the review result alongside token usage and wall-clock latency.
 */
export async function generatePRReview(
  params: GeneratePRReviewParams
): Promise<GeneratePRReviewResult> {
  const { prTitle, prBody, files, model: customModel, apiKey } = params;

  const modelName = customModel || process.env.VIGILPR_MODEL || 'gpt-4o-mini';

  if (files.length === 0) {
    return {
      review: {
        summary: 'No reviewable code files found in this pull request.',
        approvalRecommendation: 'APPROVE',
        comments: [],
      },
      usage: { promptTokens: 0, completionTokens: 0, model: modelName },
      durationMs: 0,
    };
  }

  const resolvedApiKey = apiKey || process.env.OPENAI_API_KEY;
  if (!resolvedApiKey) {
    throw new Error('[VigilPR] OPENAI_API_KEY is not configured in the environment.');
  }

  const openai = createOpenAI({ apiKey: resolvedApiKey });

  const diffContents = files
    .map(
      (f) =>
        `### File: ${f.filename} (${f.status})\nAdditions: +${f.additions} | Deletions: -${f.deletions}\nAnnotated Diff:\n${f.annotatedPatch}`
    )
    .join('\n\n');

  const userPrompt = [
    `# Pull Request Information`,
    `**Title**: ${prTitle}`,
    `**Description**: ${prBody?.trim() ? prBody : 'No description provided.'}`,
    ``,
    `# Changes to Review`,
    diffContents,
  ].join('\n');

  const startMs = Date.now();

  const { object: rawResult, usage } = await generateObject({
    model: openai(modelName),
    schema: prReviewResultSchema,
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  const durationMs = Date.now() - startMs;

  // AI SDK v7 uses inputTokens / outputTokens
  const promptTokens = usage?.inputTokens ?? 0;
  const completionTokens = usage?.outputTokens ?? 0;

  // Post-LLM Line Validation: Filter out any hallucinated lines or non-existent files
  const validatedComments = validateAndFilterReviewComments(rawResult.comments, files);

  let recommendation = rawResult.approvalRecommendation;
  if (validatedComments.length === 0 && recommendation === 'REQUEST_CHANGES') {
    recommendation = 'APPROVE';
  }

  return {
    review: {
      summary: rawResult.summary,
      approvalRecommendation: recommendation,
      comments: validatedComments,
    },
    usage: { promptTokens, completionTokens, model: modelName },
    durationMs,
  };
}
