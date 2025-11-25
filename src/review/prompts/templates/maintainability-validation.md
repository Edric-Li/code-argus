## Maintainability Issue Validation Rules

**Validation Focus**:
Maintainability issue validation requires balancing code complexity with actual needs.

**Required validation steps**:

1. **Evaluate complexity necessity**: Does the code complexity match the problem being solved?
2. **Check project patterns**: Does the project have similar code organization patterns?
3. **Verify suggestion feasibility**: Does the refactoring suggestion fit the project architecture?

**Rejection criteria for maintainability issues**:

- Code complexity matches domain complexity → **REJECT**
- Similar patterns already exist in the project → **REJECT**
- Refactoring suggestion doesn't match existing project architecture → **REJECT**

**Confirmation criteria for maintainability issues**:

- Code is overly complex and can be simplified
- Duplicate code exists that can be extracted
- Violates the project's organization patterns
