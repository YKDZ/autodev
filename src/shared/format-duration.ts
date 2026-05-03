/**
 * Formats a duration given in milliseconds into a human-readable string.
 *
 * - `< 1000ms`  → `"Xms"`    e.g. `"500ms"`
 * - `1s – 59s`  → `"Xs"`     e.g. `"42s"`
 * - `1m – 59m`  → `"Xm Ys"`  e.g. `"2m 30s"`
 * - `≥ 1h`      → `"Xh Ym"`  e.g. `"1h 5m"`
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.floor(ms)}ms`;
  }

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const remainingSeconds = totalSeconds % 60;
    return `${totalMinutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
