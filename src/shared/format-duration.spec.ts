import { describe, expect, it } from "vitest";

import { formatDuration } from "./format-duration.js";

describe("formatDuration", () => {
  it("formats milliseconds under 1 second", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds under 1 minute", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(42000)).toBe("42s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats minutes and seconds under 1 hour", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(150000)).toBe("2m 30s");
    expect(formatDuration(3599000)).toBe("59m 59s");
  });

  it("formats hours and minutes for durations 1 hour or more", () => {
    expect(formatDuration(3600000)).toBe("1h 0m");
    expect(formatDuration(3900000)).toBe("1h 5m");
    expect(formatDuration(7380000)).toBe("2h 3m");
  });
});
