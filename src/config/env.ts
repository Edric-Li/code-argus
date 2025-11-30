/**
 * Environment configuration for Argus
 *
 * Priority order (highest to lowest):
 * 1. ARGUS_ANTHROPIC_BASE_URL + ARGUS_ANTHROPIC_API_KEY (both required)
 * 2. ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (Claude Code OAuth)
 * 3. ANTHROPIC_API_KEY (official API with default endpoint)
 * 4. Config file (~/.argus/config.json)
 * 5. Error if none configured
 */

import { loadConfig } from './store.js';

/**
 * Authentication configuration result
 */
export interface AuthConfig {
  apiKey: string;
  baseUrl?: string;
  source: 'argus' | 'claude-oauth' | 'anthropic-api' | 'config';
}

/**
 * Get authentication configuration with proper priority
 *
 * Priority:
 * 1. ARGUS_ANTHROPIC_BASE_URL + ARGUS_ANTHROPIC_API_KEY (both must be set)
 * 2. ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (Claude Code OAuth)
 * 3. ANTHROPIC_API_KEY (official API)
 * 4. Config file (~/.argus/config.json)
 *
 * @throws Error if no valid configuration found
 */
export function getAuthConfig(): AuthConfig {
  const config = loadConfig();

  // Priority 1: ARGUS-specific configuration (both must be present)
  const argusApiKey = process.env.ARGUS_ANTHROPIC_API_KEY;
  const argusBaseUrl = process.env.ARGUS_ANTHROPIC_BASE_URL;
  if (argusApiKey && argusBaseUrl) {
    return {
      apiKey: argusApiKey,
      baseUrl: argusBaseUrl,
      source: 'argus',
    };
  }

  // Priority 2: Claude Code OAuth (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (anthropicBaseUrl && anthropicAuthToken) {
    return {
      apiKey: anthropicAuthToken,
      baseUrl: anthropicBaseUrl,
      source: 'claude-oauth',
    };
  }

  // Priority 3: Official Anthropic API Key (no base URL needed)
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicApiKey) {
    return {
      apiKey: anthropicApiKey,
      baseUrl: undefined, // Use SDK default
      source: 'anthropic-api',
    };
  }

  // Priority 4: Config file
  if (config.apiKey) {
    return {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      source: 'config',
    };
  }

  // No valid configuration found
  throw new Error(
    `No API credentials configured. Please set one of the following:
  1. ARGUS_ANTHROPIC_API_KEY + ARGUS_ANTHROPIC_BASE_URL (for proxy services)
  2. ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (for Claude Code OAuth)
  3. ANTHROPIC_API_KEY (for official Anthropic API)
  4. Run 'argus config set apiKey <your-key>' to save to config file`
  );
}

/**
 * Initialize environment variables for Claude Agent SDK
 * Sets ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL based on priority
 */
export function initializeEnv(): void {
  try {
    const auth = getAuthConfig();

    // Set environment variables for SDK
    process.env.ANTHROPIC_API_KEY = auth.apiKey;
    if (auth.baseUrl) {
      process.env.ANTHROPIC_BASE_URL = auth.baseUrl;
    }

    // Handle model separately
    const config = loadConfig();
    if (!process.env.ANTHROPIC_MODEL) {
      const model = process.env.ARGUS_ANTHROPIC_MODEL || config.model;
      if (model) {
        process.env.ANTHROPIC_MODEL = model;
      }
    }
  } catch {
    // Don't throw during initialization, let getAuthConfig throw when actually needed
  }
}

/**
 * Get API key (uses getAuthConfig internally)
 * @throws Error if no credentials configured
 */
export function getApiKey(): string {
  return getAuthConfig().apiKey;
}

/**
 * Get base URL (uses getAuthConfig internally)
 * @throws Error if no credentials configured
 */
export function getBaseUrl(): string | undefined {
  return getAuthConfig().baseUrl;
}

/**
 * Get model with fallback chain
 * Priority: env var > config file
 */
export function getModel(): string | undefined {
  const config = loadConfig();
  return process.env.ARGUS_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || config.model;
}
