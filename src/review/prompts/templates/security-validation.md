## Security Issue Validation Rules

**Validation Focus**:
For security issues, the validation core is to confirm whether attack paths exist and protective measures are in place.

**Required validation steps**:

1. **Trace data flow**: Check where input data comes from and whether it's validated
2. **Check protection layers**: Search for security middleware, validation functions, sanitizers, etc.
3. **Verify reachability**: Confirm whether the problematic code can be triggered by untrusted external input

**Special rejection criteria for security issues**:

- Data has been validated/sanitized before reaching the problematic code → **REJECT**
- Global security middleware handles this type of vulnerability → **REJECT**
- Problematic code is only called internally/in trusted environments, external input cannot reach it → **REJECT**
- Framework/library has built-in protection mechanisms → **REJECT**

**Confirmation criteria for security issues**:

- Untrusted input can directly reach the problematic code
- No validation/sanitization mechanisms found
- No security middleware protection
- Sensitive operations lack permission verification
