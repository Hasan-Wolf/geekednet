/**
 * Shared primitives for the checks that guard authored content.
 *
 * Labs and replays are both JSON, so TypeScript never sees either of them, and
 * both are checked at import so a malformed field is a loud startup error rather
 * than content that silently does less than it says. What lives here is the part
 * that has nothing to do with *which* schema is being checked — kept in one place
 * so the two checkers reject a bad value in the same words.
 *
 * See {@link ./validate.ts} (labs) and {@link ./replay.ts} (replays).
 */

/** Render a rejected value for an error message. */
export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return String(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A string with something in it.
 *
 * `null` is what an author reaches for to mean "leave this one open", but no
 * field in either schema means anything without a value — omitting it does that
 * job, and a field present-but-empty is a typo worth naming.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
