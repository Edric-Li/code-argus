/**
 * BaseLLM - Abstract base class for LLM providers
 * Implements common functionality and defines contract for providers
 */

import type { LLMProvider, LLMProviderConfig, LLMProviderType, ChatResponse } from '../types.js';

/**
 * Abstract base class for all LLM providers
 * Provides common utilities and enforces interface implementation
 */
export abstract class BaseLLM implements LLMProvider {
  abstract readonly name: LLMProviderType;
  abstract readonly model: string;

  protected config: LLMProviderConfig;
  protected defaultMaxTokens: number = 4096;
  protected defaultTemperature: number = 0.7;

  constructor(config: LLMProviderConfig) {
    this.config = {
      maxTokens: this.defaultMaxTokens,
      temperature: this.defaultTemperature,
      ...config,
    };
  }

  /**
   * Basic chat - to be implemented by providers
   */
  abstract chat(systemPrompt: string, userPrompt: string): Promise<string>;

  /**
   * Chat with metadata - to be implemented by providers
   */
  abstract chatWithMetadata(systemPrompt: string, userPrompt: string): Promise<ChatResponse>;

  /**
   * Chat with JSON response - common implementation with JSON parsing
   * Providers can override for native JSON mode support
   */
  async chatJSON<T = Record<string, unknown>>(
    systemPrompt: string,
    userPrompt: string
  ): Promise<T> {
    const jsonSystemPrompt = `${systemPrompt}

IMPORTANT: You MUST respond with valid JSON only. No markdown, no code blocks, no explanation.
Your entire response should be parseable JSON.`;

    const response = await this.chat(jsonSystemPrompt, userPrompt);
    return this.parseJSON<T>(response);
  }

  /**
   * Test connection - default implementation
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.chat('You are a helpful assistant.', "Say 'OK' if you can hear me.");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse JSON response with error handling
   */
  protected parseJSON<T>(response: string): T {
    // Try to extract JSON from markdown code blocks if present
    let jsonStr = response.trim();

    // Remove markdown code blocks if present
    const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch?.[1]) {
      jsonStr = jsonBlockMatch[1].trim();
    }

    try {
      return JSON.parse(jsonStr) as T;
    } catch (error) {
      throw new Error(
        `Failed to parse LLM response as JSON: ${error instanceof Error ? error.message : 'Unknown error'}\nResponse: ${response.substring(0, 500)}`
      );
    }
  }

  /**
   * Validate configuration
   */
  protected validateConfig(): void {
    if (!this.config.apiKey) {
      throw new Error(`API key is required for ${this.name} provider`);
    }
  }
}
