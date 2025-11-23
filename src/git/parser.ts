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

  return {
    path,
    type,
    content,
    category,
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
