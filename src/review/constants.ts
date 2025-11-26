/**
 * Review Module Constants
 */

/**
 * Default model for deduplication (using Haiku for cost efficiency)
 */
export const DEFAULT_DEDUP_MODEL = 'claude-3-5-haiku-20241022';

/**
 * Default model for specialist agents
 * Using Sonnet for balanced speed/quality (no extended thinking needed for code review)
 */
export const DEFAULT_AGENT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Max thinking tokens for agents (0 = disable extended thinking)
 * Code review is structured enough that extended thinking adds latency without much benefit
 */
export const DEFAULT_AGENT_MAX_THINKING_TOKENS = 0;

/**
 * Default max turns for validation agent
 */
export const DEFAULT_VALIDATOR_MAX_TURNS = 30;

/**
 * Default max turns for specialist agents
 */
export const DEFAULT_AGENT_MAX_TURNS = 30;

/**
 * Minimum confidence threshold for validation
 * Issues below this threshold are auto-rejected without validation
 */
export const MIN_CONFIDENCE_FOR_VALIDATION = 0.5;

/**
 * Default concurrency for batch validation
 */
export const DEFAULT_VALIDATION_CONCURRENCY = 3;

/**
 * Challenge mode: Use "反问确认" strategy for validation
 * - Round 1: Initial validation
 * - Round 2: Challenge with "你确定吗?"
 * - Round 3 (if changed): Challenge again "你改主意了，现在确定吗?"
 * - If two consecutive rounds agree -> result is valid
 * - If AI keeps changing -> issue is considered valid (uncertain = exists)
 */
export const DEFAULT_CHALLENGE_MODE = true;

/**
 * Maximum challenge rounds before giving up
 */
export const MAX_CHALLENGE_ROUNDS = 3;
