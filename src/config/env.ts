/**
 * Environment configuration for Argus
 *
 * This module ensures that ANTHROPIC_* variables are set from ARGUS_* variables
 * to avoid conflicts with global Claude installations.
 *
 * Priority order (highest to lowest):
 * 1. Environment variables (ARGUS_ANTHROPIC_* or ANTHROPIC_*)
 * 2. Config file (~/.argus/config.json)
 */

import { loadConfig } from './store.js';

/**
 * Initialize environment variables for Claude Agent SDK
 * Copies ARGUS_* variables to ANTHROPIC_* if the latter are not set
 */
export function initializeEnv(): void {
  // Load config file values as fallback
  const config = loadConfig();

  // Only set ANTHROPIC_* if they're not already set in the environment
  // This allows environment variables to override .env file values and config file

  if (!process.env.ANTHROPIC_API_KEY) {
    const apiKey = process.env.ARGUS_ANTHROPIC_API_KEY || config.apiKey;
    if (apiKey) {
      process.env.ANTHROPIC_API_KEY = apiKey;
    }
  }

  if (!process.env.ANTHROPIC_BASE_URL) {
    const baseUrl = process.env.ARGUS_ANTHROPIC_BASE_URL || config.baseUrl;
    if (baseUrl) {
      process.env.ANTHROPIC_BASE_URL = baseUrl;
    }
  }

  if (!process.env.ANTHROPIC_MODEL) {
    const model = process.env.ARGUS_ANTHROPIC_MODEL || config.model;
    if (model) {
      process.env.ANTHROPIC_MODEL = model;
    }
  }
}

/**
 * Get API key with fallback chain
 * Priority: env var > config file
 */
export function getApiKey(): string {
  const config = loadConfig();
  return (
    process.env.ARGUS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || config.apiKey || ''
  );
}

/**
 * Get base URL with fallback chain
 * Priority: env var > config file
 */
export function getBaseUrl(): string | undefined {
  const config = loadConfig();
  return process.env.ARGUS_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || config.baseUrl;
}

/**
 * Get model with fallback chain
 * Priority: env var > config file
 */
export function getModel(): string | undefined {
  const config = loadConfig();
  return process.env.ARGUS_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || config.model;
}
