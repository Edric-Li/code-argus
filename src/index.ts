/**
 * @argus/core - Automated Code Review CLI Tool
 * Main Entry Point
 */

import 'dotenv/config';

import { getDiff } from './git/diff.js';
import { GitError } from './git/type.js';
import { parseDiff } from './git/parser.js';
import { getPRCommits } from './git/commits.js';
import { createDiffAnalyzer } from './analyzer/index.js';
import { analyzeIntent, filterCommits } from './intent/index.js';
import { streamingReview, formatReport } from './review/index.js';

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Usage: tsx src/index.ts <command> <repoPath> <sourceBranch> <targetBranch> [options]

Commands:
  analyze   Run diff analysis and intent detection (default)
  review    Run full AI code review with multiple agents

Arguments:
  repoPath      Path to the git repository
  sourceBranch  Source branch name (will use origin/<sourceBranch>)
  targetBranch  Target branch name (will use origin/<targetBranch>)

Options (review command):
  --format=<format>    Output format (default: markdown)
                       - json: Full JSON report
                       - markdown: Human-readable markdown
                       - summary: Brief CLI summary
                       - pr-comments: JSON for PR comment integration
  --language=<lang>    Output language (default: zh)
                       - zh: Chinese (中文)
                       - en: English
  --skip-validation    Skip issue validation (faster but less accurate)
  --monitor            Enable real-time status monitoring UI
  --monitor-port=<num> Status monitor port (default: 3456)
  --verbose            Enable verbose output

Note:
  This tool compares REMOTE branches (origin/...) to match GitHub PR/GitLab MR behavior.
  Make sure to fetch latest changes before running.

Examples:
  tsx src/index.ts analyze /path/to/repo feature/new-feature develop
  tsx src/index.ts review /path/to/repo feature/new-feature develop --format=json --monitor
  npx tsx src/index.ts review /path/to/repo Alex/bugfix/bug3303 develop --monitor
  npm run dev -- review /path/to/repo Alex/bugfix/bug3303 develop --monitor
`);
}

/**
 * Parse CLI options from arguments
 */
function parseOptions(args: string[]): {
  format: 'json' | 'markdown' | 'summary' | 'pr-comments';
  language: 'en' | 'zh';
  skipValidation: boolean;
  monitor: boolean;
  monitorPort: number;
  verbose: boolean;
} {
  const options = {
    format: 'markdown' as 'json' | 'markdown' | 'summary' | 'pr-comments',
    language: 'zh' as 'en' | 'zh',
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
  console.log(`
@argus/core - AI Code Review
=================================
Repository:    ${repoPath}
Source Branch: ${sourceBranch}
Target Branch: ${targetBranch}
Format:        ${options.format}
=================================
`);

  const report = await streamingReview({
    repoPath,
    sourceBranch,
    targetBranch,
    options: {
      verbose: options.verbose,
      skipValidation: options.skipValidation,
      monitor: options.monitor,
      monitorPort: options.monitorPort,
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

  // Check for minimum arguments
  if (args.length < 3) {
    console.error('Error: Invalid number of arguments\n');
    printUsage();
    process.exit(1);
  }

  // Check if first arg is a command
  const firstArg = args[0];
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

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
