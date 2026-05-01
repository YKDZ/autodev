/**
 * Parse the AUTO_DEV_ALLOWED_USERS environment variable.
 * Returns a Set of lowercase GitHub login names.
 */
export const parseAllowedUsers = (): Set<string> => {
  const raw = process.env["AUTO_DEV_ALLOWED_USERS"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );
};

// Cache the parsed set so we don't re-parse on every call in high-frequency polls.
let _allowedUsersCache: Set<string> | null = null;
let _allowedUsersEnvSnapshot = "";

/**
 * Check if a GitHub login is in the allowed users list.
 * Comparison is case-insensitive.
 *
 * SECURITY: When AUTO_DEV_ALLOWED_USERS is not configured (empty), this
 * function returns false and denies all users. An explicit allowlist MUST be
 * provided to enable any user to trigger the agent.
 */
export const isAllowedUser = (login: string): boolean => {
  const current = process.env["AUTO_DEV_ALLOWED_USERS"] ?? "";
  if (_allowedUsersCache === null || current !== _allowedUsersEnvSnapshot) {
    _allowedUsersEnvSnapshot = current;
    _allowedUsersCache = parseAllowedUsers();
  }
  if (_allowedUsersCache.size === 0) return false; // Deny all when no allowlist configured
  return _allowedUsersCache.has(login.toLowerCase());
};
