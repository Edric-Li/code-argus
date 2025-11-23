/**
 * Diff Analyzer Types
 * Types for LLM-based code change analysis
 */

/**
 * Risk level for code changes
 */
export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Changed interface/type definition
 */
export interface ChangedInterface {
  /** Interface or type name */
  name: string;
  /** Added properties/fields */
  added_fields?: string[];
  /** Removed properties/fields */
  removed_fields?: string[];
  /** Modified properties/fields */
  modified_fields?: string[];
}

/**
 * Changed function/method
 */
export interface ChangedFunction {
  /** Function or method name */
  name: string;
  /** Change type */
  change_type: 'signature' | 'implementation' | 'new' | 'deleted';
  /** Added parameters */
  added_params?: string[];
  /** Removed parameters */
  removed_params?: string[];
  /** Is exported */
  is_exported?: boolean;
}

/**
 * Semantic hints extracted from diff
 */
export interface SemanticHints {
  /** Changed interfaces/types */
  interfaces?: ChangedInterface[];
  /** Changed functions/methods/components */
  functions?: ChangedFunction[];
  /** Changed exports (added or removed) */
  exports?: {
    added?: string[];
    removed?: string[];
  };
  /** Brief summary of the change */
  summary?: string;
}

/**
 * Analysis result for a single file change
 */
export interface ChangeAnalysis {
  /** File path */
  file_path: string;
  /** Risk level of the change */
  risk_level: RiskLevel;
  /** Semantic hints about what changed */
  semantic_hints: SemanticHints;
}

/**
 * LLM response format for diff analysis
 */
export interface LLMAnalysisResponse {
  changes: ChangeAnalysis[];
}

/**
 * Metadata about the analysis process
 */
export interface AnalysisMetadata {
  /** Total files in the diff */
  total_files: number;
  /** Files that were analyzed */
  analyzed_files: number;
  /** Files that were skipped (lock, asset, generated) */
  skipped_files: number;
  /** Number of batches processed */
  batches: number;
  /** Total tokens used (input + output) */
  total_tokens: number;
}

/**
 * Complete analysis result
 */
export interface AnalysisResult {
  /** Analysis for each changed file */
  changes: ChangeAnalysis[];
  /** Metadata about the analysis process */
  metadata: AnalysisMetadata;
}

/**
 * Configuration for the diff analyzer
 */
export interface DiffAnalyzerConfig {
  /** Maximum tokens per batch (default: 30000) */
  maxTokensPerBatch: number;
  /** Maximum concurrent API calls (default: 5) */
  maxConcurrency: number;
  /** Number of retries on failure (default: 3) */
  maxRetries: number;
  /** Delay between retries in ms (default: 1000) */
  retryDelayMs: number;
}

/**
 * Default analyzer configuration
 */
export const DEFAULT_ANALYZER_CONFIG: DiffAnalyzerConfig = {
  maxTokensPerBatch: 30000,
  maxConcurrency: 5,
  maxRetries: 3,
  retryDelayMs: 1000,
};
