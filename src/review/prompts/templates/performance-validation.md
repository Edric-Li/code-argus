## Performance Issue Validation Rules

**Validation Focus**:
For performance issues, the validation core is to confirm whether optimization is meaningful and whether it's a real bottleneck. **You MUST analyze the ACTUAL COST of operations, not just call frequency.**

**Required validation steps**:

1. **Analyze call frequency**: When and how often is this code executed?
2. **⚠️ CRITICAL: Analyze callee cost**: Read the implementation of the called method/function to determine its actual cost:
   - Is it O(1) constant time? (e.g., Map.get, simple property access, cached value return)
   - Does it involve I/O, network, or heavy computation?
   - Is it already optimized (singleton, memoization, lazy evaluation)?
3. **Calculate total impact**: `Total Cost = Call Frequency × Per-Call Cost`
   - High frequency + Low cost = Usually NOT a real problem
   - Low frequency + High cost = Usually NOT a real problem
   - High frequency + High cost = Real performance issue
4. **Check existing optimizations**: Does caching, debounce, throttle, or memoization already exist?
5. **Confirm hot path**: Is this on a performance-critical path (render loop, event handler, etc.)?

**Special rejection criteria for performance issues**:

- **Called method is O(1) or very cheap** (e.g., getInstance() returning cached singleton, Map.get(), simple property access) → **REJECT** even if called frequently
- **EventEmitter.emit() with few listeners** → **REJECT** (event dispatch overhead is negligible)
- Code is on a cold path and rarely executed → **REJECT**
- Caching or memoization already exists → **REJECT**
- Data scale is too small, optimization benefits are negligible → **REJECT**
- No evidence of actual performance impact → **REJECT** (suggest downgrade to suggestion)
- It's premature optimization, readability is more important → **REJECT** or downgrade

**Confirmation criteria for performance issues**:

- Code is on a hot path AND the called operation is expensive
- Obvious algorithmic complexity issues (e.g., O(n²) can be optimized to O(n))
- Repeated expensive calculations without caching (network calls, DOM queries, heavy computation)
- Evidence of actual performance impact (blocking UI, high CPU usage, memory pressure)

**Example analysis**:

Issue: "Calling PageService.getInstance() in a loop is wasteful"

Validation steps:

1. Read PageService.getInstance() implementation
2. Find it returns a cached singleton: `return this.instance ??= new PageService()`
3. This is O(1) - just a property access and null check
4. **REJECT**: Even if called 1000 times, total cost is negligible (< 1ms)
