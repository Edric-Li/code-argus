/**
 * @argus/core - Automated Code Review CLI Tool
 * Main Entry Point
 */

import { getDiff } from './git/diff.js';
import { parseDiff } from './git/parser.js';
import { filterDiff } from './git/filter.js';
import { GitError } from './git/type.js';

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
export function main(): void {
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
@argus/core - Git Diff Extraction & Analysis
============================================
Repository:    ${repoPath}
Source Branch: ${sourceBranch} (using ${remote}/${sourceBranch})
Target Branch: ${targetBranch} (using ${remote}/${targetBranch})
Diff Command:  git diff ${remote}/${targetBranch}...${remote}/${sourceBranch}
============================================
`);

    // Step 1: Get the raw diff
    console.log('Step 1: Extracting diff from remote branches...');
    const rawDiff = getDiff(repoPath, sourceBranch, targetBranch);

    if (!rawDiff.trim()) {
      console.log('No differences found between the branches.');
      return;
    }

    // Step 2: Parse the diff into structured files
    console.log('Step 2: Parsing diff into structured files...');
    const parsedFiles = parseDiff(rawDiff);
    console.log(`Found ${parsedFiles.length} changed file(s)`);

    // Step 3: Filter files that need code review
    console.log('Step 3: Filtering files for code review...');
    const cleanedFiles = filterDiff(parsedFiles);
    console.log(`${cleanedFiles.length} file(s) need review after filtering`);

    // Step 4: Output structured data
    console.log('\n============================================');
    console.log('Structured Diff Result:');
    console.log('============================================\n');
    console.log(JSON.stringify(cleanedFiles, null, 2));
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
