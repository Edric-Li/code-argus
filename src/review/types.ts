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
  | 'validator';

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
import type { IntentAnalysis } from '../intent/types.js';

/**
 * Complete context for code review
 */
export interface ReviewContext {
  /** Repository path */
  repoPath: string;
  /** Diff result */
  diff: DiffResult;
  /** Intent analysis result */
  intent: IntentAnalysis;
  /** File change analyses */
  fileAnalyses: ChangeAnalysis[];
  /** Project standards */
  standards: ProjectStandards;
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
  /** Enable status monitoring UI */
  monitor?: boolean;
  /** Status monitor port (default: 3456) */
  monitorPort?: number;
  /** Delay in ms to keep monitor server alive after completion (default: 5000, 0 to disable) */
  monitorStopDelay?: number;
}

/**
 * Input for the review orchestrator
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
