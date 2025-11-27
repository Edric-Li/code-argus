/**
 * LLM Service Layer
 * Provides unified interface for multiple LLM providers
 *
 * Usage:
 * ```typescript
 * import { llm, LLMFactory } from './llm';
 *
 * // Use default singleton (based on LLM_PROVIDER env)
 * const response = await llm.chat('You are helpful.', 'Hello!');
 *
 * // Or create specific provider
 * const claude = LLMFactory.createClaude();
 * const json = await claude.chatJSON('Return JSON.', 'Give me user data.');
 * ```
 */

import 'dotenv/config';
import { initializeEnv } from '../config/env.js';

// Initialize environment for LLM providers
initializeEnv();

// Export types
export type {
  LLMProvider,
  LLMProviderType,
  LLMProviderConfig,
  ChatMessage,
  ChatResponse,
  ChatJSONResponse,
  LLMResponseMetadata,
} from './types.js';

// Export providers
export {
  BaseLLM,
  ClaudeProvider,
  OpenAIProvider,
  type ClaudeProviderConfig,
  type OpenAIProviderConfig,
} from './providers/index.js';

// Export factory
import { LLMFactory } from './factory.js';
export { LLMFactory };

// Import types for singleton
import type { LLMProvider, ChatResponse } from './types.js';

// Create and export singleton instance
let _instance: LLMProvider | null = null;

/**
 * Get default LLM provider singleton
 * Lazy-loaded based on LLM_PROVIDER environment variable
 */
export function getLLM(): LLMProvider {
  if (!_instance) {
    _instance = LLMFactory.create();
  }
  return _instance;
}

/**
 * Default LLM instance (lazy-loaded singleton)
 * Use this for quick access to the configured LLM provider
 */
export const llm = {
  /**
   * Chat with the LLM - returns plain text
   */
  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    return getLLM().chat(systemPrompt, userPrompt);
  },

  /**
   * Chat with JSON response - auto-parsed
   */
  async chatJSON<T = Record<string, unknown>>(
    systemPrompt: string,
    userPrompt: string
  ): Promise<T> {
    return getLLM().chatJSON<T>(systemPrompt, userPrompt);
  },

  /**
   * Chat with full response metadata
   */
  async chatWithMetadata(systemPrompt: string, userPrompt: string): Promise<ChatResponse> {
    return getLLM().chatWithMetadata(systemPrompt, userPrompt);
  },

  /**
   * Test connection to the provider
   */
  async testConnection(): Promise<boolean> {
    return getLLM().testConnection();
  },

  /**
   * Get the underlying provider instance
   */
  getProvider(): LLMProvider {
    return getLLM();
  },
};
