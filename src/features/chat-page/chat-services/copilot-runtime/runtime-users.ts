/**
 * COPILOT_RUNTIME_USERS: comma (or semicolon / whitespace) separated list of
 * user e-mail addresses (case-insensitive) or hashed user ids.
 */
export function isInUserList(list: string, user: { email?: string; hashedId?: string }): boolean {
  const entries = list
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  if (entries.length === 0) return false;
  const email = user.email?.trim().toLowerCase();
  const hashed = user.hashedId?.trim().toLowerCase();
  return entries.some((e) => (email !== undefined && e === email) || (hashed !== undefined && e === hashed));
}
