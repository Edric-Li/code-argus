/**
 * ClaudeProvider - Anthropic Claude API implementation
 * Based on official @anthropic-ai/sdk
 */

import Anthropic from '@anthropic-ai/sdk';
import { BaseLLM } from './base.js';
import type {
  LLMProviderConfig,
  LLMProviderType,
  ChatResponse,
  LLMResponseMetadata,
} from '../types.js';

/**
 * Claude-specific configuration
 */
export interface ClaudeProviderConfig extends LLMProviderConfig {
  model?: string;
}

/**
 * Default Claude model
 */
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-5-20251101';

/**
 * ClaudeProvider - Implementation for Anthropic Claude API
 * Supports custom baseURL for proxy services
 */
export class ClaudeProvider extends BaseLLM {
  readonly name: LLMProviderType = 'claude';
  readonly model: string;

  private client: Anthropic;

  constructor(config: ClaudeProviderConfig) {
    super(config);
    this.validateConfig();

    this.model = config.model ?? DEFAULT_CLAUDE_MODEL;

    // Initialize Anthropic client with optional custom baseURL
    this.client = new Anthropic({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
    });
  }

  /**
   * Create provider from environment variables
   * Uses ANTHROPIC_API_KEY for consistency with Claude Agent SDK
   */
  static fromEnv(): ClaudeProvider {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    const baseURL = process.env['ANTHROPIC_BASE_URL'];
    const model = process.env['ANTHROPIC_MODEL'];

    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    return new ClaudeProvider({
      apiKey,
      baseURL: baseURL || undefined,
      model: model || undefined,
    });
  }

  /**
   * Basic chat completion
   */
  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.chatWithMetadata(systemPrompt, userPrompt);
    return response.content;
  }

  /**
   * Chat with full metadata
   */
  async chatWithMetadata(systemPrompt: string, userPrompt: string): Promise<ChatResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.config.maxTokens ?? this.defaultMaxTokens,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    // Extract text content from response
    const textContent = response.content.find((block) => block.type === 'text');
    const content = textContent?.type === 'text' ? textContent.text : '';

    const metadata: LLMResponseMetadata = {
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      finishReason: response.stop_reason ?? undefined,
    };

    return { content, metadata };
  }

  /**
   * Test connection to Claude API
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: 'Say OK',
          },
        ],
      });
      return response.content.length > 0;
    } catch (error) {
      console.error('Claude connection test failed:', error);
      return false;
    }
  }
}
