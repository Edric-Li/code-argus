/**
 * Standards Module Types
 */

// Re-export from main types
export type {
  ESLintStandards,
  TypeScriptStandards,
  PrettierStandards,
  NamingConventions,
  ProjectStandards,
} from '../types.js';

/**
 * Parser result with source file
 */
export interface ParserResult<T> {
  /** Parsed data */
  data: T | null;
  /** Source file path */
  source: string | null;
  /** Error message if parsing failed */
  error?: string;
}

/**
 * ESLint config file patterns
 */
export const ESLINT_CONFIG_PATTERNS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.eslintrc',
] as const;

/**
 * TypeScript config file patterns
 */
export const TSCONFIG_PATTERNS = ['tsconfig.json', 'tsconfig.build.json'] as const;

/**
 * Prettier config file patterns
 */
export const PRETTIER_CONFIG_PATTERNS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
] as const;

/**
 * Standards extractor options
 */
export interface ExtractorOptions {
  /** Include ESLint standards */
  eslint?: boolean;
  /** Include TypeScript standards */
  typescript?: boolean;
  /** Include Prettier standards */
  prettier?: boolean;
  /** Infer naming conventions from existing files */
  inferNaming?: boolean;
}

/**
 * Default extractor options
 */
export const DEFAULT_EXTRACTOR_OPTIONS: Required<ExtractorOptions> = {
  eslint: true,
  typescript: true,
  prettier: true,
  inferNaming: true,
};
