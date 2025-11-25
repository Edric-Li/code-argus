## Logic Issue Validation Rules

**Validation Focus**:
For logic issues, the validation core is to confirm whether the reported scenario is possible and whether existing mechanisms handle it.

**Required validation steps**:

1. **Check tests**: Search related test files to see if there are tests covering this scenario
2. **Trace call chain**: Check whether the caller guarantees input validity
3. **Check error handling**: Look for try-catch or error boundaries handling this type of issue
4. **Verify type constraints**: Check if TypeScript types already exclude certain boundary conditions

**Special rejection criteria for logic issues**:

- Test cases explicitly test this behavior → **REJECT**
- Caller/upstream code already guarantees input validity → **REJECT**
- Outer layer has unified error handling mechanisms → **REJECT**
- TypeScript type system already excludes the problem scenario → **REJECT**
- Reported boundary conditions cannot occur in business logic → **REJECT**

**Confirmation criteria for logic issues**:

- No test coverage for this code path
- Boundary conditions can indeed occur and are not handled
- No error handling mechanisms
- May lead to runtime errors or incorrect results
