#!/usr/bin/env node
/**
 * @argus/core - Automated Code Review CLI Tool
 * Main Entry Point
 */

// Global error handlers - must be set up first to catch any errors during startup
process.on('uncaughtException', (error, origin) => {
  console.error(`[Argus] Fatal: Uncaught exception from ${origin}:`, error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Argus] Fatal: Unhandled promise rejection:', reason);
  process.exit(1);
});

import 'dotenv/config';
import { initializeEnv } from './config/env.js';

// Initialize environment variables for Claude Agent SDK
initializeEnv();

import {
  reviewByRefs,
  formatReport,
  loadPreviousReview,
  validatePreviousReviewData,
} from './review/index.js';
import { detectRefType } from './git/ref.js';
import { loadConfig, saveConfig, deleteConfigValue, getConfigLocation } from './config/store.js';
import type { PreviousReviewData } from './review/types.js';

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
  --json-logs              Output as JSON event stream (for service integration)
                           All progress and final report are output as JSON lines
  --language=<lang>        Output language: zh (default) | en
  --config-dir=<path>      Config directory (auto-loads rules/ and agents/)
  --rules-dir=<path>       Custom review rules directory
  --agents-dir=<path>      Custom agent definitions directory
  --skip-validation        Skip issue validation (faster but less accurate)
  --verbose                Enable verbose output
  --previous-review=<file> Previous review JSON file for fix verification
  --no-verify-fixes        Disable fix verification (when previous-review is set)

External Diff Options (for integration with PR systems):
  --diff-file=<path>       Read diff from file instead of computing from git
  --diff-stdin             Read diff from stdin instead of computing from git
  --commits=<sha1,sha2>    Only diff specific commits (comma-separated)
  --no-smart-merge-filter  Disable smart merge filtering for incremental mode

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

  # Verify fixes from previous review
  argus review /path/to/repo feature-branch main --previous-review=./review-1.json

  # External diff from file (e.g., from Bitbucket API)
  argus review /path/to/repo --diff-file=./pr.diff

  # External diff from stdin
  curl -s "https://bitbucket.org/api/..." | argus review /path/to/repo --diff-stdin

  # Only review specific commits (skip merge commits)
  argus review /path/to/repo --commits=abc123,def456,ghi789
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
 * External diff options parsed from CLI
 */
interface ExternalDiffOptions {
  diffFile?: string;
  diffStdin?: boolean;
  commits?: string[];
  disableSmartMergeFilter?: boolean;
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
  previousReview?: string;
  verifyFixes?: boolean;
  externalDiff: ExternalDiffOptions;
} {
  const options: {
    language: 'en' | 'zh';
    configDirs: string[];
    rulesDirs: string[];
    customAgentsDirs: string[];
    skipValidation: boolean;
    jsonLogs: boolean;
    verbose: boolean;
    previousReview?: string;
    verifyFixes?: boolean;
    externalDiff: ExternalDiffOptions;
  } = {
    language: 'zh',
    configDirs: [],
    rulesDirs: [],
    customAgentsDirs: [],
    skipValidation: false,
    jsonLogs: false,
    verbose: false,
    previousReview: undefined,
    verifyFixes: undefined,
    externalDiff: {},
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
    } else if (arg.startsWith('--previous-review=')) {
      const filePath = arg.split('=')[1];
      if (filePath) {
        options.previousReview = filePath;
        // Auto-enable fix verification unless explicitly disabled
        if (options.verifyFixes === undefined) {
          options.verifyFixes = true;
        }
      }
    } else if (arg === '--no-verify-fixes') {
      options.verifyFixes = false;
    } else if (arg === '--verify-fixes') {
      options.verifyFixes = true;
    } else if (arg.startsWith('--diff-file=')) {
      const filePath = arg.split('=')[1];
      if (filePath) {
        options.externalDiff.diffFile = filePath;
      }
    } else if (arg === '--diff-stdin') {
      options.externalDiff.diffStdin = true;
    } else if (arg.startsWith('--commits=')) {
      const commits = arg.split('=')[1];
      if (commits) {
        options.externalDiff.commits = commits.split(',').map((c) => c.trim());
      }
    } else if (arg === '--no-smart-merge-filter') {
      options.externalDiff.disableSmartMergeFilter = true;
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
  sourceRef: string | undefined,
  targetRef: string | undefined,
  options: ReturnType<typeof parseOptions>
): Promise<void> {
  // Determine review mode based on inputs
  const hasExternalDiff =
    options.externalDiff.diffFile || options.externalDiff.diffStdin || options.externalDiff.commits;

  // If using external diff, refs are optional
  let modeLabel: string;
  let sourceType: string | undefined;
  let targetType: string | undefined;

  if (hasExternalDiff) {
    modeLabel = '外部 Diff (External)';
    if (options.externalDiff.diffFile) {
      modeLabel += ` - 文件: ${options.externalDiff.diffFile}`;
    } else if (options.externalDiff.diffStdin) {
      modeLabel += ' - stdin';
    } else if (options.externalDiff.commits) {
      modeLabel += ` - ${options.externalDiff.commits.length} commits`;
    }
  } else if (sourceRef && targetRef) {
    sourceType = detectRefType(sourceRef);
    targetType = detectRefType(targetRef);
    const isIncremental = sourceType === 'commit' && targetType === 'commit';
    modeLabel = isIncremental ? '增量审查 (Incremental)' : '分支审查 (Branch)';
  } else {
    console.error('Error: Either refs (source/target) or external diff options are required\n');
    printUsage();
    process.exit(1);
  }

  // Load previous review if specified
  let previousReviewData: PreviousReviewData | undefined;
  if (options.previousReview) {
    try {
      previousReviewData = loadPreviousReview(options.previousReview);
      validatePreviousReviewData(previousReviewData);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: Failed to load previous review: ${message}`);
      process.exit(1);
    }
  }

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
    const prevReviewInfo = previousReviewData
      ? `Prev Review:   ${options.previousReview} (${previousReviewData.issues.length} issues)`
      : '';

    if (hasExternalDiff) {
      console.log(`
@argus/core - AI Code Review
=================================
Repository:    ${repoPath}
Review Mode:   ${modeLabel}${configInfo ? '\n' + configInfo : ''}${rulesInfo ? '\n' + rulesInfo : ''}${agentsInfo ? '\n' + agentsInfo : ''}${prevReviewInfo ? '\n' + prevReviewInfo : ''}
=================================
`);
    } else {
      const sourceLabel = sourceType === 'commit' ? 'Source Commit' : 'Source Branch';
      const targetLabel = targetType === 'commit' ? 'Target Commit' : 'Target Branch';

      console.log(`
@argus/core - AI Code Review
=================================
Repository:    ${repoPath}
${sourceLabel}: ${sourceRef}
${targetLabel}: ${targetRef}
Review Mode:   ${modeLabel}${configInfo ? '\n' + configInfo : ''}${rulesInfo ? '\n' + rulesInfo : ''}${agentsInfo ? '\n' + agentsInfo : ''}${prevReviewInfo ? '\n' + prevReviewInfo : ''}
=================================
`);
    }
  }

  // Build external diff input if provided
  const externalDiffInput = hasExternalDiff
    ? {
        diffFile: options.externalDiff.diffFile,
        diffStdin: options.externalDiff.diffStdin,
        commits: options.externalDiff.commits,
        disableSmartMergeFilter: options.externalDiff.disableSmartMergeFilter,
      }
    : undefined;

  // Use the new reviewByRefs API which auto-detects ref types
  const report = await reviewByRefs({
    repoPath,
    sourceRef,
    targetRef,
    externalDiff: externalDiffInput,
    options: {
      verbose: options.verbose,
      skipValidation: options.skipValidation,
      rulesDirs: options.rulesDirs,
      customAgentsDirs: options.customAgentsDirs,
      // Use JSON logs mode if specified, otherwise auto-detect
      progressMode: options.jsonLogs ? 'json' : 'auto',
      // Fix verification options
      previousReviewData,
      verifyFixes: options.verifyFixes,
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
    // 安全写入 stderr，避免 ERR_STREAM_WRITE_AFTER_END 错误
    if (process.stderr.writable) {
      try {
        process.stderr.write(JSON.stringify(reportEvent) + '\n');
      } catch {
        // 忽略写入错误
      }
    }
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
    // Parse all arguments to check for external diff options
    const allArgs = args.slice(1);
    const optionArgs = allArgs.filter((a) => a.startsWith('--'));
    const positionalArgs = allArgs.filter((a) => !a.startsWith('--'));
    const options = parseOptions(optionArgs);

    // Check if using external diff mode
    const hasExternalDiff =
      options.externalDiff.diffFile ||
      options.externalDiff.diffStdin ||
      options.externalDiff.commits;

    let repoPath: string;
    let sourceRef: string | undefined;
    let targetRef: string | undefined;

    if (hasExternalDiff) {
      // External diff mode: only repo path is required
      if (positionalArgs.length < 1) {
        console.error('Error: review command with external diff requires <repo>\n');
        printUsage();
        process.exit(1);
      }
      repoPath = positionalArgs[0] ?? '';
      sourceRef = positionalArgs[1]; // Optional
      targetRef = positionalArgs[2]; // Optional
    } else {
      // Normal mode: repo, source, target are required
      if (positionalArgs.length < 3) {
        console.error('Error: review command requires <repo> <source> <target>\n');
        printUsage();
        process.exit(1);
      }
      repoPath = positionalArgs[0] ?? '';
      sourceRef = positionalArgs[1] ?? '';
      targetRef = positionalArgs[2] ?? '';

      // Validate arguments are not empty
      if (!repoPath || !sourceRef || !targetRef) {
        console.error('Error: All arguments must be non-empty\n');
        printUsage();
        process.exit(1);
      }
    }

    try {
      await runReviewCommand(repoPath, sourceRef, targetRef, options);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Output JSON error event if in json-logs mode
      if (options.jsonLogs) {
        const errorEvent = {
          type: 'review:error',
          data: {
            error: errorMsg,
            stack: errorStack,
            timestamp: new Date().toISOString(),
          },
        };
        // 安全写入 stderr，避免 ERR_STREAM_WRITE_AFTER_END 错误
        if (process.stderr.writable) {
          try {
            process.stderr.write(JSON.stringify(errorEvent) + '\n');
          } catch {
            // 忽略写入错误
          }
        }
      }

      // Also output human-readable error
      if (error instanceof Error) {
        console.error(`\n❌ Review failed: ${error.message}`);
        // 显示堆栈信息以便调试
        if (options.verbose || process.env.DEBUG) {
          console.error('\nStack trace:');
          console.error(error.stack);
        } else if (!options.jsonLogs) {
          console.error('(Run with --verbose or DEBUG=1 to see stack trace)');
        }
      } else {
        console.error('\n❌ Unexpected error:', error);
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
