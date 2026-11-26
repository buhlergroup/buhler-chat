/**
 * Secret scan of the runtime's session journal (/session-state files).
 *
 * The journal stays readable by the model on purpose (view / rg recover
 * details after a compaction), so it must never hold a secret: tool calls
 * put their arguments and results there, and the app's own credentials
 * (extension header secrets, API keys, SAS URLs) must stay out of both. The
 * smoke script runs this scan on a live journal; journal-secret-scan.test.ts
 * runs it in CI on a synthetic journal and on what an extension call hands
 * to the runtime.
 *
 * Findings are labels only, never the matched values.
 */

/** Patterns of credentials that must not appear in a journal. */
export const JOURNAL_SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["bearer token", /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ["Authorization header", /"?authorization"?\s*[:=]/i],
  ["api key field", /"?(?:api[-_]?key|x-api-key|ocp-apim-subscription-key)"?\s*[:=]\s*"?[A-Za-z0-9]{16,}/i],
  ["SAS signature", /[?&]sig=[A-Za-z0-9%/+=]{20,}/],
  ["OAuth code / token", /[?&](?:code|access_token|refresh_token)=[A-Za-z0-9._-]{16,}/],
  ["connection string", /AccountKey=|SharedAccessSignature=|Password=/i],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

/** Values of secret-like environment variables (name has KEY, SECRET, TOKEN, ...; 16+ characters). */
export function envSecretValues(env: Record<string, string | undefined>): Array<readonly [string, string]> {
  return Object.entries(env)
    .filter(([k, v]) => /KEY|SECRET|TOKEN|PASSWORD|CONNECTION/i.test(k) && typeof v === "string" && v.length >= 16)
    .map(([k, v]) => [k, v as string] as const);
}

/**
 * Labels of what the text contains: a pattern name, or the label of a known
 * secret value (e.g. ["extension header secret", value]).
 */
export function scanJournalText(text: string, knownSecrets: ReadonlyArray<readonly [string, string]> = []): string[] {
  const hits = new Set<string>();
  for (const [name, re] of JOURNAL_SECRET_PATTERNS) if (re.test(text)) hits.add(name);
  for (const [label, value] of knownSecrets) if (value && text.includes(value)) hits.add(label);
  return [...hits];
}
