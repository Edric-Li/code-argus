import { describe, it, expect } from 'vitest';
import {
  parseHunks,
  detectWhitespaceOnlyChanges,
  type DiffHunk,
  type HunkLine,
} from '../../src/git/parser.js';

// ============================================================================
// parseHunks tests
// ============================================================================

describe('parseHunks', () => {
  it('should parse a single hunk correctly', () => {
    const chunk = `a/src/index.ts b/src/index.ts
index abc123..def456 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { foo } from './foo';
+import { bar } from './bar';

 export function main() {`;

    const hunks = parseHunks(chunk);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].oldCount).toBe(3);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].newCount).toBe(4);
  });

  it('should parse multiple hunks', () => {
    const chunk = `a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 line 1
+added line
 line 2
 line 3
@@ -10,3 +11,4 @@
 line 10
+another added
 line 11
 line 12`;

    const hunks = parseHunks(chunk);

    expect(hunks).toHaveLength(2);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[1].oldStart).toBe(10);
    expect(hunks[1].newStart).toBe(11);
  });

  it('should correctly track line numbers for added, removed, and context lines', () => {
    const chunk = `a/file.ts b/file.ts
@@ -5,5 +5,6 @@
 context line 5
-removed line 6
+added line 6
+extra added line
 context line 7
 context line 8`;

    const hunks = parseHunks(chunk);
    const lines = hunks[0].lines;

    // Context line at old:5, new:5
    expect(lines[0].type).toBe('context');
    expect(lines[0].oldLineNumber).toBe(5);
    expect(lines[0].newLineNumber).toBe(5);

    // Removed line at old:6
    expect(lines[1].type).toBe('removed');
    expect(lines[1].oldLineNumber).toBe(6);
    expect(lines[1].newLineNumber).toBeUndefined();

    // Added lines at new:6 and new:7
    expect(lines[2].type).toBe('added');
    expect(lines[2].newLineNumber).toBe(6);
    expect(lines[2].oldLineNumber).toBeUndefined();

    expect(lines[3].type).toBe('added');
    expect(lines[3].newLineNumber).toBe(7);

    // Context lines at old:7/new:8 and old:8/new:9
    expect(lines[4].type).toBe('context');
    expect(lines[4].oldLineNumber).toBe(7);
    expect(lines[4].newLineNumber).toBe(8);
  });

  it('should handle hunk with only count of 1 (no comma)', () => {
    const chunk = `a/file.ts b/file.ts
@@ -1 +1 @@
-old line
+new line`;

    const hunks = parseHunks(chunk);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldCount).toBe(1);
    expect(hunks[0].newCount).toBe(1);
  });

  it('should return empty array for content without hunks', () => {
    const chunk = `a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
Binary files differ`;

    const hunks = parseHunks(chunk);

    expect(hunks).toHaveLength(0);
  });
});

// ============================================================================
// detectWhitespaceOnlyChanges tests
// ============================================================================

describe('detectWhitespaceOnlyChanges', () => {
  // Helper to create a hunk with specific lines
  function createHunk(
    lines: Array<{ type: 'context' | 'added' | 'removed'; content: string }>,
    startLine = 1
  ): DiffHunk {
    const hunkLines: HunkLine[] = [];
    let oldLine = startLine;
    let newLine = startLine;

    for (const line of lines) {
      if (line.type === 'context') {
        hunkLines.push({
          type: 'context',
          content: line.content,
          oldLineNumber: oldLine++,
          newLineNumber: newLine++,
        });
      } else if (line.type === 'removed') {
        hunkLines.push({
          type: 'removed',
          content: line.content,
          oldLineNumber: oldLine++,
        });
      } else if (line.type === 'added') {
        hunkLines.push({
          type: 'added',
          content: line.content,
          newLineNumber: newLine++,
        });
      }
    }

    return {
      oldStart: startLine,
      oldCount: hunkLines.filter((l) => l.type !== 'added').length,
      newStart: startLine,
      newCount: hunkLines.filter((l) => l.type !== 'removed').length,
      lines: hunkLines,
    };
  }

  describe('indentation changes', () => {
    it('should detect spaces-to-more-spaces indentation change', () => {
      const hunk = createHunk([
        { type: 'removed', content: '  const x = 1;' },
        { type: 'added', content: '    const x = 1;' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toContain(1);
      expect(result).toHaveLength(1);
    });

    it('should detect tab-to-spaces conversion', () => {
      const hunk = createHunk([
        { type: 'removed', content: '\tconst x = 1;' },
        { type: 'added', content: '    const x = 1;' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toContain(1);
    });

    it('should detect spaces-to-tab conversion', () => {
      const hunk = createHunk([
        { type: 'removed', content: '    return value;' },
        { type: 'added', content: '\treturn value;' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toContain(1);
    });
  });

  describe('trailing whitespace changes', () => {
    it('should detect added trailing spaces', () => {
      const hunk = createHunk([
        { type: 'removed', content: 'const x = 1;' },
        { type: 'added', content: 'const x = 1;   ' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toContain(1);
    });

    it('should detect removed trailing spaces', () => {
      const hunk = createHunk([
        { type: 'removed', content: 'const x = 1;   ' },
        { type: 'added', content: 'const x = 1;' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toContain(1);
    });
  });

  describe('equal count pairing (1:1 matching)', () => {
    it('should detect multiple whitespace-only changes in sequence', () => {
      const hunk = createHunk([
        { type: 'removed', content: '  line1' },
        { type: 'removed', content: '  line2' },
        { type: 'removed', content: '  line3' },
        { type: 'added', content: '    line1' },
        { type: 'added', content: '    line2' },
        { type: 'added', content: '    line3' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toHaveLength(3);
      expect(result).toContain(1);
      expect(result).toContain(2);
      expect(result).toContain(3);
    });

    it('should handle mixed whitespace and content changes', () => {
      const hunk = createHunk([
        { type: 'removed', content: '  line1' },
        { type: 'removed', content: '  lineOLD' },
        { type: 'removed', content: '  line3' },
        { type: 'added', content: '    line1' }, // whitespace only
        { type: 'added', content: '    lineNEW' }, // content changed
        { type: 'added', content: '    line3' }, // whitespace only
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      // Only line1 and line3 are whitespace-only (1:1 index pairing)
      expect(result).toContain(1);
      expect(result).not.toContain(2); // content changed
      expect(result).toContain(3);
    });
  });

  describe('unequal count matching (using Map-based approach)', () => {
    it('should match whitespace changes when lines are reordered', () => {
      const hunk = createHunk([
        { type: 'removed', content: '  lineA' },
        { type: 'removed', content: '  lineB' },
        { type: 'added', content: '    lineB' }, // was second, now first
        { type: 'added', content: '    lineA' }, // was first, now second
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      // Both should be detected as whitespace-only
      expect(result).toHaveLength(2);
    });

    it('should handle more added lines than removed', () => {
      const hunk = createHunk([
        { type: 'removed', content: '  existing' },
        { type: 'added', content: '    existing' }, // whitespace change
        { type: 'added', content: '    newLine' }, // truly new line
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toContain(1); // whitespace-only
      expect(result).not.toContain(2); // new content
    });

    it('should handle more removed lines than added', () => {
      const hunk = createHunk([
        { type: 'removed', content: '  lineA' },
        { type: 'removed', content: '  lineB' },
        { type: 'removed', content: '  lineC' },
        { type: 'added', content: '    lineA' }, // whitespace change of lineA
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toContain(1);
      expect(result).toHaveLength(1);
    });
  });

  describe('should NOT mark as whitespace-only', () => {
    it('should not mark actual content changes', () => {
      const hunk = createHunk([
        { type: 'removed', content: 'const x = 1;' },
        { type: 'added', content: 'const y = 1;' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toHaveLength(0);
    });

    it('should not mark pure additions (no corresponding removal)', () => {
      const hunk = createHunk([
        { type: 'context', content: 'existing line' },
        { type: 'added', content: '  new line' },
        { type: 'context', content: 'another existing' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toHaveLength(0);
    });

    it('should not mark pure deletions', () => {
      const hunk = createHunk([
        { type: 'context', content: 'existing line' },
        { type: 'removed', content: '  deleted line' },
        { type: 'context', content: 'another existing' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toHaveLength(0);
    });

    it('should not mark when content differs significantly', () => {
      const hunk = createHunk([
        { type: 'removed', content: 'function foo() {' },
        { type: 'added', content: 'function bar() {' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty hunks array', () => {
      const result = detectWhitespaceOnlyChanges([]);

      expect(result).toHaveLength(0);
    });

    it('should handle hunk with only context lines', () => {
      const hunk = createHunk([
        { type: 'context', content: 'line 1' },
        { type: 'context', content: 'line 2' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toHaveLength(0);
    });

    it('should handle multiple hunks in same file', () => {
      const hunk1 = createHunk(
        [
          { type: 'removed', content: '  line1' },
          { type: 'added', content: '    line1' },
        ],
        1
      );
      const hunk2 = createHunk(
        [
          { type: 'removed', content: '  line10' },
          { type: 'added', content: '    line10' },
        ],
        10
      );

      const result = detectWhitespaceOnlyChanges([hunk1, hunk2]);

      expect(result).toHaveLength(2);
      expect(result).toContain(1);
      expect(result).toContain(10);
    });

    it('should handle empty string content', () => {
      const hunk = createHunk([
        { type: 'removed', content: '' },
        { type: 'added', content: '  ' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      // Empty to whitespace is technically whitespace-only
      expect(result).toContain(1);
    });

    it('should handle lines with only whitespace', () => {
      const hunk = createHunk([
        { type: 'removed', content: '    ' },
        { type: 'added', content: '\t\t' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toContain(1);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle prettier reformatting (indentation change)', () => {
      const hunk = createHunk([
        { type: 'context', content: 'function example() {' },
        { type: 'removed', content: '  if (condition) {' },
        { type: 'removed', content: '    doSomething();' },
        { type: 'removed', content: '  }' },
        { type: 'added', content: '    if (condition) {' },
        { type: 'added', content: '        doSomething();' },
        { type: 'added', content: '    }' },
        { type: 'context', content: '}' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      expect(result).toHaveLength(3);
      expect(result).toContain(2); // if line
      expect(result).toContain(3); // doSomething line
      expect(result).toContain(4); // closing brace
    });

    it('should handle ESLint auto-fix trailing whitespace removal', () => {
      const hunk = createHunk([
        { type: 'removed', content: 'const a = 1;  ' },
        { type: 'removed', content: 'const b = 2;\t' },
        { type: 'removed', content: 'const c = 3;' },
        { type: 'added', content: 'const a = 1;' },
        { type: 'added', content: 'const b = 2;' },
        { type: 'added', content: 'const c = 3;' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      // First two have trailing whitespace removed, third is identical (not a change)
      expect(result).toContain(1);
      expect(result).toContain(2);
      // Third line is identical, so not marked as whitespace-only change
      // (it's only marked if there IS a difference)
    });

    it('should handle mixed real changes with whitespace changes', () => {
      const hunk = createHunk([
        { type: 'context', content: 'class Example {' },
        { type: 'removed', content: '  private value: number;' },
        { type: 'removed', content: '  constructor() {}' },
        { type: 'added', content: '    private value: string;' }, // type changed + whitespace
        { type: 'added', content: '    constructor() {}' }, // whitespace only
        { type: 'context', content: '}' },
      ]);

      const result = detectWhitespaceOnlyChanges([hunk]);

      // First line has content change (number -> string), not whitespace-only
      expect(result).not.toContain(2);
      // Second line is whitespace-only
      expect(result).toContain(3);
    });
  });
});
