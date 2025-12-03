/**
 * Diff Analyzer Types
 * Types for local rule-based code change analysis
 */

/**
 * Risk level for code changes
 */
export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Semantic hints extracted from diff
 */
export interface SemanticHints {
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
 * Metadata about the analysis process
 */
export interface AnalysisMetadata {
  /** Total files in the diff */
  total_files: number;
  /** Files that were analyzed */
  analyzed_files: number;
  /** Files that were skipped (lock, asset, generated) */
  skipped_files: number;
  /** Number of batches processed (always 0 for local analyzer) */
  batches: number;
  /** Total tokens used (always 0 for local analyzer) */
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
