/** Narrows an unknown value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps a full lower-case commit id (SHA-1 or SHA-256), the only form git and the schema accept. */
export function commitSha(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)
    ? value
    : undefined;
}

/** Parses JSON without throwing; the CLIs print plain text for failures that never reached the forge. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Splits `gh api --include` or `glab api --include` output into the HTTP status, lower-cased
 * headers and body. Output without a status line (the CLI failed before sending a request) is
 * returned as a bare body.
 */
export function splitInclude(stdout: string): {
  status?: number;
  headers: Record<string, string>;
  body: string;
} {
  // Both CLIs end the status line with LF but header lines with CRLF.
  const match = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n([\s\S]*?)\r?\n\r?\n/.exec(stdout);
  if (!match) return { headers: {}, body: stdout };
  const headers: Record<string, string> = {};
  for (const line of (match[2] ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(match[1]), headers, body: stdout.slice(match[0].length) };
}
