/**
 * Configuration Store
 *
 * Manages persistent configuration stored in user's home directory.
 * Config file: ~/.argus/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Configuration structure
 */
export interface ArgusConfig {
  /** Anthropic API key */
  apiKey?: string;
  /** Custom base URL (for proxies) */
  baseUrl?: string;
  /** Model to use */
  model?: string;
}

/**
 * Get config directory path
 */
function getConfigDir(): string {
  return join(homedir(), '.argus');
}

/**
 * Get config file path
 */
function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load configuration from file
 */
export function loadConfig(): ArgusConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as ArgusConfig;
  } catch {
    console.error(`Warning: Failed to parse config file at ${configPath}`);
    return {};
  }
}

/**
 * Save configuration to file
 */
export function saveConfig(config: ArgusConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();

  // Merge with existing config
  const existing = loadConfig();
  const merged = { ...existing, ...config };

  // Remove undefined values
  const cleaned = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));

  writeFileSync(configPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf-8');
}

/**
 * Get a specific config value
 */
export function getConfigValue<K extends keyof ArgusConfig>(key: K): ArgusConfig[K] {
  const config = loadConfig();
  return config[key];
}

/**
 * Set a specific config value
 */
export function setConfigValue<K extends keyof ArgusConfig>(key: K, value: ArgusConfig[K]): void {
  saveConfig({ [key]: value } as ArgusConfig);
}

/**
 * Delete a specific config value
 */
export function deleteConfigValue(key: keyof ArgusConfig): void {
  const config = loadConfig();
  delete config[key];

  ensureConfigDir();
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Clear all configuration
 */
export function clearConfig(): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  writeFileSync(configPath, '{}\n', 'utf-8');
}

/**
 * Get config file location (for display purposes)
 */
export function getConfigLocation(): string {
  return getConfigPath();
}
