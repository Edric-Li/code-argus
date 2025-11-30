/**
 * Review Module Constants
 */

/**
 * Default model for all agents
 * Using Opus for highest quality code review
 */
export const DEFAULT_AGENT_MODEL = 'claude-opus-4-5-20251101';

/**
 * Default model for deduplication (post-validation batch dedup)
 */
export const DEFAULT_DEDUP_MODEL = 'claude-opus-4-5-20251101';

/**
 * Default model for realtime deduplication
 * Use Haiku for speed and cost efficiency since it runs on every overlapping issue
 */
export const DEFAULT_REALTIME_DEDUP_MODEL = 'claude-3-5-haiku-20241022';

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
 * - Round 3 (if changed): Challenge with "请提供更具体的代码证据"
 * - Round 4 (if changed): Devil's advocate "请考虑反面论点"
 * - Round 5 (if changed): Final chance "最后一轮，给出最终判断"
 * - If two consecutive rounds agree -> result is valid
 * - If AI keeps changing after 5 rounds -> majority vote decides
 */
export const DEFAULT_CHALLENGE_MODE = true;

/**
 * Maximum challenge rounds before giving up
 * Supports up to 5 rounds with progressive challenge strategies
 */
export const MAX_CHALLENGE_ROUNDS = 5;

/**
 * Maximum issues per validation group
 * Issues from the same file are grouped together, but limited to this number per group.
 * If a file has more issues, they are split into multiple groups.
 */
export const MAX_ISSUES_PER_GROUP = 5;
