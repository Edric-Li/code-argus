## Performance Issue Validation Rules

**Validation Focus**:
For performance issues, the validation core is to confirm whether optimization is meaningful and whether it's a real bottleneck.

**Required validation steps**:

1. **Analyze call frequency**: When and how often is this code executed?
2. **Check caching**: Does caching or memoization already exist?
3. **Evaluate data scale**: How much data is being processed? Is optimization worthwhile?
4. **Confirm hot path**: Is this on a performance-critical path?

**Special rejection criteria for performance issues**:

- Code is on a cold path and rarely executed → **REJECT**
- Caching or memoization already exists → **REJECT**
- Data scale is too small, optimization benefits are negligible → **REJECT**
- No benchmarks prove this is a bottleneck → **REJECT** (suggest downgrade to suggestion)
- It's premature optimization, readability is more important → **REJECT** or downgrade

**Confirmation criteria for performance issues**:

- Code is on a hot path and executed frequently
- Obvious algorithmic complexity issues (e.g., O(n²) can be optimized to O(n))
- Repeated calculations without caching
- May cause noticeable delays or resource consumption
