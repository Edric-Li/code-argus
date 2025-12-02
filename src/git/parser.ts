/**
 * Git diff parser with intelligent categorization
 */

/**
 * File category for intelligent processing
 */
export type FileCategory =
  | 'source' // Source code (ts, js, css, etc.) - High priority Review
  | 'config' // Critical config (package.json, tsconfig.json) - High priority Review
  | 'data' // Generic data (*.json, *.yml) - Only check format
  | 'asset' // Static assets (images, fonts) - Only check filename changes, ignore content
  | 'lock' // Lock files (package-lock.json) - Ignore content, just note change
  | 'generated'; // Generated files (dist/, build/) - Ignore content

/**
 * Information about a line that changed only in whitespace
 */
export interface WhitespaceOnlyChange {
  /** Line number in the new file */
  newLineNumber: number;
  /** Original content (before whitespace change) */
  originalContent: string;
  /** New content (after whitespace change) */
  newContent: string;
}

/**
 * Parsed diff hunk information
 */
export interface DiffHunk {
  /** Starting line in old file */
  oldStart: number;
  /** Number of lines in old file */
  oldCount: number;
  /** Starting line in new file */
  newStart: number;
  /** Number of lines in new file */
  newCount: number;
  /** Lines in this hunk */
  lines: HunkLine[];
}

/**
 * A single line in a diff hunk
 */
export interface HunkLine {
  /** Line type: context, added, or removed */
  type: 'context' | 'added' | 'removed';
  /** Line content (without the +/- prefix) */
  content: string;
  /** Line number in old file (for context and removed lines) */
  oldLineNumber?: number;
  /** Line number in new file (for context and added lines) */
  newLineNumber?: number;
  /** Whether this is a whitespace-only change (for added lines paired with removed lines) */
  isWhitespaceOnly?: boolean;
}

/**
 * Parsed diff file information
 */
export interface DiffFile {
  /** File path */
  path: string;
  /** Change type */
  type: 'add' | 'delete' | 'modify';
  /** Diff content (or placeholder) */
  content: string;
  /** File category */
  category: FileCategory;
  /** Parsed hunks (for detailed analysis) */
  hunks?: DiffHunk[];
  /** Lines that only changed in whitespace (line numbers in new file) */
  whitespaceOnlyLines?: number[];
  /** All changed lines (line numbers in new file) - lines with '+' prefix in diff */
  changedLines?: number[];
}

/**
 * Parse git diff output into structured file changes
 *
 * @param raw - Raw git diff output
 * @returns Array of parsed diff files with categories
 */
export function parseDiff(raw: string): DiffFile[] {
  if (!raw || !raw.trim()) {
    return [];
  }

  const files: DiffFile[] = [];

  // Split by "diff --git" to get individual file diffs
  const chunks = raw.split(/^diff --git /m).filter(Boolean);

  for (const chunk of chunks) {
    const diffFile = parseFileDiff(chunk);
    if (diffFile) {
      files.push(diffFile);
    }
  }

  return files;
}

/**
 * Parse a single file diff chunk
 *
 * @param chunk - Single file diff content
 * @returns Parsed diff file or null if invalid
 */
function parseFileDiff(chunk: string): DiffFile | null {
  // Extract file path from first line: a/path/to/file b/path/to/file
  const firstLine = chunk.split('\n')[0];
  const pathMatch = firstLine?.match(/^a\/(.+?)\s+b\/(.+?)$/);

  if (!pathMatch) {
    return null;
  }

  const aPath = pathMatch[1]!;
  const bPath = pathMatch[2]!;

  // Determine change type and file path
  let type: 'add' | 'delete' | 'modify';
  let path: string;

  if (chunk.includes('new file mode')) {
    type = 'add';
    path = bPath; // New file uses b/ path
  } else if (chunk.includes('deleted file mode') || bPath === '/dev/null') {
    type = 'delete';
    path = aPath; // Deleted file uses a/ path
  } else {
    type = 'modify';
    path = bPath; // Modified file uses b/ path (should be same as a/)
  }

  // Categorize the file
  const category = categorizeFile(path);

  // Extract content with intelligent pruning
  const content = extractContent(chunk, category);

  // For source files, parse hunks and detect whitespace-only changes
  let hunks: DiffHunk[] | undefined;
  let whitespaceOnlyLines: number[] | undefined;
  let changedLines: number[] | undefined;

  if (category === 'source' || category === 'config') {
    hunks = parseHunks(chunk);
    if (hunks.length > 0) {
      whitespaceOnlyLines = detectWhitespaceOnlyChanges(hunks);
      changedLines = getChangedLineNumbers(hunks);
    }
  }

  return {
    path,
    type,
    content,
    category,
    hunks,
    whitespaceOnlyLines,
    changedLines,
  };
}

/**
 * Categorize file based on path and extension
 *
 * @param path - File path
 * @returns File category
 */
function categorizeFile(path: string): FileCategory {
  const fileName = path.split('/').pop() || '';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  // Lock files
  if (
    fileName === 'package-lock.json' ||
    fileName === 'yarn.lock' ||
    fileName === 'pnpm-lock.yaml' ||
    fileName === 'Gemfile.lock' ||
    fileName === 'Cargo.lock'
  ) {
    return 'lock';
  }

  // Asset files
  const assetExtensions = [
    'png',
    'jpg',
    'jpeg',
    'gif',
    'svg',
    'ico',
    'webp',
    'woff',
    'woff2',
    'ttf',
    'eot',
    'otf',
    'mp4',
    'webm',
    'mp3',
    'wav',
    'pdf',
    'zip',
    'tar',
    'gz',
  ];
  if (assetExtensions.includes(ext)) {
    return 'asset';
  }

  // Generated files
  if (
    path.startsWith('dist/') ||
    path.startsWith('build/') ||
    path.startsWith('.next/') ||
    path.startsWith('out/') ||
    path.startsWith('coverage/') ||
    path.includes('/dist/') ||
    path.includes('/build/') ||
    fileName.endsWith('.min.js') ||
    fileName.endsWith('.min.css') ||
    fileName.endsWith('.map')
  ) {
    return 'generated';
  }

  // Critical config files
  if (
    fileName === 'package.json' ||
    fileName === 'tsconfig.json' ||
    fileName === 'tsconfig.base.json' ||
    fileName === 'webpack.config.js' ||
    fileName === 'vite.config.js' ||
    fileName === 'vite.config.ts' ||
    fileName === 'rollup.config.js' ||
    fileName === '.eslintrc.json' ||
    fileName === '.prettierrc.json'
  ) {
    return 'config';
  }

  // Generic data files
  const dataExtensions = ['json', 'yaml', 'yml', 'toml', 'xml'];
  if (dataExtensions.includes(ext)) {
    return 'data';
  }

  // Default to source code
  return 'source';
}

/**
 * Extract and potentially prune content based on category
 *
 * @param chunk - Full diff chunk
 * @param category - File category
 * @returns Content string (full or placeholder)
 */
function extractContent(chunk: string, category: FileCategory): string {
  // For low-value categories, use placeholder to save tokens
  if (category === 'lock' || category === 'asset' || category === 'generated') {
    return `[Metadata Only: Content skipped for ${category} file]`;
  }

  // For deleted files, we want to preserve content to analyze what was removed
  // For source, config, data - preserve full content
  return chunk;
}

/**
 * Parse hunks from a diff chunk
 *
 * @param chunk - Full diff chunk for a single file
 * @returns Array of parsed hunks
 */
export function parseHunks(chunk: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];

  // Match hunk headers: @@ -oldStart,oldCount +newStart,newCount @@
  const hunkHeaderRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;
  const hunkPositions: {
    start: number;
    header: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
  }[] = [];

  while ((match = hunkHeaderRegex.exec(chunk)) !== null) {
    hunkPositions.push({
      start: match.index,
      header: match[0],
      oldStart: parseInt(match[1] ?? '1', 10),
      oldCount: match[2] ? parseInt(match[2], 10) : 1,
      newStart: parseInt(match[3] ?? '1', 10),
      newCount: match[4] ? parseInt(match[4], 10) : 1,
    });
  }

  // Parse each hunk
  for (let i = 0; i < hunkPositions.length; i++) {
    const pos = hunkPositions[i]!;
    const nextPos = hunkPositions[i + 1];
    const hunkEnd = nextPos ? nextPos.start : chunk.length;

    // Get hunk content (after the header line)
    const headerEnd = pos.start + pos.header.length;
    const hunkContent = chunk.slice(headerEnd, hunkEnd);
    const rawLines = hunkContent.split('\n');

    const lines: HunkLine[] = [];
    let oldLine = pos.oldStart;
    let newLine = pos.newStart;

    for (const rawLine of rawLines) {
      if (rawLine === '') continue;

      const prefix = rawLine[0];
      const content = rawLine.slice(1);

      if (prefix === ' ') {
        // Context line
        lines.push({
          type: 'context',
          content,
          oldLineNumber: oldLine,
          newLineNumber: newLine,
        });
        oldLine++;
        newLine++;
      } else if (prefix === '-') {
        // Removed line
        lines.push({
          type: 'removed',
          content,
          oldLineNumber: oldLine,
        });
        oldLine++;
      } else if (prefix === '+') {
        // Added line
        lines.push({
          type: 'added',
          content,
          newLineNumber: newLine,
        });
        newLine++;
      }
      // Skip lines that don't start with ' ', '-', or '+' (like "\ No newline at end of file")
    }

    hunks.push({
      oldStart: pos.oldStart,
      oldCount: pos.oldCount,
      newStart: pos.newStart,
      newCount: pos.newCount,
      lines,
    });
  }

  return hunks;
}

/**
 * Normalize a line by removing all whitespace for comparison
 *
 * @param line - Line content
 * @returns Normalized line (no whitespace)
 */
function normalizeForComparison(line: string): string {
  return line.replace(/\s+/g, '');
}

/**
 * Detect whitespace-only changes in hunks
 *
 * This function identifies lines where the only difference between
 * the removed line and added line is whitespace (indentation, spaces, etc.)
 *
 * @param hunks - Parsed diff hunks
 * @returns Array of line numbers (in new file) that are whitespace-only changes
 */
export function detectWhitespaceOnlyChanges(hunks: DiffHunk[]): number[] {
  const whitespaceOnlyLines: number[] = [];

  for (const hunk of hunks) {
    const { lines } = hunk;

    // Find consecutive removed+added pairs
    let i = 0;
    while (i < lines.length) {
      // Collect consecutive removed lines
      const removedLines: HunkLine[] = [];
      while (i < lines.length && lines[i]!.type === 'removed') {
        removedLines.push(lines[i]!);
        i++;
      }

      // Collect consecutive added lines
      const addedLines: HunkLine[] = [];
      while (i < lines.length && lines[i]!.type === 'added') {
        addedLines.push(lines[i]!);
        i++;
      }

      // Match removed and added lines using content similarity (Map-based approach)
      // This handles both equal and unequal counts, and correctly handles reordered lines
      if (removedLines.length > 0 && addedLines.length > 0) {
        // Create a map of normalized content to removed lines
        const removedMap = new Map<string, HunkLine[]>();
        for (const removed of removedLines) {
          const normalized = normalizeForComparison(removed.content);
          if (!removedMap.has(normalized)) {
            removedMap.set(normalized, []);
          }
          removedMap.get(normalized)!.push(removed);
        }

        // Check each added line for a matching removed line
        for (const added of addedLines) {
          const normalizedAdded = normalizeForComparison(added.content);
          const matchingRemoved = removedMap.get(normalizedAdded);

          if (matchingRemoved && matchingRemoved.length > 0) {
            const removed = matchingRemoved[0]!;
            // Only mark as whitespace-only if content actually differs (not identical)
            if (removed.content !== added.content && added.newLineNumber !== undefined) {
              whitespaceOnlyLines.push(added.newLineNumber);
              added.isWhitespaceOnly = true;
            }
            // Remove the used match
            matchingRemoved.shift();
          }
        }
      }

      // Skip context lines
      while (i < lines.length && lines[i]!.type === 'context') {
        i++;
      }
    }
  }

  return whitespaceOnlyLines.sort((a, b) => a - b);
}

/**
 * Extract all changed line numbers from hunks
 *
 * These are lines with '+' prefix in the diff, representing:
 * - Newly added lines
 * - Modified lines (the new version)
 * - Whitespace-only changes (also included)
 *
 * @param hunks - Parsed diff hunks
 * @returns Array of line numbers (in new file) that were changed
 */
export function getChangedLineNumbers(hunks: DiffHunk[]): number[] {
  const changedLines: number[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'added' && line.newLineNumber !== undefined) {
        changedLines.push(line.newLineNumber);
      }
    }
  }

  return changedLines.sort((a, b) => a - b);
}
