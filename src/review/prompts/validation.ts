/**
 * Validation Prompt Builder
 *
 * Builds validation prompts by combining base template with category-specific templates.
 * Templates are loaded from markdown files for better maintainability.
 */

import type { IssueCategory, ValidationPromptConfig } from '../types.js';
import { loadBaseValidationTemplate, loadCategoryValidationTemplate } from './template-loader.js';

/**
 * Validation prompt configurations for different issue categories
 * Focus points and rejection criteria are defined here, while detailed prompts are in templates
 */
export const VALIDATION_PROMPT_CONFIGS: Record<IssueCategory, ValidationPromptConfig> = {
  style: {
    category: 'style',
    validationFocus: [
      'Check if the reported style matches existing project patterns',
      'Verify naming conventions are consistent with existing code',
      'Confirm code organization follows project conventions',
      'Check if formatting rules match project configuration',
    ],
    rejectionCriteria: [
      'The problematic style is already widely used in the project (3+ instances)',
      'No clear project standards define this style',
      'Suggested changes are inconsistent with existing project code style',
      'Pure personal preference without objective quality issues',
    ],
    additionalSystemPrompt: loadCategoryValidationTemplate('style'),
  },

  security: {
    category: 'security',
    validationFocus: [
      'Verify if input data has been validated/sanitized',
      'Check if security middleware or protective measures exist',
      'Confirm if problematic code can be triggered from untrusted sources',
      'Verify if sensitive operations have access controls',
    ],
    rejectionCriteria: [
      'Input has been validated/sanitized upstream',
      'Security middleware handles this type of issue',
      'Code path cannot be triggered from untrusted sources',
      'Problematic code only executes in trusted environments',
    ],
    additionalSystemPrompt: loadCategoryValidationTemplate('security'),
  },

  logic: {
    category: 'logic',
    validationFocus: [
      'Verify if reported boundary conditions can actually occur',
      'Check if error handling covers this scenario',
      'Confirm if test cases cover this logic',
      'Verify if business constraints make the problem impossible',
    ],
    rejectionCriteria: [
      'Test cases exist that verify this behavior is correct',
      'Error handling already exists at higher levels',
      'Business constraints prevent reported boundary conditions',
      'Type system already guarantees this issue cannot occur',
    ],
    additionalSystemPrompt: loadCategoryValidationTemplate('logic'),
  },

  performance: {
    category: 'performance',
    validationFocus: [
      'Verify actual call frequency of the code',
      'CRITICAL: Read and analyze the ACTUAL COST of called methods/functions',
      'Calculate total impact: frequency × per-call cost',
      'Check if caching/memoization/singleton patterns exist',
      'Verify if code is on a hot path (render loop, event handler)',
    ],
    rejectionCriteria: [
      'Called method is O(1) or very cheap (singleton getInstance, Map.get, property access)',
      'EventEmitter.emit() with negligible listener overhead',
      'Code is rarely executed (cold path)',
      'Caching/memoization/debounce already exists',
      'High frequency but low per-call cost = negligible total impact',
      'Premature optimization without bottleneck evidence',
    ],
    additionalSystemPrompt: loadCategoryValidationTemplate('performance'),
  },

  maintainability: {
    category: 'maintainability',
    validationFocus: [
      'Evaluate if code complexity exceeds necessity',
      'Check if similar patterns exist in the project',
      'Verify refactoring suggestions follow project conventions',
    ],
    rejectionCriteria: [
      'Code complexity matches problem complexity',
      'Similar patterns are widely used in the project',
      'Refactoring suggestions conflict with existing project architecture',
    ],
    additionalSystemPrompt: loadCategoryValidationTemplate('maintainability'),
  },
};

/**
 * Options for building validation system prompt
 */
export interface ValidationPromptOptions {
  /** Project-specific review rules (markdown format) */
  projectRules?: string;
}

/**
 * Build complete validation system prompt for a specific category
 * Combines base template with category-specific rules and project rules
 */
export function buildValidationSystemPrompt(
  category: IssueCategory,
  options?: ValidationPromptOptions
): string {
  const baseTemplate = loadBaseValidationTemplate();
  const categoryConfig = VALIDATION_PROMPT_CONFIGS[category];

  // Build project rules section if provided
  const projectRulesSection = options?.projectRules
    ? `
## Project-Specific Review Guidelines

> These rules are explicitly defined by the project team and take precedence over project conventions.
> If an issue violates these rules, it should be **confirmed** even if similar patterns exist in the codebase.

${options.projectRules}
`
    : '';

  // Combine base template with category-specific rules and project rules
  const prompt = [
    baseTemplate,
    '',
    categoryConfig.additionalSystemPrompt,
    '',
    projectRulesSection,
  ].join('\n');

  return prompt;
}

/**
 * Get validation prompt config for a category
 */
export function getValidationPromptConfig(category: IssueCategory): ValidationPromptConfig {
  return VALIDATION_PROMPT_CONFIGS[category];
}

/**
 * Base validation prompt (for backward compatibility)
 * @deprecated Use loadBaseValidationTemplate instead
 */
export const BASE_VALIDATION_PROMPT = loadBaseValidationTemplate();

/**
 * JSON output format specification (for backward compatibility)
 * This is included in the base template
 */
export const VALIDATION_JSON_FORMAT = '';
