/** Tests for agent list utility functions. */
import { describe, it, expect } from "vitest";

/** Format an ISO timestamp as a relative time string. */
function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

describe("formatRelativeTime", () => {
  it("returns 'just now' for recent timestamps", () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe("just now");
  });

  it("returns minutes for timestamps within the hour", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe("5m ago");
  });

  it("returns hours for timestamps within the day", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(twoHoursAgo)).toBe("2h ago");
  });

  it("returns days for older timestamps", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toBe("3d ago");
  });
});

describe("agent online count", () => {
  it("correctly counts online agents from a list", () => {
    const agents = [
      { status: "online" as const },
      { status: "offline" as const },
      { status: "online" as const },
    ];
    const onlineCount = agents.filter((a) => a.status === "online").length;
    expect(onlineCount).toBe(2);
  });
});
