/**
 * Git diff filter
 * Filters out files that don't need code review
 */

import type { DiffFile } from './type.js';

/**
 * Lockfile patterns to exclude
 */
const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

/**
 * Binary/image file extensions to exclude
 */
const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.ico', '.gif', '.woff', '.ttf'];

/**
 * Output directory prefixes to exclude
 */
const OUTPUT_DIRS = ['dist/', 'build/', 'coverage/'];

/**
 * JSON files to keep (all other .json files will be excluded)
 */
const KEEP_JSON_FILES = ['package.json', 'tsconfig.json'];

/**
 * Filter diff files to only include those that need code review
 *
 * Excludes:
 * - Lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml)
 * - Binary/image files (.png, .jpg, .svg, etc.)
 * - Output directories (dist/, build/, coverage/)
 * - Deleted files (type === 'delete')
 * - JSON files (except package.json and tsconfig.json)
 *
 * @param files - Array of parsed diff files
 * @returns Filtered array of diff files
 */
export function filterDiff(files: DiffFile[]): DiffFile[] {
  return files.filter(file => shouldIncludeFile(file));
}

/**
 * Determine if a file should be included in code review
 *
 * @param file - Diff file to check
 * @returns true if file should be included, false otherwise
 */
function shouldIncludeFile(file: DiffFile): boolean {
  const { path, type } = file;

  // Exclude deleted files
  if (type === 'delete') {
    return false;
  }

  // Exclude lockfiles
  if (isLockfile(path)) {
    return false;
  }

  // Exclude binary/image files
  if (isBinaryFile(path)) {
    return false;
  }

  // Exclude output directories
  if (isOutputDirectory(path)) {
    return false;
  }

  // Exclude JSON files (except important config files)
  if (isExcludedJsonFile(path)) {
    return false;
  }

  return true;
}

/**
 * Check if file is a lockfile
 */
function isLockfile(path: string): boolean {
  return LOCKFILES.some(lockfile => path.endsWith(lockfile));
}

/**
 * Check if file is a binary/image file
 */
function isBinaryFile(path: string): boolean {
  return BINARY_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext));
}

/**
 * Check if file is in an output directory
 */
function isOutputDirectory(path: string): boolean {
  return OUTPUT_DIRS.some(dir => path.startsWith(dir));
}

/**
 * Check if JSON file should be excluded
 * Excludes all .json files except package.json and tsconfig.json
 */
function isExcludedJsonFile(path: string): boolean {
  // Not a JSON file
  if (!path.toLowerCase().endsWith('.json')) {
    return false;
  }

  // Check if it's one of the files we want to keep
  const fileName = path.split('/').pop() || '';
  return !KEEP_JSON_FILES.includes(fileName);
}
