# code-argus

AI-powered automated code review CLI tool using Claude Agent SDK with multi-agent orchestration.

English | [中文](./README.zh-CN.md)

## Features

- **Multi-Agent Parallel Review** - 4 specialized agents run concurrently: security, logic, performance, style
- **Smart Agent Selection** - Automatically selects agents based on file characteristics
- **Issue Validation** - Challenge-mode multi-round validation significantly reduces false positives
- **Realtime Deduplication** - Two-layer dedup: fast rule-based check + LLM semantic verification
- **Project Standards Aware** - Auto-extracts ESLint/TypeScript/Prettier configs
- **Custom Rules** - Team-specific review rules and checklists
- **Incremental Review** - Only review new commits for better efficiency
- **Service Integration** - JSON event stream output for CI/CD and external service integration

## Installation

### Global Install (Recommended)

```bash
npm install -g code-argus
```

### Using npx

```bash
npx code-argus review /path/to/repo feature-branch main
```

### From Source

```bash
git clone https://github.com/anthropics/code-argus.git
cd code-argus/core
npm install
npm run build
npm link
```

## Configuration

### API Key

Set your Anthropic API key:

```bash
# Option 1: Environment variable
export ANTHROPIC_API_KEY=your-api-key

# Option 2: .env file
echo "ANTHROPIC_API_KEY=your-api-key" > .env

# Option 3: Using config command (recommended)
argus config set api-key sk-ant-xxx
```

### Configuration Management

```bash
# Set configuration
argus config set api-key sk-ant-xxx      # API key
argus config set base-url https://proxy  # Custom proxy URL
argus config set model claude-sonnet-4-5-20250929  # Model

# View configuration
argus config list                         # List all config
argus config get api-key                  # Get single config
argus config path                         # Show config file path

# Delete configuration
argus config delete base-url
```

## Usage

### Command Format

```bash
argus <command> <repoPath> <sourceBranch> <targetBranch> [options]
```

### Commands

| Command  | Description                                       |
| -------- | ------------------------------------------------- |
| `review` | Full AI code review (multi-agent parallel review) |
| `config` | Configuration management                          |

### Arguments

| Argument   | Description                                      |
| ---------- | ------------------------------------------------ |
| `repoPath` | Path to Git repository                           |
| `source`   | Source branch name or commit SHA (auto-detected) |
| `target`   | Target branch name or commit SHA (auto-detected) |

**Auto-detection:**

- Branch names: Uses three-dot diff (`origin/target...origin/source`)
- Commit SHAs: Uses two-dot diff (`target..source`) for incremental review

---

## Options Reference

### `--json-logs`

**Output JSON event stream for service integration**

When enabled, all progress and final report are output as JSON Lines (NDJSON) to stderr, making it easy for external programs to parse.

```bash
argus review /repo feature main --json-logs
```

**Output Example:**

```jsonl
{"type":"review:start","data":{"repoPath":"/repo","sourceBranch":"feature","targetBranch":"main","agents":["security-reviewer","logic-reviewer"],"timestamp":"2025-01-15T10:00:00.000Z"}}
{"type":"phase:start","data":{"phase":1,"totalPhases":4,"name":"Building review context...","timestamp":"..."}}
{"type":"agent:start","data":{"agent":"security-reviewer","timestamp":"..."}}
{"type":"agent:progress","data":{"agent":"security-reviewer","activity":"Reading file: src/auth.ts","timestamp":"..."}}
{"type":"agent:complete","data":{"agent":"security-reviewer","status":"completed","issuesFound":3,"elapsedMs":5000,"timestamp":"..."}}
{"type":"validation:issue","data":{"issueId":"sql-injection-auth.ts","title":"SQL Injection","file":"src/auth.ts","line":42,"severity":"error","status":"confirmed","description":"User input directly concatenated into SQL query","suggestion":"Use parameterized queries instead","timestamp":"..."}}
{"type":"review:complete","data":{"totalIssues":5,"elapsedMs":30000,"timestamp":"..."}}
{"type":"report","data":{"report":{"issues":[...],"metrics":{...},"metadata":{...}},"timestamp":"..."}}
```

**Event Types:**

| Event Type            | Description                                                          |
| --------------------- | -------------------------------------------------------------------- |
| `review:start`        | Review started, includes repo, branches, agent list                  |
| `review:complete`     | Review completed, includes total issues and elapsed time             |
| `review:error`        | Review failed, includes error message                                |
| `phase:start`         | Phase started (build context, run agents, validate, generate report) |
| `phase:complete`      | Phase completed                                                      |
| `agent:start`         | Agent started running                                                |
| `agent:progress`      | Agent activity (reading files, searching code, etc.)                 |
| `agent:complete`      | Agent completed, includes issues found count                         |
| `validation:start`    | Validation started                                                   |
| `validation:progress` | Validation progress                                                  |
| `validation:issue`    | Issue validation result (confirmed/rejected/uncertain)               |
| `validation:complete` | Validation completion statistics                                     |
| `log`                 | Log message                                                          |
| `report`              | **Final report** (includes complete review results)                  |

**Service Integration Example:**

```typescript
import { spawn } from 'child_process';

const child = spawn('argus', ['review', repo, source, target, '--json-logs']);

child.stderr.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n').filter(Boolean)) {
    const event = JSON.parse(line);

    switch (event.type) {
      case 'agent:start':
        updateUI(`Agent ${event.data.agent} started...`);
        break;
      case 'agent:complete':
        updateUI(`Agent ${event.data.agent} completed, found ${event.data.issuesFound} issues`);
        break;
      case 'validation:issue':
        if (event.data.status === 'confirmed') {
          addIssue(event.data);
        }
        break;
      case 'report':
        // Final report - review completed
        saveReport(event.data.report);
        break;
    }
  }
});
```

---

### `--language=<lang>`

**Output language**

| Value | Description       |
| ----- | ----------------- |
| `zh`  | Chinese (default) |
| `en`  | English           |

```bash
argus review /repo feature main --language=en
```

---

### `--skip-validation`

**Skip issue validation**

Skip challenge-mode validation to speed up review, but may increase false positives.

```bash
argus review /repo feature main --skip-validation
```

**Use cases:**

- Quick preview of review results
- Fast checks in CI/CD
- Scenarios with higher tolerance for false positives

**Note:** Not recommended for formal reviews. Validation filters approximately 30-50% of false positives.

---

### `--config-dir=<path>`

**Configuration directory**

Specify a config directory that auto-loads `rules/` and `agents/` subdirectories.

```bash
argus review /repo feature main --config-dir=./.ai-review
```

**Directory structure:**

```
.ai-review/
├── rules/              # Supplement built-in agent rules
│   ├── global.md       # Global rules (apply to all agents)
│   ├── security.md     # Security review rules
│   ├── logic.md        # Logic review rules
│   ├── style.md        # Style review rules
│   ├── performance.md  # Performance review rules
│   └── checklist.yaml  # Custom checklist
└── agents/             # Custom agents (domain-specific review)
    ├── component-plugin.yaml
    └── api-security.yaml
```

---

### `--rules-dir=<path>`

**Custom rules directory**

Specify a rules directory separately. Can be used multiple times.

```bash
# Single rules directory
argus review /repo feature main --rules-dir=./team-rules

# Multiple rules directories (merged in order)
argus review /repo feature main --rules-dir=./base-rules --rules-dir=./team-rules
```

**Rules file format (Markdown):**

```markdown
# Security Review Rules

## Must Check

- All user input must be validated and escaped
- Prohibit use of eval() and new Function()
- SQL queries must use parameterized queries

## Best Practices

- Use Content-Security-Policy headers
- Store sensitive data with encryption
```

---

### `--agents-dir=<path>`

**Custom agents directory**

Specify a custom agent definitions directory. Can be used multiple times.

```bash
argus review /repo feature main --agents-dir=./custom-agents
```

**Agent definition file format (YAML):**

```yaml
name: api-security
description: API security review specialist
trigger_mode: rule # rule | llm | hybrid
triggers:
  files:
    - '**/api/**/*.ts'
    - '**/routes/**/*.ts'
  exclude_files:
    - '**/*.test.ts'
    - '**/*.spec.ts'
prompt: |
  You are an API security review expert. Check for:

  1. Authentication and Authorization
     - Is user identity properly verified
     - Are user permissions checked

  2. Input Validation
     - Are request parameters validated for type and range
     - Is injection attack prevention in place

  3. Response Security
     - Is sensitive information leaked
     - Are error messages too detailed
output:
  category: security
  default_severity: error
```

---

### `--verbose`

**Verbose output mode**

Output more debug information, including agent selection reasons, tool call details, etc.

```bash
argus review /repo feature main --verbose
```

---

### `--previous-review=<file>`

**Fix verification mode**

Load a previous review JSON file to verify if reported issues have been fixed.

```bash
# Verify fixes from a previous review
argus review /repo feature main --previous-review=./review-result.json
```

**How it works:**

1. Loads issues from the previous review JSON file
2. Runs the `fix-verifier` agent to check each issue
3. Reports verification status: `fixed`, `missed`, `false_positive`, `obsolete`, or `uncertain`
4. Missed issues are included in the final report with updated descriptions

**Previous review file format:**

The file should be a JSON export from a previous review containing an `issues` array:

```json
{
  "issues": [
    {
      "id": "sql-injection-auth-42",
      "file": "src/auth.ts",
      "line_start": 42,
      "line_end": 45,
      "category": "security",
      "severity": "error",
      "title": "SQL Injection vulnerability",
      "description": "User input directly concatenated into SQL query"
    }
  ]
}
```

---

### `--no-verify-fixes`

**Disable fix verification**

When `--previous-review` is set, fix verification is enabled by default. Use this flag to disable it.

```bash
# Load previous review but skip fix verification
argus review /repo feature main --previous-review=./review.json --no-verify-fixes
```

---

## Examples

### Basic Usage

```bash
# Full AI code review (branch-based)
argus review /path/to/repo feature-branch main

# English output
argus review /path/to/repo feature-branch main --language=en
```

### Incremental Review (Commit-based)

Use commit SHAs instead of branch names to review only specific commit ranges:

```bash
# Review changes between two commits
argus review /repo abc1234 def5678

# Example: Review only new commits on a feature branch
# First, get the commit SHAs
git log --oneline feature-branch

# Then review the specific range
argus review /repo <new-commit-sha> <old-commit-sha>
```

The tool auto-detects whether you're passing branch names or commit SHAs and adjusts the diff strategy accordingly.

### Fix Verification

Verify if issues from a previous review have been addressed:

```bash
# Save the first review result
argus review /repo feature main --json-logs 2>&1 | jq 'select(.type=="report") | .data.report' > review-1.json

# After fixes are made, verify them
argus review /repo feature main --previous-review=./review-1.json
```

### Custom Configuration

```bash
# Using config directory
argus review /repo feature main --config-dir=./.ai-review

# Specify rules and agents separately
argus review /repo feature main \
  --rules-dir=./company-rules \
  --agents-dir=./domain-agents

# Multi-layer config merge
argus review /repo feature main \
  --config-dir=./base-config \
  --rules-dir=./team-overrides
```

### CI/CD Integration

```bash
# JSON event stream output
argus review /repo feature main --json-logs 2>events.jsonl

# Fast check (skip validation)
argus review /repo feature main --skip-validation --json-logs

# Commit-based incremental CI check
argus review /repo $NEW_COMMIT $OLD_COMMIT --json-logs
```

---

## Project Structure

```
src/
├── index.ts              # CLI entry, command parsing
├── cli/
│   ├── progress.ts       # Interactive progress output
│   ├── events.ts         # Event type definitions
│   └── structured-progress.ts  # JSON event stream output
├── review/
│   ├── orchestrator.ts   # Main review orchestrator
│   ├── streaming-orchestrator.ts  # Streaming review mode
│   ├── streaming-validator.ts    # Streaming issue validation
│   ├── agent-selector.ts # Smart agent selection
│   ├── validator.ts      # Issue validation (challenge mode)
│   ├── fix-verifier.ts   # Fix verification agent executor
│   ├── previous-review-loader.ts # Load previous review data
│   ├── realtime-deduplicator.ts  # Realtime deduplication
│   ├── deduplicator.ts   # Batch semantic dedup
│   ├── aggregator.ts     # Issue aggregation
│   ├── report.ts         # Report generation
│   ├── prompts/          # Agent prompt building
│   ├── standards/        # Project standards extraction
│   ├── rules/            # Custom rules loading
│   ├── custom-agents/    # Custom agent loading
│   └── types.ts          # Type definitions
├── git/
│   ├── diff.ts           # Git diff operations
│   ├── parser.ts         # Diff parsing
│   ├── ref.ts            # Ref type detection (branch/commit)
│   ├── worktree-manager.ts # Git worktree management
│   └── commits.ts        # Commit history
├── llm/
│   ├── factory.ts        # LLM provider factory
│   └── providers/        # Claude/OpenAI implementations
└── analyzer/
    ├── local-analyzer.ts # Local fast analysis
    └── diff-analyzer.ts  # LLM semantic analysis

.claude/agents/           # Built-in agent prompt definitions
├── security-reviewer.md  # Security review
├── logic-reviewer.md     # Logic review
├── style-reviewer.md     # Style review
├── performance-reviewer.md # Performance review
├── validator.md          # Issue validation
└── fix-verifier.md       # Fix verification
```

## How It Works

### Review Flow

```
┌─────────────────┐
│  1. Build Context │  Get Diff → Parse Files → Extract Project Standards
└────────┬────────┘
         ▼
┌─────────────────┐
│  2. Smart Select │  Select needed agents based on file characteristics
└────────┬────────┘
         ▼
┌─────────────────┐
│  3. Parallel Review │  4 agents run concurrently + realtime dedup
└────────┬────────┘
         ▼
┌─────────────────┐
│  4. Validation  │  Challenge-mode multi-round validation, filter false positives
└────────┬────────┘
         ▼
┌─────────────────┐
│  5. Fix Verify  │  (Optional) Verify if previous issues are fixed
└────────┬────────┘
         ▼
┌─────────────────┐
│  6. Generate Report │  Aggregate issues, generate structured report
└─────────────────┘
```

### Three-Dot Diff

Uses `git diff origin/target...origin/source`:

```
main:     A --- B --- C
                \
feature:         D --- E
```

- Only shows changes in D and E (actual source branch changes)
- Excludes other commits on target branch

### Realtime Deduplication

Two-layer deduplication mechanism:

1. **Rule Layer** - Same file + overlapping lines → fast check
2. **LLM Layer** - Semantic similarity → precise dedup

### Issue Validation

Challenge mode: Validator agent attempts to "challenge" discovered issues

- Verify if code location is correct
- Verify if issue description is accurate
- Verify if it's a real issue vs false positive

### Fix Verification

When `--previous-review` is provided, the fix-verifier agent checks each previous issue:

1. **Phase 1: Batch Screening** - Quick scan to categorize issues as resolved/unresolved/unclear
2. **Phase 2: Deep Investigation** - Thorough multi-round investigation for unresolved issues

Verification statuses:

- **fixed** - Issue properly addressed
- **missed** - Issue still exists (developer oversight)
- **false_positive** - Original detection was incorrect
- **obsolete** - Code changed significantly, issue no longer relevant
- **uncertain** - Cannot determine status

## Development Commands

```bash
# Development
npm run dev -- <command> ...   # Run CLI
npm run exec src/file.ts       # Run any TS file

# Build
npm run build                  # Compile to dist/
npm run type-check             # Type checking

# Code Quality
npm run lint                   # ESLint check
npm run lint:fix               # Auto-fix
npm run format                 # Prettier format
npm run format:check           # Check format

# Testing
npm run test                   # Watch mode
npm run test:run               # Run once
npm run test:coverage          # Coverage report
```

## Commit Convention

Using Conventional Commits:

```bash
git commit -m "feat: add new feature"
git commit -m "fix: resolve bug"
git commit -m "docs: update documentation"
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

## License

MIT
