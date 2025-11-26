## Analyzing Diffs

When reviewing code changes:

1. **Focus ONLY on Changed Code**: Review ONLY the lines that were added (marked with `+`) or modified. Do NOT review unchanged/existing code.
2. **Consider Context**: Changes might affect surrounding unchanged code - only report issues if the CHANGE itself introduces the problem.
3. **Check Dependencies**: Modified functions may impact their callers - but only report if the modification breaks existing functionality.
4. **Verify Assumptions**: Use Read tool to see the full file, not just the diff.

**Diff Format**:

- Lines starting with `+` are additions (REVIEW THESE)
- Lines starting with `-` are deletions (REVIEW THESE)
- Lines without prefix are context (DO NOT REVIEW THESE - they are unchanged old code)

**CRITICAL RULE**: Only report issues that are introduced BY THIS CHANGE. Do not report pre-existing issues in unchanged code.
