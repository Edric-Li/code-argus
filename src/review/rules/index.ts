/**
 * Rules Module
 *
 * Load and manage project-specific review rules from external directories.
 */

export type {
  RulesConfig,
  RulesLoaderOptions,
  CustomChecklistItem,
  RuleAgentType,
} from './types.js';

export { EMPTY_RULES_CONFIG, RULES_FILE_NAMES } from './types.js';

export { loadRules, getRulesForAgent, rulesToPromptText, isEmptyRules } from './loader.js';
