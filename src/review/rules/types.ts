/**
 * Rules Module Types
 *
 * Type definitions for project-specific review rules loaded from external directories.
 */

import type { AgentType, IssueCategory, ChecklistResult } from '../types.js';

/**
 * Review agent types that support custom rules
 * (excludes 'validator' as it uses its own validation prompts)
 */
export type RuleAgentType = Exclude<AgentType, 'validator'>;

/**
 * Custom checklist item defined in rules
 */
export interface CustomChecklistItem {
  /** Unique identifier */
  id: string;
  /** Category this item belongs to */
  category: IssueCategory;
  /** Question to check */
  question: string;
  /** Default result (optional) */
  defaultResult?: ChecklistResult;
}

/**
 * Loaded rules configuration
 */
export interface RulesConfig {
  /** Global rules content (applies to all agents) */
  global?: string;

  /** Per-agent rules content */
  agents: Partial<Record<RuleAgentType, string>>;

  /** Custom checklist items */
  checklist: CustomChecklistItem[];

  /** Source directories the rules were loaded from */
  sources: string[];
}

/**
 * Options for loading rules
 */
export interface RulesLoaderOptions {
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Default empty rules config
 */
export const EMPTY_RULES_CONFIG: RulesConfig = {
  global: undefined,
  agents: {},
  checklist: [],
  sources: [],
};

/**
 * File name conventions for rules directory
 */
export const RULES_FILE_NAMES = {
  /** Global rules file (applies to all agents) */
  global: 'global.md',

  /** Per-agent rules files */
  agents: {
    'security-reviewer': 'security.md',
    'logic-reviewer': 'logic.md',
    'style-reviewer': 'style.md',
    'performance-reviewer': 'performance.md',
  } as Record<RuleAgentType, string>,

  /** Custom checklist file */
  checklist: 'checklist.yaml',
} as const;
