/**
 * Environment configuration for Argus
 *
 * This module ensures that ANTHROPIC_* variables are set from ARGUS_* variables
 * to avoid conflicts with global Claude installations.
 */

/**
 * Initialize environment variables for Claude Agent SDK
 * Copies ARGUS_* variables to ANTHROPIC_* if the latter are not set
 */
export function initializeEnv(): void {
  // Only set ANTHROPIC_* if they're not already set in the environment
  // This allows environment variables to override .env file values

  if (!process.env.ANTHROPIC_API_KEY && process.env.ARGUS_ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = process.env.ARGUS_ANTHROPIC_API_KEY;
  }

  if (!process.env.ANTHROPIC_BASE_URL && process.env.ARGUS_ANTHROPIC_BASE_URL) {
    process.env.ANTHROPIC_BASE_URL = process.env.ARGUS_ANTHROPIC_BASE_URL;
  }

  if (!process.env.ANTHROPIC_MODEL && process.env.ARGUS_ANTHROPIC_MODEL) {
    process.env.ANTHROPIC_MODEL = process.env.ARGUS_ANTHROPIC_MODEL;
  }
}

/**
 * Get API key with fallback chain
 */
export function getApiKey(): string {
  return process.env.ARGUS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
}

/**
 * Get base URL with fallback chain
 */
export function getBaseUrl(): string | undefined {
  return process.env.ARGUS_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
}

/**
 * Get model with fallback chain
 */
export function getModel(): string | undefined {
  return process.env.ARGUS_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL;
}
