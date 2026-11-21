import assert from 'node:assert';
import crypto from 'node:crypto';
import {
  formatPrivateKey,
  verifyWebhookSignature,
  githubEnvSchema,
  reviewerEnvSchema,
  pullRequestPayloadSchema,
} from '../src/lib/github.ts';
import {
  shouldIgnoreFile,
  parseAndAnnotatePatch,
  prepareDiffsForReview,
} from '../src/lib/diff.ts';
import {
  reviewCommentSchema,
  prReviewResultSchema,
  validateAndFilterReviewComments,
} from '../src/lib/reviewer.ts';
import {
  formatReviewCommentBody,
  formatReviewSummaryBody,
  postPullRequestReview,
} from '../src/lib/github-review.ts';

async function runTests() {
  console.log('🧪 [Test Suite] Running VigilPR Pipeline Unit Tests...\n');

  // --------------------------------------------------------------------------
  // Test 1: formatPrivateKey
  // --------------------------------------------------------------------------
  console.log('Test 1: formatPrivateKey handles escaped newlines and quotes');
  const escapedKey = '"-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA...\\n-----END RSA PRIVATE KEY-----"';
  const formattedKey = formatPrivateKey(escapedKey);
  assert.strictEqual(
    formattedKey,
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
    'Escaped newlines and surrounding quotes should be normalized'
  );
  console.log('  ✓ Escaped key normalized correctly');

  // --------------------------------------------------------------------------
  // Test 2: verifyWebhookSignature
  // --------------------------------------------------------------------------
  console.log('\nTest 2: verifyWebhookSignature validates HMAC-SHA256');
  const testSecret = 'vigilpr-super-secret-test-key';
  const payloadStr = JSON.stringify({ action: 'opened', test: true });

  const validHmac = crypto.createHmac('sha256', testSecret).update(payloadStr, 'utf8').digest('hex');
  const validHeader = `sha256=${validHmac}`;

  assert.strictEqual(
    verifyWebhookSignature(payloadStr, validHeader, testSecret),
    true,
    'Valid signature must return true'
  );
  console.log('  ✓ Valid HMAC signature passes');

  assert.strictEqual(
    verifyWebhookSignature(payloadStr, 'sha256=invalidhex1234567890abcdef', testSecret),
    false,
    'Invalid signature must return false'
  );
  console.log('  ✓ Invalid signature rejected');

  assert.strictEqual(
    verifyWebhookSignature(payloadStr + 'tampered', validHeader, testSecret),
    false,
    'Tampered payload must return false'
  );
  console.log('  ✓ Tampered payload rejected');

  assert.strictEqual(
    verifyWebhookSignature(payloadStr, null, testSecret),
    false,
    'Missing header must return false'
  );
  console.log('  ✓ Missing header rejected');

  assert.strictEqual(
    verifyWebhookSignature(payloadStr, `sha1=${validHmac}`, testSecret),
    false,
    'Non-sha256 header must return false'
  );
  console.log('  ✓ Non-sha256 prefix rejected');

  // --------------------------------------------------------------------------
  // Test 3: Zod Schema Validations
  // --------------------------------------------------------------------------
  console.log('\nTest 3: Environment and Payload Zod schemas');
  const validEnv = {
    GITHUB_APP_ID: '123456',
    GITHUB_PRIVATE_KEY: 'test-private-key',
    GITHUB_WEBHOOK_SECRET: 'test-secret',
    OPENAI_API_KEY: 'sk-test-openai-key',
  };
  const envParsed = githubEnvSchema.safeParse(validEnv);
  assert.strictEqual(envParsed.success, true, 'Valid env schema should succeed');
  console.log('  ✓ GitHub App environment schema validates properly');

  const reviewerEnvParsed = reviewerEnvSchema.safeParse({
    OPENAI_API_KEY: 'sk-test-key',
    VIGILPR_MODEL: 'gpt-4o-mini',
  });
  assert.strictEqual(reviewerEnvParsed.success, true);
  console.log('  ✓ Reviewer environment schema validates properly');

  const invalidEnv = {
    GITHUB_APP_ID: '',
    GITHUB_PRIVATE_KEY: '',
    GITHUB_WEBHOOK_SECRET: '',
  };
  const envInvalidParsed = githubEnvSchema.safeParse(invalidEnv);
  assert.strictEqual(envInvalidParsed.success, false, 'Invalid env schema should fail');
  console.log('  ✓ Empty environment variables rejected by Zod');

  const samplePrPayload = {
    action: 'opened',
    number: 42,
    installation: { id: 98765 },
    repository: {
      name: 'vigilpr-test',
      full_name: 'acme/vigilpr-test',
      owner: { login: 'acme' },
    },
    pull_request: {
      number: 42,
      title: 'Security audit test PR',
      body: 'Testing pull request review body extraction',
      user: { login: 'security-researcher' },
      head: { sha: 'abc1234', ref: 'feature/patch-1' },
      base: { sha: 'def5678', ref: 'main' },
    },
  };
  const prParsed = pullRequestPayloadSchema.safeParse(samplePrPayload);
  assert.strictEqual(prParsed.success, true, 'Valid PR payload should succeed');
  assert.strictEqual(prParsed.data.pull_request.body, 'Testing pull request review body extraction');
  console.log('  ✓ Pull request payload schema validates properly (including body)');

  const invalidPrPayload = {
    action: 'opened',
    pull_request: { number: 42 },
  };
  const invalidPrParsed = pullRequestPayloadSchema.safeParse(invalidPrPayload);
  assert.strictEqual(invalidPrParsed.success, false, 'Malformed payload should fail Zod check');
  console.log('  ✓ Malformed PR payload rejected by Zod');

  // --------------------------------------------------------------------------
  // Test 4: Diff Filtering - shouldIgnoreFile
  // --------------------------------------------------------------------------
  console.log('\nTest 4: shouldIgnoreFile filters non-code, noise, and artifacts');

  // Lockfiles
  const lockfiles = [
    'package-lock.json',
    'packages/web/package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
    'Cargo.lock',
    'Gemfile.lock',
    'poetry.lock',
    'go.sum',
  ];
  for (const file of lockfiles) {
    assert.strictEqual(
      shouldIgnoreFile({ filename: file, status: 'modified', additions: 10, deletions: 10, patch: '@@ -1 +1 @@' }),
      true,
      `Lockfile ${file} must be ignored`
    );
  }
  console.log('  ✓ Lockfiles correctly ignored');

  // Build directories
  const buildFiles = [
    'dist/index.js',
    'packages/ui/build/bundle.js',
    '.next/static/chunks/main.js',
    'coverage/lcov-report/index.html',
  ];
  for (const file of buildFiles) {
    assert.strictEqual(
      shouldIgnoreFile({ filename: file, status: 'added', additions: 5, deletions: 0, patch: '@@ -0,0 +1 @@' }),
      true,
      `Build artifact ${file} must be ignored`
    );
  }
  console.log('  ✓ Build artifact directories (dist, build, .next, coverage) correctly ignored');

  // Minified files and sourcemaps
  const minFiles = ['public/bundle.min.js', 'styles/theme.min.css', 'dist/app.js.map'];
  for (const file of minFiles) {
    assert.strictEqual(
      shouldIgnoreFile({ filename: file, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@' }),
      true,
      `Minified / map asset ${file} must be ignored`
    );
  }
  console.log('  ✓ Minified assets and source maps correctly ignored');

  // Images and Fonts
  const mediaFiles = ['logo.svg', 'avatar.png', 'hero.jpg', 'icon.ico', 'inter.woff2', 'roboto.ttf'];
  for (const file of mediaFiles) {
    assert.strictEqual(
      shouldIgnoreFile({ filename: file, status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@' }),
      true,
      `Media/font ${file} must be ignored`
    );
  }
  console.log('  ✓ Images and fonts correctly ignored');

  // Removed files and missing patch
  assert.strictEqual(
    shouldIgnoreFile({ filename: 'src/deleted.ts', status: 'removed', additions: 0, deletions: 50, patch: '@@ -1,5 +0,0 @@' }),
    true,
    'Removed files must be ignored'
  );
  assert.strictEqual(
    shouldIgnoreFile({ filename: 'src/binary.bin', status: 'modified', additions: 0, deletions: 0, patch: undefined }),
    true,
    'Files with undefined patch must be ignored'
  );
  assert.strictEqual(
    shouldIgnoreFile({ filename: 'src/oversized.ts', status: 'modified', additions: 10, deletions: 10, patch: '   ' }),
    true,
    'Files with blank patch must be ignored'
  );
  console.log('  ✓ Removed, binary, and empty patch files correctly ignored');

  // Valid source code files should NOT be ignored
  const validFiles = [
    'src/lib/auth.ts',
    'src/components/Header.tsx',
    'backend/services/payment.py',
    'pkg/crypto/token.go',
    'scripts/deploy.sh',
  ];
  for (const file of validFiles) {
    assert.strictEqual(
      shouldIgnoreFile({ filename: file, status: 'modified', additions: 20, deletions: 5, patch: '@@ -10,3 +10,4 @@' }),
      false,
      `Valid source file ${file} should NOT be ignored`
    );
  }
  console.log('  ✓ Valid source code files are preserved for review');

  // --------------------------------------------------------------------------
  // Test 5: parseAndAnnotatePatch - Line Numbering & Diff Hunk Tracking
  // --------------------------------------------------------------------------
  console.log('\nTest 5: parseAndAnnotatePatch maps exact RIGHT-side line numbers');

  const samplePatch = [
    '@@ -15,7 +20,8 @@ export function authenticateUser(token: string) {',
    '   const decoded = verifyToken(token);',
    '-  if (!decoded) {',
    '-    throw new Error("Invalid token");',
    '-  }',
    '+  if (!decoded || !decoded.userId) {',
    '+    logger.warn("Security rejection: missing userId");',
    '+    throw new SecurityError("Invalid or incomplete credentials");',
    '+  }',
    '   return decoded;',
    ' }',
    '\\ No newline at end of file',
  ].join('\n');

  const { annotatedPatch, validRightLines } = parseAndAnnotatePatch(samplePatch);

  const expectedRightLines = new Set([20, 21, 22, 23, 24, 25, 26]);
  assert.deepStrictEqual(
    validRightLines,
    expectedRightLines,
    'validRightLines must strictly match expected RIGHT-side numbers'
  );
  console.log('  ✓ validRightLines matches exact RIGHT-side line numbers (20..26)');

  const annotatedLines = annotatedPatch.split('\n');
  assert.strictEqual(annotatedLines[0], '@@ -15,7 +20,8 @@ export function authenticateUser(token: string) {');
  assert.strictEqual(annotatedLines[1], '[L20]    const decoded = verifyToken(token);');
  assert.strictEqual(annotatedLines[2], '[DEL] -  if (!decoded) {');
  assert.strictEqual(annotatedLines[3], '[DEL] -    throw new Error("Invalid token");');
  assert.strictEqual(annotatedLines[4], '[DEL] -  }');
  assert.strictEqual(annotatedLines[5], '[L21] +  if (!decoded || !decoded.userId) {');
  assert.strictEqual(annotatedLines[6], '[L22] +    logger.warn("Security rejection: missing userId");');
  assert.strictEqual(annotatedLines[7], '[L23] +    throw new SecurityError("Invalid or incomplete credentials");');
  assert.strictEqual(annotatedLines[8], '[L24] +  }');
  assert.strictEqual(annotatedLines[9], '[L25]    return decoded;');
  assert.strictEqual(annotatedLines[10], '[L26]  }');
  assert.strictEqual(annotatedLines[11], '\\ No newline at end of file');

  console.log('  ✓ annotatedPatch accurately formatted with [L#] and [DEL] prefixes');

  // --------------------------------------------------------------------------
  // Test 6: prepareDiffsForReview - Batch processing & Capping
  // --------------------------------------------------------------------------
  console.log('\nTest 6: prepareDiffsForReview filters, annotates, and caps files');

  const mockFiles = [
    { filename: 'package-lock.json', status: 'modified', additions: 100, deletions: 50, patch: '@@ -1,5 +1,5 @@' },
    { filename: 'src/auth.ts', status: 'modified', additions: 5, deletions: 3, patch: samplePatch },
    { filename: 'dist/app.js', status: 'added', additions: 200, deletions: 0, patch: '@@ -0,0 +1,10 @@' },
    { filename: 'src/deleted.ts', status: 'removed', additions: 0, deletions: 40, patch: '@@ -1,5 +0,0 @@' },
    { filename: 'src/utils.ts', status: 'added', additions: 2, deletions: 0, patch: '@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;' },
  ];

  const prepared = prepareDiffsForReview(mockFiles, 1);
  assert.strictEqual(prepared.length, 1, 'Must cap results at maxFiles = 1');
  assert.strictEqual(prepared[0].filename, 'src/auth.ts');
  assert.strictEqual(prepared[0].validRightLines.size, 7);

  const preparedAll = prepareDiffsForReview(mockFiles, 10);
  assert.strictEqual(preparedAll.length, 2, 'Must include only the 2 valid source files');
  assert.strictEqual(preparedAll[0].filename, 'src/auth.ts');
  assert.strictEqual(preparedAll[1].filename, 'src/utils.ts');
  assert.strictEqual(preparedAll[1].validRightLines.size, 2);

  console.log('  ✓ prepareDiffsForReview correctly filters and caps reviewable diffs');

  // --------------------------------------------------------------------------
  // Test 7: AI Review Schemas & Post-LLM Line Validation (Crucial)
  // --------------------------------------------------------------------------
  console.log('\nTest 7: AI Review Schemas & Post-LLM Line Validation (Crucial)');

  const sampleComment = {
    path: 'src/auth.ts',
    line: 23,
    severity: 'critical',
    category: 'security',
    comment: 'Validate credentials securely before proceeding.',
    suggestedCode: 'throw new SecurityError("Invalid credentials");',
  };
  const commentParsed = reviewCommentSchema.safeParse(sampleComment);
  assert.strictEqual(commentParsed.success, true);
  console.log('  ✓ reviewCommentSchema validates correctly');

  const sampleReview = {
    summary: 'The pull request introduces security checks to token validation. Looks great overall.',
    approvalRecommendation: 'REQUEST_CHANGES',
    comments: [sampleComment],
  };
  const reviewParsed = prReviewResultSchema.safeParse(sampleReview);
  assert.strictEqual(reviewParsed.success, true);
  console.log('  ✓ prReviewResultSchema validates correctly');

  const reviewableFiles = preparedAll; // contains src/auth.ts (lines 20..26) and src/utils.ts (lines 1..2)

  const candidateComments = [
    {
      path: 'src/auth.ts',
      line: 21,
      severity: 'critical',
      category: 'security',
      comment: 'Check token validity.',
    },
    {
      path: 'src/utils.ts',
      line: 2,
      severity: 'suggestion',
      category: 'maintainability',
      comment: 'Export constant nicely.',
    },
    {
      path: 'src/nonexistent.ts',
      line: 5,
      severity: 'warning',
      category: 'bug',
      comment: 'This file does not exist in the PR.',
    },
    {
      path: 'src/auth.ts',
      line: 99,
      severity: 'critical',
      category: 'bug',
      comment: 'Line 99 does not exist in the diff hunks.',
    },
    {
      path: 'src/auth.ts',
      line: -1,
      severity: 'warning',
      category: 'bug',
      comment: 'Invalid negative line.',
    },
  ];

  const validatedComments = validateAndFilterReviewComments(candidateComments, reviewableFiles);

  assert.strictEqual(validatedComments.length, 2, 'Must filter out 3 invalid comments and keep exactly 2');
  assert.strictEqual(validatedComments[0].path, 'src/auth.ts');
  assert.strictEqual(validatedComments[0].line, 21);
  assert.strictEqual(validatedComments[1].path, 'src/utils.ts');
  assert.strictEqual(validatedComments[1].line, 2);

  console.log('  ✓ Post-LLM validation successfully preserved valid comments and stripped invalid/hallucinated lines');

  // --------------------------------------------------------------------------
  // Test 8: GitHub Review Comment & Summary Formatting
  // --------------------------------------------------------------------------
  console.log('\nTest 8: GitHub Review Comment & Summary Formatting');

  // 1. Comment with suggestedCode
  const commentWithSuggestion = {
    path: 'src/auth.ts',
    line: 25,
    severity: 'critical',
    category: 'security',
    comment: 'SQL Injection vulnerability detected in query string.',
    suggestedCode: 'const user = await db.query("SELECT * FROM users WHERE id = $1", [userId]);',
  };
  const formattedWithSuggestion = formatReviewCommentBody(commentWithSuggestion);
  assert.match(
    formattedWithSuggestion,
    /\*\*\[CRITICAL \| SECURITY\]\*\*/,
    'Must include severity and category badge'
  );
  assert.match(
    formattedWithSuggestion,
    /SQL Injection vulnerability detected/,
    'Must include the explanation'
  );
  assert.match(
    formattedWithSuggestion,
    /```suggestion\r?\nconst user = await db\.query\("SELECT \* FROM users WHERE id = \$1", \[userId\]\);\r?\n```/,
    'Must append native GitHub ```suggestion block'
  );
  console.log('  ✓ formatReviewCommentBody renders badge and ```suggestion block with code');

  // 2. Comment without suggestedCode
  const commentWithoutSuggestion = {
    path: 'src/utils.ts',
    line: 10,
    severity: 'warning',
    category: 'bug',
    comment: 'Division by zero possible when count is 0.',
  };
  const formattedWithoutSuggestion = formatReviewCommentBody(commentWithoutSuggestion);
  assert.match(formattedWithoutSuggestion, /\*\*\[WARNING \| BUG\]\*\*/);
  assert.strictEqual(
    formattedWithoutSuggestion.includes('```suggestion'),
    false,
    'Must NOT include ```suggestion block when suggestedCode is omitted'
  );
  console.log('  ✓ formatReviewCommentBody renders cleanly without ```suggestion when omitted');

  // 3. Comment with pre-fenced suggestedCode
  const commentWithFencedCode = {
    path: 'src/config.ts',
    line: 5,
    severity: 'suggestion',
    category: 'maintainability',
    comment: 'Use explicit type annotation.',
    suggestedCode: '```suggestion\nconst timeout: number = 5000;\n```',
  };
  const formattedFenced = formatReviewCommentBody(commentWithFencedCode);
  assert.strictEqual(
    (formattedFenced.match(/```suggestion/g) || []).length,
    1,
    'Must not nest or duplicate ```suggestion blocks'
  );
  console.log('  ✓ formatReviewCommentBody handles pre-fenced suggestedCode cleanly');

  // 4. Summary body formatting with findings
  const mockReviewResultWithIssues = {
    summary: 'Found potential security flaws and edge case errors.',
    approvalRecommendation: 'REQUEST_CHANGES',
    comments: [commentWithSuggestion],
  };
  const summaryWithIssues = formatReviewSummaryBody(mockReviewResultWithIssues, 1);
  assert.match(summaryWithIssues, /## VigilPR Review/);
  assert.match(summaryWithIssues, /1 inline finding flagged/);
  assert.match(summaryWithIssues, /REQUEST_CHANGES/);
  console.log('  ✓ formatReviewSummaryBody formats summary with findings count');

  // 5. Summary body formatting without findings
  const mockReviewResultClean = {
    summary: 'All changes are safe, well-structured, and verified.',
    approvalRecommendation: 'APPROVE',
    comments: [],
  };
  const summaryClean = formatReviewSummaryBody(mockReviewResultClean, 0);
  assert.match(summaryClean, /## VigilPR Review/);
  assert.match(summaryClean, /No issues found/);
  assert.match(summaryClean, /APPROVE/);
  console.log('  ✓ formatReviewSummaryBody formats clean approval summary');

  // --------------------------------------------------------------------------
  // Test 9: postPullRequestReview (Octokit integration & fallback behavior)
  // --------------------------------------------------------------------------
  console.log('\nTest 9: postPullRequestReview mapping and fallback guards');

  let reviewCallParams = null;
  const mockOctokit = {
    rest: {
      pulls: {
        createReview: async (params) => {
          reviewCallParams = params;
          return {
            data: {
              id: 999123,
              html_url: 'https://github.com/acme/vigilpr-test/pull/42#pullrequestreview-999123',
            },
          };
        },
      },
    },
  };

  const postRes = await postPullRequestReview({
    octokit: mockOctokit,
    owner: 'acme',
    repo: 'vigilpr-test',
    pullNumber: 42,
    commitSha: 'abc1234',
    review: mockReviewResultWithIssues,
  });

  assert.strictEqual(postRes.id, 999123);
  assert.strictEqual(postRes.event, 'REQUEST_CHANGES');
  assert.strictEqual(reviewCallParams.comments.length, 1);
  assert.strictEqual(reviewCallParams.comments[0].side, 'RIGHT');
  assert.strictEqual(reviewCallParams.comments[0].line, 25);
  console.log('  ✓ postPullRequestReview properly maps comments, side: RIGHT, and commit_id');

  // Fallback test: REQUEST_CHANGES with 0 comments -> falls back to COMMENT
  const mockEmptyRequestChanges = {
    summary: 'Need revisions, but no line-specific comments.',
    approvalRecommendation: 'REQUEST_CHANGES',
    comments: [],
  };
  const postFallback = await postPullRequestReview({
    octokit: mockOctokit,
    owner: 'acme',
    repo: 'vigilpr-test',
    pullNumber: 42,
    commitSha: 'abc1234',
    review: mockEmptyRequestChanges,
  });
  assert.strictEqual(postFallback.event, 'COMMENT', 'Must fallback to COMMENT when 0 comments');
  console.log('  ✓ postPullRequestReview falls back from REQUEST_CHANGES to COMMENT when 0 comments');

  // 422 Retry test: Self-review / restricted permission error retries with COMMENT
  let attempt = 0;
  const mockOctokitWith422 = {
    rest: {
      pulls: {
        createReview: async (params) => {
          attempt++;
          if (attempt === 1) {
            const err = new Error('Unprocessable Entity: Cannot approve or request changes on own pull request');
            err.status = 422;
            throw err;
          }
          return {
            data: {
              id: 999456,
              html_url: 'https://github.com/acme/vigilpr-test/pull/42#pullrequestreview-999456',
            },
          };
        },
      },
    },
  };

  const post422Res = await postPullRequestReview({
    octokit: mockOctokitWith422,
    owner: 'acme',
    repo: 'vigilpr-test',
    pullNumber: 42,
    commitSha: 'abc1234',
    review: mockReviewResultWithIssues,
  });
  assert.strictEqual(attempt, 2, 'Must retry on 422');
  assert.strictEqual(post422Res.event, 'COMMENT', 'Retry must use COMMENT event');
  console.log('  ✓ postPullRequestReview safely catches 422 and retries with COMMENT');

  console.log('\n🎉 ALL PIPELINE TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
