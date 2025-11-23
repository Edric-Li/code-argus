/**
 * @argus/core - Automated Code Review CLI Tool
 * Main Entry Point
 */

import { getDiff } from './git/diff.js';
import { GitError } from './git/type.js';
import { parseDiff } from './git/parser.js';
import { getPRCommits } from './git/commits.js';
import { createDiffAnalyzer } from './analyzer/index.js';
import { analyzeIntent, filterCommits } from './intent/index.js';

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Usage: tsx src/index.ts <repoPath> <sourceBranch> <targetBranch>

Arguments:
  repoPath      Path to the git repository
  sourceBranch  Source branch name (will use origin/<sourceBranch>)
  targetBranch  Target branch name (will use origin/<targetBranch>)

Note:
  This tool compares REMOTE branches (origin/...) to match GitHub PR/GitLab MR behavior.
  Make sure to fetch latest changes before running.

Example:
  tsx src/index.ts /path/to/repo feature/new-feature develop
  npm run dev /path/to/repo Alex/bugfix/bug3303 develop
`);
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

  // Check if we have exactly 3 arguments
  if (args.length !== 3) {
    console.error('Error: Invalid number of arguments\n');
    printUsage();
    process.exit(1);
  }

  const [repoPath, sourceBranch, targetBranch] = args;

  // Validate arguments are not empty
  if (!repoPath || !sourceBranch || !targetBranch) {
    console.error('Error: All arguments must be non-empty\n');
    printUsage();
    process.exit(1);
  }

  try {
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
