/**
 * Custom Agent Types
 *
 * Type definitions for user-defined custom agents that can be loaded from external directories.
 * Custom agents allow users to define their own review rules with custom trigger conditions.
 */

import type { IssueCategory, Severity } from '../types.js';

// ============================================================================
// Trigger Types
// ============================================================================

/**
 * File status in diff
 */
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/**
 * Trigger mode for custom agents
 */
export type TriggerMode = 'rule' | 'llm' | 'hybrid';

/**
 * Rule-based trigger configuration
 */
export interface RuleTrigger {
  /**
   * Glob patterns for files to match
   * @example ["**\/*.ts", "src/api/**\/*"]
   */
  files?: string[];

  /**
   * Glob patterns for files to exclude
   * @example ["**\/*.test.ts", "**\/node_modules/**"]
   */
  exclude_files?: string[];

  /**
   * Regex patterns to match in diff content
   * @example ["SELECT.*FROM", "fetch\\("]
   */
  content_patterns?: string[];

  /**
   * File status filter
   * @example ["added", "modified"]
   */
  file_status?: FileStatus[];

  /**
   * Minimum number of changed lines to trigger
   */
  min_changes?: number;

  /**
   * Minimum number of matching files to trigger
   * @default 1
   */
  min_files?: number;

  /**
   * How to combine conditions: 'all' requires all conditions, 'any' requires at least one
   * @default 'any'
   */
  match_mode?: 'all' | 'any';
}

/**
 * LLM-based trigger configuration
 */
export interface LLMTrigger {
  /**
   * Natural language description of when to trigger this agent
   * This prompt is sent to the LLM along with diff context to determine if the agent should run
   * @example "当变更涉及 API 端点、用户认证或授权逻辑时触发"
   */
  prompt: string;
}

/**
 * Hybrid trigger strategy configuration
 */
export interface HybridTriggerStrategy {
  /**
   * Confidence threshold for rule-based matching
   * If rule matching confidence is below this, fall back to LLM
   * @default 0.8
   */
  rule_confidence_threshold?: number;

  /**
   * Always use LLM for final decision, even if rules match
   * @default false
   */
  always_use_llm?: boolean;
}

// ============================================================================
// Custom Agent Definition
// ============================================================================

/**
 * Output format configuration for custom agent
 */
export interface CustomAgentOutput {
  /**
   * Default issue category for issues found by this agent
   * @default 'maintainability'
   */
  category?: IssueCategory;

  /**
   * Default severity for issues found by this agent
   */
  default_severity?: Severity;

  /**
   * Severity weight multiplier (0.0 - 2.0)
   * Used to adjust issue severity importance relative to other agents
   * @default 1.0
   */
  severity_weight?: number;
}

/**
 * Complete custom agent definition (as defined in YAML file)
 */
export interface CustomAgentDefinition {
  /**
   * Unique identifier for this agent (derived from filename if not specified)
   * @example "typescript-migration-reviewer"
   */
  name: string;

  /**
   * Human-readable description of what this agent does
   * @example "检查 TypeScript 类型迁移的质量"
   */
  description: string;

  /**
   * Trigger mode: 'rule' (fast), 'llm' (smart), 'hybrid' (both)
   * @default 'hybrid'
   */
  trigger_mode?: TriggerMode;

  /**
   * Rule-based trigger configuration
   */
  triggers?: RuleTrigger;

  /**
   * LLM-based trigger prompt
   */
  trigger_prompt?: string;

  /**
   * Hybrid trigger strategy settings
   */
  trigger_strategy?: HybridTriggerStrategy;

  /**
   * The main prompt for this agent
   * This is the system prompt that tells the agent how to review the code
   */
  prompt: string;

  /**
   * Output configuration
   */
  output?: CustomAgentOutput;

  /**
   * Whether this agent is enabled
   * @default true
   */
  enabled?: boolean;

  /**
   * Tags for categorization and filtering
   * @example ["typescript", "migration", "types"]
   */
  tags?: string[];
}

// ============================================================================
// Runtime Types
// ============================================================================

/**
 * Loaded custom agent with source information
 */
export interface LoadedCustomAgent extends CustomAgentDefinition {
  /**
   * Source file path where this agent was loaded from
   */
  source_file: string;

  /**
   * Unique agent ID (prefixed with 'custom:')
   */
  id: string;
}

/**
 * Context provided to trigger evaluation
 */
export interface TriggerContext {
  /**
   * List of changed files
   */
  files: {
    path: string;
    status: FileStatus;
    language: string;
    additions: number;
    deletions: number;
  }[];

  /**
   * Changed symbols extracted from diff analysis
   */
  changed_symbols: {
    file: string;
    functions: string[];
    classes: string[];
    interfaces: string[];
    exports: string[];
  }[];

  /**
   * Diff statistics
   */
  stats: {
    total_files: number;
    additions: number;
    deletions: number;
  };

  /**
   * Raw diff content (truncated for LLM context)
   */
  diff_summary?: string;
}

/**
 * Result of trigger evaluation
 */
export interface TriggerResult {
  /**
   * Whether the agent should be triggered
   */
  should_trigger: boolean;

  /**
   * Confidence level (0-1)
   */
  confidence: number;

  /**
   * Reason for the decision
   */
  reason: string;

  /**
   * Which method was used for the decision
   */
  method: 'rule' | 'llm' | 'hybrid';

  /**
   * Matched files (if rule-based)
   */
  matched_files?: string[];

  /**
   * Matched patterns (if rule-based)
   */
  matched_patterns?: string[];
}

/**
 * Result from custom agent execution
 */
export interface CustomAgentResult {
  /**
   * Agent ID
   */
  agent_id: string;

  /**
   * Agent name
   */
  agent_name: string;

  /**
   * Issues found by this agent
   */
  issues: CustomAgentIssue[];

  /**
   * Tokens used
   */
  tokens_used: number;

  /**
   * Execution time in ms
   */
  execution_time_ms: number;

  /**
   * Any errors encountered
   */
  error?: string;
}

/**
 * Issue found by custom agent
 */
export interface CustomAgentIssue {
  /**
   * Unique identifier
   */
  id: string;

  /**
   * File path
   */
  file: string;

  /**
   * Start line number
   */
  line_start: number;

  /**
   * End line number
   */
  line_end: number;

  /**
   * Issue category
   */
  category: IssueCategory;

  /**
   * Severity level
   */
  severity: Severity;

  /**
   * Short title
   */
  title: string;

  /**
   * Detailed description
   */
  description: string;

  /**
   * Fix suggestion
   */
  suggestion?: string;

  /**
   * Confidence score (0-1)
   */
  confidence: number;

  /**
   * Source custom agent ID
   */
  source_agent: string;
}

// ============================================================================
// Loader Types
// ============================================================================

/**
 * Options for loading custom agents
 */
export interface CustomAgentLoaderOptions {
  /**
   * Enable verbose logging
   */
  verbose?: boolean;

  /**
   * Filter agents by tags
   */
  tags?: string[];

  /**
   * Only load enabled agents
   * @default true
   */
  enabledOnly?: boolean;
}

/**
 * Result of loading custom agents
 */
export interface CustomAgentLoadResult {
  /**
   * Successfully loaded agents
   */
  agents: LoadedCustomAgent[];

  /**
   * Errors encountered during loading
   */
  errors: {
    file: string;
    error: string;
  }[];

  /**
   * Source directories that were scanned
   */
  sources: string[];
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Supported file extensions for custom agent definitions
 */
export const CUSTOM_AGENT_EXTENSIONS = ['.yaml', '.yml'] as const;

/**
 * Default values for custom agent configuration
 */
export const CUSTOM_AGENT_DEFAULTS = {
  trigger_mode: 'hybrid' as TriggerMode,
  output: {
    category: 'maintainability' as IssueCategory,
    severity_weight: 1.0,
  },
  triggers: {
    min_files: 1,
    match_mode: 'any' as const,
  },
  trigger_strategy: {
    rule_confidence_threshold: 0.8,
    always_use_llm: false,
  },
  enabled: true,
} as const;
