/**
 * Git diff parser
 * Converts raw git diff string into structured file objects
 */

import type { DiffFile, DiffFileType } from './type.js';

/**
 * Parse raw git diff output into structured DiffFile array
 *
 * @param raw - Raw git diff string
 * @returns Array of parsed diff files
 */
export function parseDiff(raw: string): DiffFile[] {
  if (!raw || !raw.trim()) {
    return [];
  }

  const files: DiffFile[] = [];

  // Split by "diff --git" to get individual file chunks
  // The first element will be empty or contain header info, so we filter it out
  const chunks = raw.split(/^diff --git /m).filter(chunk => chunk.trim());

  for (const chunk of chunks) {
    const file = parseChunk(chunk);
    if (file) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Parse a single diff chunk into a DiffFile object
 *
 * @param chunk - Single file diff chunk
 * @returns Parsed DiffFile or null if invalid
 */
function parseChunk(chunk: string): DiffFile | null {
  const lines = chunk.split('\n');

  // First line should be like: a/path/to/file b/path/to/file
  const firstLine = lines[0];
  if (!firstLine) {
    return null;
  }

  // Extract file path from first line
  // Format: a/path/to/file b/path/to/file
  const path = extractPath(firstLine);
  if (!path) {
    return null;
  }

  // Determine change type
  const type = determineChangeType(chunk);

  // Extract content (everything from the chunk)
  const content = chunk;

  return {
    path,
    content,
    type,
  };
}

/**
 * Extract clean file path from the first line of diff chunk
 *
 * @param line - First line like "a/path/to/file b/path/to/file"
 * @returns Clean file path without a/ or b/ prefix
 */
function extractPath(line: string): string | null {
  // The line format is: a/path/to/file b/path/to/file
  // We want to extract the path without a/ or b/ prefix

  // Try to match the pattern
  const match = line.match(/^a\/(.+?)\s+b\/(.+?)$/);
  if (match) {
    // Use the b/ path (destination path) as it's more accurate for renames
    return match[2] ?? match[1] ?? null;
  }

  // Fallback: try to extract any path with a/ or b/ prefix
  const fallbackMatch = line.match(/[ab]\/(.+?)(?:\s|$)/);
  if (fallbackMatch) {
    return fallbackMatch[1] ?? null;
  }

  return null;
}

/**
 * Determine the type of change (add, delete, modify)
 *
 * @param chunk - Full diff chunk content
 * @returns Type of change
 */
function determineChangeType(chunk: string): DiffFileType {
  // Check for new file
  if (chunk.includes('new file mode')) {
    return 'add';
  }

  // Check for deleted file
  if (chunk.includes('deleted file mode')) {
    return 'delete';
  }

  // Default to modify
  return 'modify';
}
