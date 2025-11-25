## Style Issue Validation Rules

**Validation Focus**:
For style issues, the validation core is to check the project's existing conventions, not general best practices.

**Required validation steps**:

1. **Search similar files**: Use Glob to find files of the same type in the directory
2. **Check existing patterns**: Use Grep to search for the same style in the project
3. **Count consistency**: If the project uses the same style in 3+ places, REJECT this issue

**Special rejection criteria for style issues**:

- If the "problem code" style is widely used in the project → **REJECT**
- If the project has no clear style standards (like ESLint/Prettier config) → **REJECT** (unless it's obvious inconsistency)
- If the suggested "fix" doesn't match the mainstream style of existing project code → **REJECT**
- Pure personal style preference without objective reasons → **REJECT**

**Confirmation criteria for style issues**:

- Code clearly violates project-configured ESLint/Prettier rules
- Naming is clearly inconsistent with naming conventions of similar code in the project
- Code organization is significantly different from other files in the same directory
- Formatting is inconsistent with the project's established patterns
