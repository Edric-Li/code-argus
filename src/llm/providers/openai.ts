/**
 * OpenAIProvider - OpenAI API implementation (Placeholder)
 * TODO: Implement using official openai SDK
 */

import { BaseLLM } from './base.js';
import type { LLMProviderConfig, LLMProviderType, ChatResponse } from '../types.js';

/**
 * OpenAI-specific configuration
 */
export interface OpenAIProviderConfig extends LLMProviderConfig {
  model?: string;
}

/**
 * Default OpenAI model
 */
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

/**
 * OpenAIProvider - Placeholder implementation
 * TODO: Install `openai` package and implement
 */
export class OpenAIProvider extends BaseLLM {
  readonly name: LLMProviderType = 'openai';
  readonly model: string;

  constructor(config: OpenAIProviderConfig) {
    super(config);
    this.model = config.model ?? DEFAULT_OPENAI_MODEL;
    // Don't validate config since this is a placeholder
  }

  /**
   * Create provider from environment variables
   */
  static fromEnv(): OpenAIProvider {
    const apiKey = process.env['OPENAI_API_KEY'] ?? 'placeholder';
    const baseURL = process.env['OPENAI_BASE_URL'];
    const model = process.env['OPENAI_MODEL'];

    return new OpenAIProvider({
      apiKey,
      baseURL: baseURL || undefined,
      model: model || undefined,
    });
  }

  /**
   * Basic chat completion - NOT IMPLEMENTED
   */
  async chat(_systemPrompt: string, _userPrompt: string): Promise<string> {
    throw new Error(
      'OpenAIProvider is not implemented yet. Please install `openai` package and implement this method.'
    );
  }

  /**
   * Chat with full metadata - NOT IMPLEMENTED
   */
  async chatWithMetadata(_systemPrompt: string, _userPrompt: string): Promise<ChatResponse> {
    throw new Error(
      'OpenAIProvider is not implemented yet. Please install `openai` package and implement this method.'
    );
  }

  /**
   * Test connection - NOT IMPLEMENTED
   */
  async testConnection(): Promise<boolean> {
    console.warn('OpenAIProvider.testConnection() is not implemented');
    return false;
  }
}
