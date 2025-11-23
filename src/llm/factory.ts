/**
 * LLMFactory - Factory pattern for creating LLM provider instances
 */

import type { LLMProvider, LLMProviderType } from './types.js';
import { ClaudeProvider, OpenAIProvider } from './providers/index.js';

/**
 * Registry of available providers
 */
const providerRegistry: Record<LLMProviderType, { fromEnv: () => LLMProvider }> = {
  claude: ClaudeProvider,
  openai: OpenAIProvider,
  gemini: {
    fromEnv: () => {
      throw new Error('Gemini provider is not implemented yet');
    },
  },
  deepseek: {
    fromEnv: () => {
      throw new Error('DeepSeek provider is not implemented yet');
    },
  },
};

/**
 * LLMFactory - Creates LLM provider instances based on configuration
 */
export class LLMFactory {
  /**
   * Create a provider instance from environment variables
   * Uses LLM_PROVIDER env var to determine which provider to create
   * Defaults to 'claude' if not specified
   */
  static create(providerType?: LLMProviderType): LLMProvider {
    const type = providerType ?? (process.env['LLM_PROVIDER'] as LLMProviderType) ?? 'claude';

    const providerFactory = providerRegistry[type];

    if (!providerFactory) {
      const available = Object.keys(providerRegistry).join(', ');
      throw new Error(`Unknown LLM provider: ${type}. Available providers: ${available}`);
    }

    return providerFactory.fromEnv();
  }

  /**
   * Create a Claude provider specifically
   */
  static createClaude(): ClaudeProvider {
    return ClaudeProvider.fromEnv();
  }

  /**
   * Create an OpenAI provider specifically
   */
  static createOpenAI(): OpenAIProvider {
    return OpenAIProvider.fromEnv();
  }

  /**
   * Get list of available provider types
   */
  static getAvailableProviders(): LLMProviderType[] {
    return Object.keys(providerRegistry) as LLMProviderType[];
  }

  /**
   * Check if a provider type is available (implemented)
   */
  static isProviderAvailable(type: LLMProviderType): boolean {
    return type === 'claude'; // Only Claude is fully implemented
  }
}
