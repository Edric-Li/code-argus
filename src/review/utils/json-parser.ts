/**
 * JSON Parsing Utilities
 *
 * Robust JSON extraction and repair utilities for parsing LLM outputs.
 */

/**
 * Options for JSON extraction
 */
export interface JSONExtractOptions {
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Extract JSON from text using multiple strategies
 *
 * Tries the following strategies in order:
 * 1. Look for JSON in markdown code blocks (```json ... ```)
 * 2. Look for JSON in generic code blocks (``` ... ```)
 * 3. Find outermost balanced braces for JSON object
 * 4. Fallback: find first { and last }
 *
 * @param text - Text that may contain JSON
 * @param options - Extraction options
 * @returns Extracted JSON string or null if not found
 */
export function extractJSON(text: string, options: JSONExtractOptions = {}): string | null {
  // Strategy 1: Look for JSON in markdown code blocks with json tag
  const jsonCodeBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonCodeBlockMatch?.[1]) {
    const jsonStr = jsonCodeBlockMatch[1].trim();
    if (isValidJSONStart(jsonStr)) {
      const repaired = repairJSON(jsonStr, options);
      if (isValidJSON(repaired)) {
        return repaired;
      }
    }
  }

  // Strategy 2: Look for JSON in generic code blocks
  const codeBlockMatch = text.match(/```\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    const jsonStr = codeBlockMatch[1].trim();
    if (isValidJSONStart(jsonStr)) {
      const repaired = repairJSON(jsonStr, options);
      if (isValidJSON(repaired)) {
        return repaired;
      }
    }
  }

  // Strategy 3: Find balanced JSON object (handles nested braces correctly)
  const balancedJson = extractBalancedJSON(text);
  if (balancedJson) {
    const repaired = repairJSON(balancedJson, options);
    if (isValidJSON(repaired)) {
      return repaired;
    }
  }

  // Strategy 4: Fallback - find first { and last }
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      const jsonStr = text.substring(firstBrace, lastBrace + 1);
      const repaired = repairJSON(jsonStr, options);
      if (isValidJSON(repaired)) {
        return repaired;
      }
      // Even if not valid, return repaired as last resort
      return repaired;
    }
  }

  return null;
}

/**
 * Extract balanced JSON object from text
 * Handles nested braces correctly by tracking depth
 *
 * @param text - Text that may contain JSON
 * @returns Extracted JSON string or null
 */
function extractBalancedJSON(text: string): string | null {
  const startIdx = text.indexOf('{');
  if (startIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIdx; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          return text.substring(startIdx, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Check if string is valid JSON
 *
 * @param str - String to check
 * @returns true if valid JSON
 */
function isValidJSON(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if string starts like valid JSON
 *
 * @param str - String to check
 * @returns true if string starts with { or [
 */
export function isValidJSONStart(str: string): boolean {
  const trimmed = str.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * Attempt to repair truncated or malformed JSON
 *
 * Handles common issues:
 * - Truncated strings (unclosed quotes)
 * - Unclosed arrays
 * - Unclosed objects
 * - Trailing commas
 * - Truncated in the middle of a string value
 *
 * @param jsonStr - JSON string that may be malformed
 * @param options - Repair options
 * @returns Repaired JSON string
 */
export function repairJSON(jsonStr: string, options: JSONExtractOptions = {}): string {
  let repaired = jsonStr.trim();

  // Check if already valid
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    // Continue with repair
  }

  // Track state while scanning
  let inString = false;
  let escapeNext = false;
  let depth = 0;
  let arrayDepth = 0;

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === '[') arrayDepth++;
      else if (char === ']') arrayDepth--;
    }
  }

  // Issue 1: Truncated inside a string - close the string
  if (inString) {
    // Remove any incomplete escape sequence at the end
    if (repaired.endsWith('\\')) {
      repaired = repaired.slice(0, -1);
    }
    // Close the string
    repaired += '"';
  }

  // Issue 2: Unclosed arrays
  if (arrayDepth > 0) {
    repaired += ']'.repeat(arrayDepth);
  }

  // Issue 3: Unclosed objects
  if (depth > 0) {
    repaired += '}'.repeat(depth);
  }

  // Issue 4: Trailing comma before closing brace/bracket
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  // Issue 5: Missing value after colon (truncated mid-value)
  // e.g., {"key": } or {"key":}
  repaired = repaired.replace(/:(\s*[}\]])/g, ': ""$1');

  // Verify repair worked
  try {
    JSON.parse(repaired);
    if (options.verbose) {
      console.log('[JSONParser] Successfully repaired JSON');
    }
    return repaired;
  } catch {
    // Try more aggressive repair: find last valid JSON structure
    if (options.verbose) {
      console.log('[JSONParser] Basic repair failed, trying aggressive repair');
    }
    return aggressiveRepair(jsonStr, options);
  }
}

/**
 * Aggressive JSON repair for badly truncated JSON
 * Tries to extract whatever valid data is present
 */
function aggressiveRepair(jsonStr: string, options: JSONExtractOptions = {}): string {
  let repaired = jsonStr.trim();

  // Find the last complete key-value pair by looking for pattern ": "value""
  // and truncate there, then close all brackets
  const lastCompleteValue = repaired.lastIndexOf('",');
  if (lastCompleteValue > 0) {
    repaired = repaired.substring(0, lastCompleteValue + 1);
  }

  // Count unclosed structures
  let depth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === '[') arrayDepth++;
      else if (char === ']') arrayDepth--;
    }
  }

  // Close any unclosed strings
  if (inString) {
    repaired += '"';
  }

  // Close arrays and objects
  if (arrayDepth > 0) {
    repaired += ']'.repeat(arrayDepth);
  }
  if (depth > 0) {
    repaired += '}'.repeat(depth);
  }

  // Remove trailing commas
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  try {
    JSON.parse(repaired);
    if (options.verbose) {
      console.log('[JSONParser] Aggressive repair succeeded');
    }
    return repaired;
  } catch {
    if (options.verbose) {
      console.log('[JSONParser] All repair attempts failed');
    }
    return jsonStr;
  }
}

/**
 * Safely parse JSON with fallback
 *
 * @param text - Text that may contain JSON
 * @param fallback - Fallback value if parsing fails
 * @param options - Extraction options
 * @returns Parsed JSON or fallback value
 */
export function safeParseJSON<T>(text: string, fallback: T, options: JSONExtractOptions = {}): T {
  const jsonStr = extractJSON(text, options);
  if (!jsonStr) {
    return fallback;
  }

  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return fallback;
  }
}
