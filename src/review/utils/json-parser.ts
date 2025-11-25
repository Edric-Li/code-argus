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
 * 1. Look for JSON in markdown code blocks
 * 2. Look for JSON object pattern
 * 3. Find first { and last }
 *
 * @param text - Text that may contain JSON
 * @param options - Extraction options
 * @returns Extracted JSON string or null if not found
 */
export function extractJSON(text: string, options: JSONExtractOptions = {}): string | null {
  // Strategy 1: Look for JSON in markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    const jsonStr = codeBlockMatch[1].trim();
    if (isValidJSONStart(jsonStr)) {
      return repairJSON(jsonStr, options);
    }
  }

  // Strategy 2: Look for JSON object
  const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    const jsonStr = jsonObjectMatch[0];
    if (isValidJSONStart(jsonStr)) {
      return repairJSON(jsonStr, options);
    }
  }

  // Strategy 3: Find first { and last }
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      const jsonStr = text.substring(firstBrace, lastBrace + 1);
      return repairJSON(jsonStr, options);
    }
  }

  return null;
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

  // Issue 1: Truncated string - add closing quote
  if ((repaired.match(/"/g) || []).length % 2 !== 0) {
    repaired += '"';
  }

  // Issue 2: Unclosed array - add closing bracket
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;
  if (openBrackets > closeBrackets) {
    repaired += ']'.repeat(openBrackets - closeBrackets);
  }

  // Issue 3: Unclosed object - add closing brace
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  if (openBraces > closeBraces) {
    repaired += '}'.repeat(openBraces - closeBraces);
  }

  // Issue 4: Trailing comma before closing brace/bracket
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  // Verify repair worked
  try {
    JSON.parse(repaired);
    if (options.verbose) {
      console.log('[JSONParser] Successfully repaired JSON');
    }
    return repaired;
  } catch {
    // Return original if repair didn't work
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
