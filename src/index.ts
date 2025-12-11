#!/usr/bin/env node
/**
 * @argus/core - Automated Code Review CLI Tool
 * Main Entry Point
 */

import 'dotenv/config';
import { initializeEnv } from './config/env.js';

// Initialize environment variables for Claude Agent SDK
initializeEnv();

import { reviewByRefs, formatReport } from './review/index.js';
import { detectRefType } from './git/ref.js';
import { loadConfig, saveConfig, deleteConfigValue, getConfigLocation } from './config/store.js';

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Usage: argus <command> [options]

Commands:
  review <repo> <source> <target>    Run AI code review with multiple agents
  config                             Manage configuration (API key, base URL, model)

Arguments (for review):
  repo          Path to the git repository
  source        Source branch name or commit SHA
  target        Target branch name or commit SHA

  The tool auto-detects whether source/target are branches or commits:
  - Branch names: Uses three-dot diff (origin/target...origin/source)
  - Commit SHAs:  Uses two-dot diff (target..source) for incremental review

Options (review command):
  --json-logs          Output as JSON event stream (for service integration)
                       All progress and final report are output as JSON lines
  --language=<lang>    Output language: zh (default) | en
  --config-dir=<path>  Config directory (auto-loads rules/ and agents/)
  --rules-dir=<path>   Custom review rules directory
  --agents-dir=<path>  Custom agent definitions directory
  --skip-validation    Skip issue validation (faster but less accurate)
  --verbose            Enable verbose output

Config subcommands:
  argus config set <key> <value>     Set a configuration value
  argus config get <key>             Get a configuration value
  argus config list                  List all configuration
  argus config delete <key>          Delete a configuration value
  argus config path                  Show config file location

Config keys:
  api-key       Anthropic API key
  base-url      Custom API base URL (for proxies)
  model         Model to use (e.g., claude-sonnet-4-5-20250929)

Examples:
  # Branch-based review (initial PR review)
  argus review /path/to/repo feature-branch main

  # Commit-based review (incremental review)
  argus review /path/to/repo abc1234 def5678

  # With options
  argus review /path/to/repo feature-branch main --json-logs
  argus config set api-key sk-ant-xxx
`);
}

/**
 * Print config command usage
 */
function printConfigUsage(): void {
  console.log(`
Usage: argus config <subcommand> [options]

Subcommands:
  set <key> <value>    Set a configuration value
  get <key>            Get a configuration value
  list                 List all configuration
  delete <key>         Delete a configuration value
  path                 Show config file location

Keys:
  api-key       Anthropic API key
  base-url      Custom API base URL (for proxies)
  model         Model to use (e.g., claude-sonnet-4-5-20250929)

Examples:
  argus config set api-key sk-ant-api03-xxxxx
  argus config set base-url https://my-proxy.com/v1
  argus config set model claude-sonnet-4-5-20250929
  argus config get api-key
  argus config list
  argus config delete base-url
  argus config path

Note:
  Config is stored in ~/.argus/config.json
  Environment variables take precedence over config file values.
`);
}

/**
 * Handle config command
 */
function runConfigCommand(args: string[]): void {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printConfigUsage();
    return;
  }

  // Map CLI key names to config keys
  const keyMap: Record<string, 'apiKey' | 'baseUrl' | 'model'> = {
    'api-key': 'apiKey',
    apikey: 'apiKey',
    'base-url': 'baseUrl',
    baseurl: 'baseUrl',
    model: 'model',
  };

  switch (subcommand) {
    case 'set': {
      const key = args[1]?.toLowerCase();
      const value = args[2];

      if (!key || !value) {
        console.error('Error: config set requires <key> and <value>\n');
        printConfigUsage();
        process.exit(1);
      }

      const configKey = keyMap[key];
      if (!configKey) {
        console.error(`Error: Unknown config key "${key}"`);
        console.error('Valid keys: api-key, base-url, model');
        process.exit(1);
      }

      saveConfig({ [configKey]: value });

      // Mask API key in output
      const displayValue = configKey === 'apiKey' ? maskApiKey(value) : value;
      console.log(`Set ${key} = ${displayValue}`);
      break;
    }

    case 'get': {
      const key = args[1]?.toLowerCase();

      if (!key) {
        console.error('Error: config get requires <key>\n');
        printConfigUsage();
        process.exit(1);
      }

      const configKey = keyMap[key];
      if (!configKey) {
        console.error(`Error: Unknown config key "${key}"`);
        console.error('Valid keys: api-key, base-url, model');
        process.exit(1);
      }

      const config = loadConfig();
      const value = config[configKey];

      if (value) {
        // Mask API key in output
        const displayValue = configKey === 'apiKey' ? maskApiKey(value) : value;
        console.log(displayValue);
      } else {
        console.log(`(not set)`);
      }
      break;
    }

    case 'list': {
      const config = loadConfig();

      console.log('Current configuration:');
      console.log('=================================');

      if (Object.keys(config).length === 0) {
        console.log('(no configuration set)');
      } else {
        if (config.apiKey) {
          console.log(`api-key:   ${maskApiKey(config.apiKey)}`);
        }
        if (config.baseUrl) {
          console.log(`base-url:  ${config.baseUrl}`);
        }
        if (config.model) {
          console.log(`model:     ${config.model}`);
        }
      }

      console.log('=================================');
      console.log(`Config file: ${getConfigLocation()}`);
      break;
    }

    case 'delete': {
      const key = args[1]?.toLowerCase();

      if (!key) {
        console.error('Error: config delete requires <key>\n');
        printConfigUsage();
        process.exit(1);
      }

      const configKey = keyMap[key];
      if (!configKey) {
        console.error(`Error: Unknown config key "${key}"`);
        console.error('Valid keys: api-key, base-url, model');
        process.exit(1);
      }

      deleteConfigValue(configKey);
      console.log(`Deleted ${key}`);
      break;
    }

    case 'path': {
      console.log(getConfigLocation());
      break;
    }

    default:
      console.error(`Error: Unknown config subcommand "${subcommand}"\n`);
      printConfigUsage();
      process.exit(1);
  }
}

/**
 * Mask API key for display
 */
function maskApiKey(key: string): string {
  if (key.length <= 12) {
    return '***';
  }
  return key.slice(0, 8) + '...' + key.slice(-4);
}

/**
 * Parse CLI options from arguments
 */
function parseOptions(args: string[]): {
  language: 'en' | 'zh';
  configDirs: string[];
  rulesDirs: string[];
  customAgentsDirs: string[];
  skipValidation: boolean;
  jsonLogs: boolean;
  verbose: boolean;
} {
  const options = {
    language: 'zh' as 'en' | 'zh',
    configDirs: [] as string[],
    rulesDirs: [] as string[],
    customAgentsDirs: [] as string[],
    skipValidation: false,
    jsonLogs: false,
    verbose: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--language=')) {
      const language = arg.split('=')[1];
      if (language === 'en' || language === 'zh') {
        options.language = language;
      }
    } else if (arg.startsWith('--config-dir=')) {
      const dir = arg.split('=')[1];
      if (dir) {
        options.configDirs.push(dir);
      }
    } else if (arg.startsWith('--rules-dir=')) {
      const dir = arg.split('=')[1];
      if (dir) {
        options.rulesDirs.push(dir);
      }
    } else if (arg.startsWith('--agents-dir=')) {
      const dir = arg.split('=')[1];
      if (dir) {
        options.customAgentsDirs.push(dir);
      }
    } else if (arg === '--skip-validation') {
      options.skipValidation = true;
    } else if (arg === '--json-logs') {
      options.jsonLogs = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    }
  }

  // Expand config-dir into rules-dir and agents-dir
  for (const configDir of options.configDirs) {
    options.rulesDirs.push(`${configDir}/rules`);
    options.customAgentsDirs.push(`${configDir}/agents`);
  }

  return options;
}

/**
 * Run the review command
 */
async function runReviewCommand(
  repoPath: string,
  sourceRef: string,
  targetRef: string,
  options: ReturnType<typeof parseOptions>
): Promise<void> {
  // Auto-detect ref types
  const sourceType = detectRefType(sourceRef);
  const targetType = detectRefType(targetRef);
  const isIncremental = sourceType === 'commit' && targetType === 'commit';
  const modeLabel = isIncremental ? '增量审查 (Incremental)' : '分支审查 (Branch)';

  // In JSON logs mode, skip the banner - all output is JSON events
  if (!options.jsonLogs) {
    const configInfo =
      options.configDirs.length > 0 ? `Config:        ${options.configDirs.join(', ')}` : '';
    const rulesInfo =
      options.rulesDirs.length > 0 ? `Rules:         ${options.rulesDirs.join(', ')}` : '';
    const agentsInfo =
      options.customAgentsDirs.length > 0
        ? `Custom Agents: ${options.customAgentsDirs.join(', ')}`
        : '';

    const sourceLabel = sourceType === 'commit' ? 'Source Commit' : 'Source Branch';
    const targetLabel = targetType === 'commit' ? 'Target Commit' : 'Target Branch';

    console.log(`
@argus/core - AI Code Review
=================================
Repository:    ${repoPath}
${sourceLabel}: ${sourceRef}
${targetLabel}: ${targetRef}
Review Mode:   ${modeLabel}${configInfo ? '\n' + configInfo : ''}${rulesInfo ? '\n' + rulesInfo : ''}${agentsInfo ? '\n' + agentsInfo : ''}
=================================
`);
  }

  // Use the new reviewByRefs API which auto-detects ref types
  const report = await reviewByRefs({
    repoPath,
    sourceRef,
    targetRef,
    options: {
      verbose: options.verbose,
      skipValidation: options.skipValidation,
      rulesDirs: options.rulesDirs,
      customAgentsDirs: options.customAgentsDirs,
      // Use JSON logs mode if specified, otherwise auto-detect
      progressMode: options.jsonLogs ? 'json' : 'auto',
    },
  });

  if (options.jsonLogs) {
    // In JSON logs mode, output the report as a JSON event to stderr
    const reportEvent = {
      type: 'report',
      data: {
        report,
        timestamp: new Date().toISOString(),
      },
    };
    process.stderr.write(JSON.stringify(reportEvent) + '\n');
  } else {
    // In normal mode, output formatted markdown report
    const formatted = formatReport(report, {
      format: 'markdown',
      language: options.language,
    });
    console.log(formatted);
  }
}

/**
 * Main CLI function
 */
export async function main(): Promise<void> {
  // Parse command line arguments
  // process.argv[0] = node executable
  // process.argv[1] = script path
  // process.argv[2+] = user arguments
  const args = process.argv.slice(2);

  // Handle no arguments or help
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return;
  }

  // Check if first arg is a command
  const firstArg = args[0];

  // Handle config command
  if (firstArg === 'config') {
    runConfigCommand(args.slice(1));
    return;
  }

  // Handle review command
  if (firstArg === 'review') {
    if (args.length < 4) {
      console.error('Error: review command requires <repo> <source> <target>\n');
      printUsage();
      process.exit(1);
    }

    const repoPath = args[1] ?? '';
    const sourceRef = args[2] ?? '';
    const targetRef = args[3] ?? '';
    const optionArgs = args.slice(4);

    // Validate arguments are not empty
    if (!repoPath || !sourceRef || !targetRef) {
      console.error('Error: All arguments must be non-empty\n');
      printUsage();
      process.exit(1);
    }

    try {
      const options = parseOptions(optionArgs);
      await runReviewCommand(repoPath, sourceRef, targetRef, options);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`\nError: ${error.message}`);
      } else {
        console.error('\nUnexpected error:', error);
      }
      process.exit(1);
    }
    return;
  }

  // Unknown command
  console.error(`Error: Unknown command "${firstArg}"\n`);
  printUsage();
  process.exit(1);
}

// Run CLI
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
