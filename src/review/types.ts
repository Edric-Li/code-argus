/**
 * AI Code Review Types
 */

// ============================================================================
// Basic Types
// ============================================================================

/** Issue severity levels */
export type Severity = 'critical' | 'error' | 'warning' | 'suggestion';

/** Issue categories */
export type IssueCategory = 'security' | 'logic' | 'performance' | 'style' | 'maintainability';

/** Validation status after verification */
export type ValidationStatus = 'pending' | 'confirmed' | 'rejected' | 'uncertain';

/** Risk level for overall PR */
export type RiskLevel = 'high' | 'medium' | 'low';

/** Checklist item result */
export type ChecklistResult = 'pass' | 'fail' | 'na';

/** Agent types */
export type AgentType =
  | 'security-reviewer'
  | 'logic-reviewer'
  | 'style-reviewer'
  | 'performance-reviewer'
  | 'validator'
  | 'fix-verifier';

/** Validation strategy for different agent types */
export type ValidationStrategy = 'immediate' | 'batch-on-agent-complete';

/** Validation strategy configuration */
export interface ValidationStrategyConfig {
  /** Strategy type */
  strategy: ValidationStrategy;
}

/** Default validation strategies by agent type */
export const DEFAULT_VALIDATION_STRATEGIES: Record<AgentType, ValidationStrategyConfig> = {
  'style-reviewer': { strategy: 'batch-on-agent-complete' },
  'security-reviewer': { strategy: 'immediate' },
  'logic-reviewer': { strategy: 'immediate' },
  'performance-reviewer': { strategy: 'immediate' },
  'fix-verifier': { strategy: 'immediate' },
  validator: { strategy: 'immediate' },
};

// ============================================================================
// Validation Prompt Types
// ============================================================================

/**
 * Validation prompt configuration for different issue categories
 */
export interface ValidationPromptConfig {
  /** Issue category this config applies to */
  category: IssueCategory;
  /** Additional system prompt with category-specific validation rules */
  additionalSystemPrompt: string;
  /** Key validation focus points for this category */
  validationFocus: string[];
  /** Specific rejection criteria for this category */
  rejectionCriteria: string[];
}

// ============================================================================
// Issue Types
// ============================================================================

/**
 * Raw issue discovered by specialist agents (before validation)
 */
export interface RawIssue {
  /** Unique identifier */
  id: string;
  /** File path */
  file: string;
  /** Start line number */
  line_start: number;
  /** End line number */
  line_end: number;
  /** Issue category */
  category: IssueCategory;
  /** Severity level */
  severity: Severity;
  /** Short title */
  title: string;
  /** Detailed description */
  description: string;
  /** Fix suggestion */
  suggestion?: string;
  /** Related code snippet */
  code_snippet?: string;
  /** Initial confidence score (0-1) */
  confidence: number;
  /** Source agent that found this issue */
  source_agent: AgentType;
}

/**
 * Symbol lookup result for grounding evidence
 */
export interface SymbolLookup {
  /** Symbol name */
  name: string;
  /** Lookup type */
  type: 'definition' | 'reference';
  /** Found locations */
  locations: string[];
}

/**
 * Evidence collected during validation (grounding)
 */
export interface GroundingEvidence {
  /** Files that were checked */
  checked_files: string[];
  /** Symbols that were looked up */
  checked_symbols: SymbolLookup[];
  /** Summary of related context */
  related_context: string;
  /** Detailed reasoning process */
  reasoning: string;
}

/**
 * Validated issue (after verification by validator agent)
 */
export interface ValidatedIssue extends RawIssue {
  /** Validation status */
  validation_status: ValidationStatus;
  /** Evidence collected during validation */
  grounding_evidence: GroundingEvidence;
  /** Final confidence score after validation (0-1) */
  final_confidence: number;
  /** Reason for rejection (if rejected) */
  rejection_reason?: string;
  /** Revised description (if updated) */
  revised_description?: string;
  /** Revised severity (if updated) */
  revised_severity?: Severity;
}

// ============================================================================
// Checklist Types
// ============================================================================

/**
 * Single checklist item
 */
export interface ChecklistItem {
  /** Unique identifier */
  id: string;
  /** Category this item belongs to */
  category: IssueCategory;
  /** Question to check */
  question: string;
  /** Check result */
  result: ChecklistResult;
  /** Additional details */
  details?: string;
  /** Related issue IDs */
  related_issues?: string[];
}

// ============================================================================
// Standards Types (imported from standards module)
// ============================================================================

export interface ESLintStandards {
  /** ESLint rules configuration */
  rules: Record<string, unknown>;
  /** Extended configs */
  extends?: string[];
  /** Plugins used */
  plugins?: string[];
}

export interface TypeScriptStandards {
  /** Strict mode enabled */
  strict?: boolean;
  /** No implicit any */
  noImplicitAny?: boolean;
  /** No unused locals */
  noUnusedLocals?: boolean;
  /** No unused parameters */
  noUnusedParameters?: boolean;
  /** No implicit returns */
  noImplicitReturns?: boolean;
  /** Strict null checks */
  strictNullChecks?: boolean;
  /** Other compiler options */
  [key: string]: unknown;
}

export interface PrettierStandards {
  /** Tab width */
  tabWidth?: number;
  /** Use tabs */
  useTabs?: boolean;
  /** Use semicolons */
  semi?: boolean;
  /** Use single quotes */
  singleQuote?: boolean;
  /** Print width */
  printWidth?: number;
  /** Trailing comma */
  trailingComma?: 'none' | 'es5' | 'all';
  /** Other options */
  [key: string]: unknown;
}

export interface NamingConventions {
  /** File naming convention */
  files?: 'camelCase' | 'PascalCase' | 'kebab-case' | 'snake_case';
  /** Function naming convention */
  functions?: 'camelCase' | 'PascalCase' | 'snake_case';
  /** Class naming convention */
  classes?: 'PascalCase';
  /** Constant naming convention */
  constants?: 'SCREAMING_SNAKE_CASE' | 'camelCase';
  /** Variable naming convention */
  variables?: 'camelCase' | 'snake_case';
}

/**
 * Project coding standards extracted from config files
 */
export interface ProjectStandards {
  /** Source files the standards were extracted from */
  source: string[];
  /** ESLint standards */
  eslint?: ESLintStandards;
  /** TypeScript standards */
  typescript?: TypeScriptStandards;
  /** Prettier standards */
  prettier?: PrettierStandards;
  /** Naming conventions */
  naming?: NamingConventions;
  /** Custom standards */
  custom?: Record<string, unknown>;
}

// ============================================================================
// Context Types
// ============================================================================

import type { DiffResult } from '../git/type.js';
import type { ChangeAnalysis } from '../analyzer/types.js';
import type { DiffFile } from '../git/parser.js';

/**
 * Complete context for code review
 */
export interface ReviewContext {
  /** Repository path */
  repoPath: string;
  /** Diff result */
  diff: DiffResult;
  /** File change analyses */
  fileAnalyses: ChangeAnalysis[];
  /** Project standards */
  standards: ProjectStandards;
  /** Parsed diff files (with whitespace-only change detection) */
  diffFiles?: DiffFile[];
}

// ============================================================================
// Fix Verification Types
// ============================================================================

/** Fix verification status */
export type VerificationStatus =
  | 'fixed' // Issue has been properly addressed
  | 'missed' // Issue still exists, developer oversight
  | 'false_positive' // Original issue was incorrectly reported
  | 'obsolete' // Code changed so much the issue is no longer relevant
  | 'uncertain'; // Cannot determine status

/**
 * Previous issue from last review (simplified from ValidatedIssue)
 */
export interface PreviousIssue {
  /** Unique identifier */
  id: string;
  /** File path */
  file: string;
  /** Start line number */
  line_start: number;
  /** End line number */
  line_end: number;
  /** Issue category */
  category: IssueCategory;
  /** Severity level */
  severity: Severity;
  /** Short title */
  title: string;
  /** Detailed description */
  description: string;
  /** Fix suggestion */
  suggestion?: string;
  /** Related code snippet */
  code_snippet?: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Source agent that found this issue */
  source_agent: AgentType;
}

/**
 * Evidence collected during fix verification
 */
export interface FixVerificationEvidence {
  /** Files that were checked during verification */
  checked_files: string[];
  /** Code snippets that were examined */
  examined_code: string[];
  /** Summary of related changes found */
  related_changes: string;
  /** Detailed reasoning for the verification decision */
  reasoning: string;
}

/**
 * Result of verifying a single issue from previous review
 */
export interface FixVerificationResult {
  /** Original issue ID */
  original_issue_id: string;
  /** Original issue details */
  original_issue: PreviousIssue;
  /** Verification status */
  status: VerificationStatus;
  /** Confidence in the verification (0-1) */
  confidence: number;
  /** Evidence collected during verification */
  evidence: FixVerificationEvidence;
  /** If status is 'missed', updated issue details reflecting current state */
  updated_issue?: RawIssue;
  /** If status is 'false_positive', explanation of why */
  false_positive_reason?: string;
  /** Additional notes */
  notes?: string;
}

/**
 * Summary of fix verification results
 */
export interface FixVerificationSummary {
  /** Total number of issues verified */
  total_verified: number;
  /** Count by verification status */
  by_status: Record<VerificationStatus, number>;
  /** All verification results */
  results: FixVerificationResult[];
  /** Time spent on verification in milliseconds */
  verification_time_ms: number;
  /** Tokens used for verification */
  tokens_used: number;
}

/**
 * Previous review data (input for fix verification)
 */
export interface PreviousReviewData {
  /** Issues from previous review to verify */
  issues: PreviousIssue[];
  /** Source reference from previous review (optional, for display) */
  source?: string;
  /** Target reference from previous review (optional, for display) */
  target?: string;
}

// ============================================================================
// Report Types
// ============================================================================

/**
 * Metrics for the review report
 */
export interface ReviewMetrics {
  /** Total issues scanned (before validation) */
  total_scanned: number;
  /** Issues confirmed after validation */
  confirmed: number;
  /** Issues rejected after validation */
  rejected: number;
  /** Issues with uncertain status */
  uncertain: number;
  /** Issues by severity */
  by_severity: Record<Severity, number>;
  /** Issues by category */
  by_category: Record<IssueCategory, number>;
}

/**
 * Metadata for the review report
 */
export interface ReviewMetadata {
  /** Total review time in milliseconds */
  review_time_ms: number;
  /** Total tokens used */
  tokens_used: number;
  /** Agents that were used */
  agents_used: AgentType[];
}

/**
 * Final review report
 */
export interface ReviewReport {
  /** Summary of the review */
  summary: string;
  /** Overall risk level */
  risk_level: RiskLevel;
  /** Validated issues */
  issues: ValidatedIssue[];
  /** Checklist results */
  checklist: ChecklistItem[];
  /** Review metrics */
  metrics: ReviewMetrics;
  /** Review metadata */
  metadata: ReviewMetadata;
  /** Fix verification results (if previous review was provided) */
  fix_verification?: FixVerificationSummary;
}

// ============================================================================
// Agent Types
// ============================================================================

/**
 * Result from a specialist agent
 */
export interface AgentResult {
  /** Agent type */
  agent: AgentType;
  /** Discovered issues */
  issues: RawIssue[];
  /** Checklist results */
  checklist: ChecklistItem[];
  /** Tokens used by this agent */
  tokens_used: number;
}

/**
 * Result from validator agent
 */
export interface ValidationResult {
  /** Original issue ID */
  issue_id: string;
  /** Validation status */
  status: ValidationStatus;
  /** Final confidence */
  final_confidence: number;
  /** Reasoning for the decision */
  reasoning: string;
  /** Rejection reason (if rejected) */
  rejection_reason?: string;
  /** Evidence collected */
  evidence: GroundingEvidence;
  /** Revised description (if any) */
  revised_description?: string;
  /** Revised severity (if any) */
  revised_severity?: Severity;
}

// ============================================================================
// Orchestrator Types
// ============================================================================

/**
 * Options for the review orchestrator
 */
export interface OrchestratorOptions {
  /** Maximum concurrent agents */
  maxConcurrency?: number;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Custom agents to use (default: all) */
  agents?: AgentType[];
  /** Skip validation (not recommended) */
  skipValidation?: boolean;
  /** Show CLI progress output (default: true) */
  showProgress?: boolean;
  /**
   * Enable smart agent selection based on diff content (default: false)
   * When enabled, agents are automatically selected based on file types
   */
  smartAgentSelection?: boolean;
  /**
   * Disable LLM fallback for smart agent selection (default: false)
   * When true, only rule-based selection is used
   */
  disableSelectionLLM?: boolean;
  /**
   * Directories containing custom review rules
   * Rules are loaded and merged in order, with later directories taking precedence
   */
  rulesDirs?: string[];
  /**
   * Directories containing custom agent definitions
   * Agents are loaded from YAML files and matched against diff to determine which to run
   */
  customAgentsDirs?: string[];
  /**
   * Disable LLM-based trigger evaluation for custom agents
   * When true, only rule-based triggers are used
   */
  disableCustomAgentLLM?: boolean;
  /**
   * Progress output mode (default: 'auto')
   * - 'auto': TTY mode (spinner, colors) if TTY, silent otherwise
   * - 'tty': Force TTY mode (spinner, colors)
   * - 'json': Output JSON lines (NDJSON) to stderr for service integration
   * - 'silent': No progress output
   */
  progressMode?: 'auto' | 'tty' | 'json' | 'silent';
  /**
   * Custom event handler for review events
   * Called for each event in addition to normal progress output
   */
  onEvent?: (event: ReviewProgressEvent) => void;
  /**
   * Previous review data for fix verification
   * When provided, the fix-verifier agent will check if previous issues have been addressed
   */
  previousReviewData?: PreviousReviewData;
  /**
   * Enable fix verification (default: true if previousReviewData is provided)
   * Set to false to skip fix verification even when previousReviewData is provided
   */
  verifyFixes?: boolean;
}

/**
 * Review progress event (for service integration)
 */
export interface ReviewProgressEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

/**
 * Input for the review orchestrator (branch-based review)
 */
export interface OrchestratorInput {
  /** Source branch (PR branch) */
  sourceBranch: string;
  /** Target branch (base branch) */
  targetBranch: string;
  /** Repository path */
  repoPath: string;
  /** Options */
  options?: OrchestratorOptions;
}

/**
 * External diff input options
 *
 * Allows providing diff content from external sources (e.g., Bitbucket API)
 * instead of computing it from git refs.
 */
export interface ExternalDiffInput {
  /**
   * Diff content provided directly (e.g., from PR API)
   * When provided, git diff computation is skipped entirely.
   */
  diffContent?: string;
  /**
   * Path to a file containing the diff
   * Alternative to diffContent - will be read at runtime.
   */
  diffFile?: string;
  /**
   * Read diff from stdin
   * Alternative to diffContent/diffFile.
   */
  diffStdin?: boolean;
  /**
   * Specific commits to include (comma-separated or array)
   * Only these commits will be diffed, useful for filtering out merge commits
   * on the calling side (e.g., from Bitbucket PR API).
   */
  commits?: string | string[];
  /**
   * Disable smart merge filtering when using refs
   * Set to true to use legacy two-dot diff for incremental mode.
   * Default: false (smart filtering enabled)
   */
  disableSmartMergeFilter?: boolean;
}

/**
 * Input for the review orchestrator with auto-detection of branches vs commits
 *
 * This is the preferred input type that supports both:
 * - Branch comparison (initial PR review)
 * - Commit comparison (incremental review)
 *
 * The orchestrator auto-detects whether the refs are branches or commits
 * based on their format (7-40 hex chars = commit, otherwise = branch).
 *
 * External diff input can be provided to bypass git diff computation entirely,
 * useful when integrating with external systems like Bitbucket PR Manager.
 */
export interface ReviewInput {
  /** Repository path */
  repoPath: string;
  /**
   * Source reference (branch name or commit SHA)
   * Optional if external diff is provided.
   */
  sourceRef?: string;
  /**
   * Target reference (branch name or commit SHA)
   * Optional if external diff is provided.
   */
  targetRef?: string;
  /**
   * External diff input options
   * When provided, allows bypassing git diff computation.
   */
  externalDiff?: ExternalDiffInput;
  /** Options */
  options?: OrchestratorOptions;
}

/**
 * Commit range information for incremental reviews
 */
export interface CommitRangeInfo {
  /** Number of commits in the range */
  count: number;
  /** Commit messages (short format) */
  commits: Array<{ sha: string; message: string }>;
}
