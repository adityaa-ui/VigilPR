/**
 * Interface representing a changed file in a Pull Request from GitHub API.
 */
export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  [key: string]: unknown;
}

/**
 * Filtered and annotated file diff ready for LLM consumption.
 */
export interface FilteredFileDiff {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  annotatedPatch: string;
  validRightLines: Set<number>;
}

/**
 * Common package lockfiles to ignore during code review.
 */
const IGNORED_LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'go.sum',
]);

/**
 * File extensions for non-code assets (images, fonts, sourcemaps).
 */
const IGNORED_EXTENSIONS = new Set([
  // Images
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  // Source maps
  '.map',
]);

/**
 * Directories typically containing generated build artifacts or reports.
 */
const IGNORED_DIR_REGEX = /(?:^|\/)(dist|build|\.next|coverage)\//i;

/**
 * Determines whether a file diff should be skipped from AI review.
 * Filters out removed files, missing patches, lockfiles, minified assets,
 * binary media/fonts, and build output directories.
 */
export function shouldIgnoreFile(file: PullRequestFile): boolean {
  // 1. Skip removed files and files without patches (binary or oversized)
  if (file.status === 'removed' || !file.patch || file.patch.trim() === '') {
    return true;
  }

  // Normalize path separators to forward slash
  const normalizedPath = file.filename.replace(/\\/g, '/').trim();
  const basename = normalizedPath.split('/').pop() || '';
  const lowerBasename = basename.toLowerCase();

  // 2. Lockfiles (at root or in monorepo packages)
  if (IGNORED_LOCKFILES.has(basename) || IGNORED_LOCKFILES.has(lowerBasename)) {
    return true;
  }

  // 3. Minified assets (*.min.js, *.min.css)
  if (lowerBasename.endsWith('.min.js') || lowerBasename.endsWith('.min.css')) {
    return true;
  }

  // 4. Non-code asset extensions (images, fonts, maps)
  const extMatch = lowerBasename.match(/\.[^.]+$/);
  if (extMatch && IGNORED_EXTENSIONS.has(extMatch[0])) {
    return true;
  }

  // 5. Build output directories (dist/, build/, .next/, coverage/)
  if (IGNORED_DIR_REGEX.test(normalizedPath)) {
    return true;
  }

  return false;
}

/**
 * Parses unified diff hunks and prepends line annotations:
 * - `+` (added) line: `[L<rightLine>] +...` -> recorded in validRightLines
 * - ` ` (context) line: `[L<rightLine>]  ...` -> recorded in validRightLines
 * - `-` (deleted) line: `[DEL] -...` (does not increment rightLine counter)
 * - `@@ ... @@`: hunk header preserved, initializes rightLine counter
 * - `\ No newline...`: preserved without changing rightLine counter
 */
export function parseAndAnnotatePatch(patch: string): {
  annotatedPatch: string;
  validRightLines: Set<number>;
} {
  const lines = patch.split('\n');
  const annotatedLines: string[] = [];
  const validRightLines = new Set<number>();

  let currentRightLine: number | null = null;

  for (const line of lines) {
    // Check for hunk header: @@ -oldStart,oldCount +newStart,newCount @@ [heading]
    // Note: oldCount and newCount can be omitted when count is 1 (e.g. @@ -1 +1 @@)
    const hunkHeaderMatch = line.match(/^@@\s+-(?:\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);

    if (hunkHeaderMatch) {
      currentRightLine = parseInt(hunkHeaderMatch[1], 10);
      annotatedLines.push(line);
      continue;
    }

    // If we haven't encountered a hunk header yet, keep line as-is
    if (currentRightLine === null) {
      annotatedLines.push(line);
      continue;
    }

    if (line.startsWith('+')) {
      // Added line: valid on the RIGHT side of the diff
      validRightLines.add(currentRightLine);
      annotatedLines.push(`[L${currentRightLine}] ${line}`);
      currentRightLine++;
    } else if (line.startsWith(' ')) {
      // Context line: present on both sides, valid on RIGHT side
      validRightLines.add(currentRightLine);
      annotatedLines.push(`[L${currentRightLine}] ${line}`);
      currentRightLine++;
    } else if (line.startsWith('-')) {
      // Removed line: only exists on LEFT side, marked as [DEL]
      annotatedLines.push(`[DEL] ${line}`);
    } else if (line.startsWith('\\')) {
      // e.g. \ No newline at end of file
      annotatedLines.push(line);
    } else {
      // Any other metadata or trailing line
      annotatedLines.push(line);
    }
  }

  return {
    annotatedPatch: annotatedLines.join('\n'),
    validRightLines,
  };
}

/**
 * Filters out noise and generated files, annotates diffs with exact RIGHT-side line numbers,
 * and caps reviewable files to `maxFiles`.
 */
export function prepareDiffsForReview(
  files: PullRequestFile[],
  maxFiles = 20
): FilteredFileDiff[] {
  const reviewable: FilteredFileDiff[] = [];

  for (const file of files) {
    if (shouldIgnoreFile(file)) {
      continue;
    }

    if (!file.patch) {
      continue;
    }

    const { annotatedPatch, validRightLines } = parseAndAnnotatePatch(file.patch);

    reviewable.push({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      annotatedPatch,
      validRightLines,
    });

    if (reviewable.length >= maxFiles) {
      break;
    }
  }

  return reviewable;
}
