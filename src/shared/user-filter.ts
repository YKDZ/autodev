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

/**
 * Check if a GitHub login is in the allowed users list.
 * Comparison is case-insensitive.
 */
export const isAllowedUser = (login: string): boolean => {
  const allowed = parseAllowedUsers();
  if (allowed.size === 0) return true; // No restriction when empty
  return allowed.has(login.toLowerCase());
};
