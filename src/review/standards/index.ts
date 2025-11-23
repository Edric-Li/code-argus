/**
 * Standards Module
 *
 * Extracts project coding standards from configuration files.
 */

export { extractStandards, standardsToPromptText, createStandards } from './extractor.js';

export type { ExtractorOptions, ParserResult } from './types.js';

export {
  DEFAULT_EXTRACTOR_OPTIONS,
  ESLINT_CONFIG_PATTERNS,
  TSCONFIG_PATTERNS,
  PRETTIER_CONFIG_PATTERNS,
} from './types.js';

// Re-export parsers for advanced usage
export * from './parsers/index.js';
