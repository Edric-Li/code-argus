/**
 * LLM Service Layer Type Definitions
 * Using Strategy Pattern for multi-provider support
 */

/**
 * Supported LLM providers
 */
export type LLMProviderType = 'claude' | 'openai' | 'gemini' | 'deepseek';

/**
 * Configuration options for LLM providers
 */
export interface LLMProviderConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Chat message structure
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Response metadata
 */
export interface LLMResponseMetadata {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  finishReason?: string;
}

/**
 * Chat response with metadata
 */
export interface ChatResponse {
  content: string;
  metadata: LLMResponseMetadata;
}

/**
 * JSON chat response
 */
export interface ChatJSONResponse<T = Record<string, unknown>> {
  data: T;
  metadata: LLMResponseMetadata;
}

/**
 * LLMProvider Interface - Strategy Pattern
 * All LLM providers must implement this interface
 */
export interface LLMProvider {
  readonly name: LLMProviderType;
  readonly model: string;

  /**
   * Basic chat completion - returns plain text
   * @param systemPrompt - System instructions
   * @param userPrompt - User message
   * @returns Plain text response
   */
  chat(systemPrompt: string, userPrompt: string): Promise<string>;

  /**
   * Chat completion with JSON response - auto-parsed
   * @param systemPrompt - System instructions
   * @param userPrompt - User message
   * @returns Parsed JSON object
   */
  chatJSON<T = Record<string, unknown>>(systemPrompt: string, userPrompt: string): Promise<T>;

  /**
   * Chat with full response including metadata
   * @param systemPrompt - System instructions
   * @param userPrompt - User message
   * @returns Response with content and metadata
   */
  chatWithMetadata(systemPrompt: string, userPrompt: string): Promise<ChatResponse>;

  /**
   * Test connection to the provider
   * @returns true if connection is successful
   */
  testConnection(): Promise<boolean>;
}
