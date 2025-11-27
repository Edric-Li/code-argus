/**
 * LLM Service Test Script
 * Run: npm run exec src/llm/test-llm.ts
 */

import 'dotenv/config';
import { llm, LLMFactory } from './index.js';
import { getBaseUrl } from '../config/env.js';

async function testConnection() {
  console.log('🔗 Testing connection...\n');

  const provider = llm.getProvider();
  console.log(`Provider: ${provider.name}`);
  console.log(`Model: ${provider.model}`);
  console.log(`Base URL: ${getBaseUrl() ?? 'default'}\n`);

  const connected = await llm.testConnection();
  console.log(`Connection: ${connected ? '✅ Success' : '❌ Failed'}\n`);

  return connected;
}

async function testChat() {
  console.log('💬 Testing chat()...\n');

  const response = await llm.chat(
    'You are a helpful assistant. Be concise.',
    'What is 2 + 2? Answer in one word.'
  );

  console.log(`Response: ${response}\n`);
}

async function testChatWithMetadata() {
  console.log('📊 Testing chatWithMetadata()...\n');

  const response = await llm.chatWithMetadata(
    'You are a helpful assistant.',
    'Say hello in exactly 3 words.'
  );

  console.log(`Content: ${response.content}`);
  console.log(`Model: ${response.metadata.model}`);
  console.log(`Input tokens: ${response.metadata.inputTokens}`);
  console.log(`Output tokens: ${response.metadata.outputTokens}`);
  console.log(`Total tokens: ${response.metadata.totalTokens}\n`);
}

async function testChatJSON() {
  console.log('📦 Testing chatJSON()...\n');

  interface UserInfo {
    name: string;
    age: number;
    skills: string[];
  }

  const response = await llm.chatJSON<UserInfo>(
    'You are a data generator. Always respond with valid JSON.',
    'Generate a fake user profile with fields: name (string), age (number), skills (array of strings). Include exactly 3 skills.'
  );

  console.log('Parsed JSON response:');
  console.log(JSON.stringify(response, null, 2));
  console.log(`\nType check - name: ${typeof response.name}`);
  console.log(`Type check - age: ${typeof response.age}`);
  console.log(`Type check - skills is array: ${Array.isArray(response.skills)}\n`);
}

async function testFactory() {
  console.log('🏭 Testing LLMFactory...\n');

  console.log(`Available providers: ${LLMFactory.getAvailableProviders().join(', ')}`);
  console.log(`Claude available: ${LLMFactory.isProviderAvailable('claude')}`);
  console.log(`OpenAI available: ${LLMFactory.isProviderAvailable('openai')}\n`);
}

async function main() {
  console.log('═'.repeat(50));
  console.log('       LLM Service Layer Test Suite');
  console.log('═'.repeat(50) + '\n');

  try {
    // Test factory info
    await testFactory();

    // Test connection
    const connected = await testConnection();
    if (!connected) {
      console.error('❌ Connection failed. Check your API key and base URL.');
      process.exit(1);
    }

    // Test basic chat
    await testChat();

    // Test chat with metadata
    await testChatWithMetadata();

    // Test JSON response
    await testChatJSON();

    console.log('═'.repeat(50));
    console.log('       ✅ All tests passed!');
    console.log('═'.repeat(50));
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

main();
