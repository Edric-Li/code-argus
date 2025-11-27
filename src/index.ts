#!/usr/bin/env node
/**
 * @argus/core - Automated Code Review CLI Tool
 * Main Entry Point
 */

import 'dotenv/config';
import { initializeEnv } from './config/env.js';

// Initialize environment variables for Claude Agent SDK
initializeEnv();

import { getDiff } from './git/diff.js';
import { GitError } from './git/type.js';
import { parseDiff } from './git/parser.js';
import { getPRCommits } from './git/commits.js';
import { createDiffAnalyzer } from './analyzer/index.js';
import { analyzeIntent, filterCommits } from './intent/index.js';
import { review, formatReport } from './review/index.js';
import { loadConfig, saveConfig, deleteConfigValue, getConfigLocation } from './config/store.js';

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Usage: argus <command> [options]

Commands:
  analyze <repo> <source> <target>   Run diff analysis and intent detection
  review <repo> <source> <target>    Run full AI code review with multiple agents
  config                             Manage configuration (API key, base URL, model)

Arguments (for analyze/review):
  repo          Path to the git repository
  source        Source branch name (will use origin/<source>)
  target        Target branch name (will use origin/<target>)

Options (review command):
  --format=<format>    Output format: json | markdown (default) | summary | pr-comments
  --language=<lang>    Output language: zh (default) | en
  --config-dir=<path>  Config directory (auto-loads rules/ and agents/)
  --rules-dir=<path>   Custom review rules directory
  --agents-dir=<path>  Custom agent definitions directory
  --skip-validation    Skip issue validation (faster but less accurate)
  --monitor            Enable real-time status monitoring UI
  --monitor-port=<num> Status monitor port (default: 3456)
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
  argus config set api-key sk-ant-xxx
  argus config set base-url https://my-proxy.com/v1
  argus config list
  argus review /path/to/repo feature-branch main --format=markdown
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
  format: 'json' | 'markdown' | 'summary' | 'pr-comments';
  language: 'en' | 'zh';
  configDirs: string[];
  rulesDirs: string[];
  customAgentsDirs: string[];
  skipValidation: boolean;
  monitor: boolean;
  monitorPort: number;
  verbose: boolean;
} {
  const options = {
    format: 'markdown' as 'json' | 'markdown' | 'summary' | 'pr-comments',
    language: 'zh' as 'en' | 'zh',
    configDirs: [] as string[],
    rulesDirs: [] as string[],
    customAgentsDirs: [] as string[],
    skipValidation: false,
    monitor: false,
    monitorPort: 3456,
    verbose: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--format=')) {
      const format = arg.split('=')[1];
      if (
        format === 'json' ||
        format === 'markdown' ||
        format === 'summary' ||
        format === 'pr-comments'
      ) {
        options.format = format;
      }
    } else if (arg.startsWith('--language=')) {
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
    } else if (arg === '--monitor') {
      options.monitor = true;
    } else if (arg.startsWith('--monitor-port=')) {
      const port = parseInt(arg.split('=')[1] || '3456', 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        options.monitorPort = port;
      }
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
  sourceBranch: string,
  targetBranch: string,
  options: ReturnType<typeof parseOptions>
): Promise<void> {
  const configInfo =
    options.configDirs.length > 0 ? `Config:        ${options.configDirs.join(', ')}` : '';
  const rulesInfo =
    options.rulesDirs.length > 0 ? `Rules:         ${options.rulesDirs.join(', ')}` : '';
  const agentsInfo =
    options.customAgentsDirs.length > 0
      ? `Custom Agents: ${options.customAgentsDirs.join(', ')}`
      : '';

  console.log(`
@argus/core - AI Code Review
=================================
Repository:    ${repoPath}
Source Branch: ${sourceBranch}
Target Branch: ${targetBranch}
Format:        ${options.format}${configInfo ? '\n' + configInfo : ''}${rulesInfo ? '\n' + rulesInfo : ''}${agentsInfo ? '\n' + agentsInfo : ''}
=================================
`);

  const report = await review({
    repoPath,
    sourceBranch,
    targetBranch,
    options: {
      verbose: options.verbose,
      skipValidation: options.skipValidation,
      monitor: options.monitor,
      monitorPort: options.monitorPort,
      rulesDirs: options.rulesDirs,
      customAgentsDirs: options.customAgentsDirs,
    },
  });

  // Output formatted report
  const formatted = formatReport(report, {
    format: options.format,
    language: options.language,
  });
  console.log(formatted);
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

  // For analyze/review commands, check for minimum arguments
  if (args.length < 3 && firstArg !== 'analyze' && firstArg !== 'review') {
    // Legacy mode with too few args
    console.error('Error: Invalid number of arguments\n');
    printUsage();
    process.exit(1);
  }

  if ((firstArg === 'analyze' || firstArg === 'review') && args.length < 4) {
    console.error(`Error: ${firstArg} command requires <repo> <source> <target>\n`);
    printUsage();
    process.exit(1);
  }

  let command = 'analyze';
  let repoPath: string;
  let sourceBranch: string;
  let targetBranch: string;
  let optionArgs: string[];

  if (firstArg === 'analyze' || firstArg === 'review') {
    command = firstArg;
    repoPath = args[1] ?? '';
    sourceBranch = args[2] ?? '';
    targetBranch = args[3] ?? '';
    optionArgs = args.slice(4);
  } else {
    // Legacy mode: no command specified, default to analyze
    repoPath = args[0] ?? '';
    sourceBranch = args[1] ?? '';
    targetBranch = args[2] ?? '';
    optionArgs = args.slice(3);
  }

  // Validate arguments are not empty
  if (!repoPath || !sourceBranch || !targetBranch) {
    console.error('Error: All arguments must be non-empty\n');
    printUsage();
    process.exit(1);
  }

  try {
    // Handle review command
    if (command === 'review') {
      const options = parseOptions(optionArgs);
      await runReviewCommand(repoPath, sourceBranch, targetBranch, options);
      return;
    }

    // Default: analyze command
    const remote = 'origin'; // Default remote
    console.log(`
@argus/core - Git Diff Extraction
=================================
Repository:    ${repoPath}
Source Branch: ${sourceBranch} (using ${remote}/${sourceBranch})
Target Branch: ${targetBranch} (using ${remote}/${targetBranch})
Diff Command:  git diff ${remote}/${targetBranch}...${remote}/${sourceBranch}
=================================
`);

    // Get the raw diff
    const rawDiff = getDiff(repoPath, sourceBranch, targetBranch);

    if (!rawDiff.trim()) {
      console.log('No differences found between the branches.');
      return;
    }

    // Parse and categorize the diff
    console.log('Parsing and categorizing diff files...\n');
    const files = parseDiff(rawDiff);

    // Summary statistics
    const summary = files.reduce(
      (acc, file) => {
        acc[file.category] = (acc[file.category] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    console.log(`Parsed ${files.length} file(s):`);
    console.log('=================================');
    console.log('Category Summary:');
    for (const [category, count] of Object.entries(summary)) {
      console.log(`  ${category.padEnd(12)}: ${count} file(s)`);
    }
    console.log('=================================\n');

    // Analyze with LLM
    console.log('Analyzing changes with LLM...\n');
    const analyzer = createDiffAnalyzer();
    const result = await analyzer.analyze(files);

    // Output analysis results
    console.log('=================================');
    console.log('Analysis Results:');
    console.log('=================================\n');

    // Group by risk level
    const highRisk = result.changes.filter((c) => c.risk_level === 'HIGH');
    const mediumRisk = result.changes.filter((c) => c.risk_level === 'MEDIUM');
    const lowRisk = result.changes.filter((c) => c.risk_level === 'LOW');

    if (highRisk.length > 0) {
      console.log('🔴 HIGH RISK:');
      for (const change of highRisk) {
        console.log(`  - ${change.file_path}`);
        const hints = change.semantic_hints;

        // Show changed interfaces
        if (hints.interfaces?.length) {
          for (const iface of hints.interfaces) {
            console.log(`    [Interface] ${iface.name}`);
            if (iface.added_fields?.length) {
              console.log(`      + added: ${iface.added_fields.join(', ')}`);
            }
            if (iface.removed_fields?.length) {
              console.log(`      - removed: ${iface.removed_fields.join(', ')}`);
            }
          }
        }

        // Show changed functions
        if (hints.functions?.length) {
          for (const func of hints.functions) {
            const exported = func.is_exported ? ' (exported)' : '';
            console.log(`    [Function] ${func.name} - ${func.change_type}${exported}`);
            if (func.added_params?.length) {
              console.log(`      + params: ${func.added_params.join(', ')}`);
            }
            if (func.removed_params?.length) {
              console.log(`      - params: ${func.removed_params.join(', ')}`);
            }
          }
        }

        // Show summary if no details
        if (!hints.interfaces?.length && !hints.functions?.length && hints.summary) {
          console.log(`    → ${hints.summary}`);
        }
      }
      console.log();
    }

    if (mediumRisk.length > 0) {
      console.log('🟡 MEDIUM RISK:');
      for (const change of mediumRisk) {
        console.log(`  - ${change.file_path}`);
        if (change.semantic_hints.summary) {
          console.log(`    → ${change.semantic_hints.summary}`);
        }
      }
      console.log();
    }

    if (lowRisk.length > 0) {
      console.log('🟢 LOW RISK:');
      for (const change of lowRisk) {
        console.log(`  - ${change.file_path}`);
        if (change.semantic_hints.summary) {
          console.log(`    → ${change.semantic_hints.summary}`);
        }
      }
      console.log();
    }

    // Metadata
    console.log('=================================');
    console.log('Diff Analysis Metadata:');
    console.log('=================================');
    console.log(`  Total files:    ${result.metadata.total_files}`);
    console.log(`  Analyzed:       ${result.metadata.analyzed_files}`);
    console.log(`  Skipped:        ${result.metadata.skipped_files}`);
    console.log(`  Batches:        ${result.metadata.batches}`);
    console.log(`  Tokens used:    ${result.metadata.total_tokens}`);

    // Get PR commits
    console.log('\n=================================');
    console.log('Fetching PR Commits...');
    console.log('=================================\n');

    const commits = getPRCommits(repoPath, sourceBranch, targetBranch, remote);
    const filterResult = filterCommits(commits);

    console.log(`Total commits: ${filterResult.stats.total}`);
    console.log(`  Valid:   ${filterResult.stats.valid}`);
    console.log(`  Reverts: ${filterResult.stats.reverts}`);
    console.log(`  Vague:   ${filterResult.stats.vague}`);
    console.log(`  Merges:  ${filterResult.stats.merges}`);

    if (filterResult.valid.length > 0) {
      console.log('\nValid commits:');
      for (const commit of filterResult.valid) {
        console.log(`  - ${commit.subject}`);
      }
    }

    if (filterResult.excluded.length > 0) {
      console.log('\nExcluded commits:');
      for (const commit of filterResult.excluded) {
        console.log(`  - [${commit.excludeReason}] ${commit.subject}`);
      }
    }

    // Intent Analysis
    console.log('\n=================================');
    console.log('Analyzing PR Intent...');
    console.log('=================================\n');

    const intent = await analyzeIntent(commits, result, filterResult);

    // Display intent analysis
    console.log('📋 Intent Analysis:');
    console.log('=================================\n');

    console.log(`🎯 Primary Goal: ${intent.primary_goal}\n`);

    console.log('📝 Summary:');
    console.log(`${intent.summary}\n`);

    if (intent.change_categories.length > 0) {
      console.log(`🏷️  Categories: ${intent.change_categories.join(', ')}`);
    }

    console.log(`📊 Confidence: ${intent.confidence}`);

    console.log('\n=================================');
    console.log('Intent Metadata:');
    console.log('=================================');
    console.log(`  Total commits:    ${intent.metadata.total_commits}`);
    console.log(`  Valid commits:    ${intent.metadata.valid_commits}`);
    console.log(`  Excluded commits: ${intent.metadata.excluded_commits}`);
    console.log(`  Tokens used:      ${intent.metadata.tokens_used}`);

    // Output full JSON for debugging
    console.log('\n=================================');
    console.log('Full Analysis (JSON):');
    console.log('=================================');
    console.log(JSON.stringify({ diffAnalysis: result, intentAnalysis: intent }, null, 2));
  } catch (error) {
    if (error instanceof GitError) {
      console.error(`\nGit Error: ${error.message}`);
      if (error.stderr) {
        console.error(`Details: ${error.stderr}`);
      }
      process.exit(1);
    }

    // Unexpected error
    console.error('\nUnexpected error:', error);
    process.exit(1);
  }
}

// Run CLI
main();
