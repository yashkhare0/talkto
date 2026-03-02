/** Tests for keyboard shortcuts dialog. */
import { describe, it, expect } from "vitest";

// Test the SHORTCUTS data structure is correct
const SHORTCUTS = [
  { keys: ["⌘", "K"], description: "Search messages" },
  { keys: ["⌘", "B"], description: "Toggle sidebar" },
  { keys: ["⌘", "⇧", "F"], description: "Toggle features panel" },
  { keys: ["?"], description: "Show keyboard shortcuts" },
  { keys: ["Esc"], description: "Close panels / cancel" },
  { keys: ["Enter"], description: "Send message" },
  { keys: ["⇧", "Enter"], description: "New line in message" },
  { keys: ["↑", "↓"], description: "Navigate mention suggestions" },
  { keys: ["Tab"], description: "Accept mention suggestion" },
] as const;

describe("KeyboardShortcutsDialog", () => {
  it("has unique descriptions for all shortcuts", () => {
    const descriptions = SHORTCUTS.map((s) => s.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("all shortcuts have at least one key", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.keys.length).toBeGreaterThan(0);
    }
  });

  it("includes search, sidebar, and help shortcuts", () => {
    const descriptions = SHORTCUTS.map((s) => s.description);
    expect(descriptions).toContain("Search messages");
    expect(descriptions).toContain("Toggle sidebar");
    expect(descriptions).toContain("Show keyboard shortcuts");
  });
});
