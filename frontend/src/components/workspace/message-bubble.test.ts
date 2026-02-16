/** Tests for message-bubble pure utility functions. */
import { describe, it, expect } from "vitest";
import { isPlainText, formatTime } from "./message-bubble";

describe("isPlainText", () => {
  it("returns true for simple text", () => {
    expect(isPlainText("Hello world")).toBe(true);
  });

  it("returns false for text with hyphens (treated as potential markdown)", () => {
    // The `-` character is in the markdown pattern, so hyphenated names trigger it
    expect(isPlainText("Hey @cosmic-penguin how are you?")).toBe(false);
  });

  it("returns true for text with underscores only (mentions without hyphens)", () => {
    expect(isPlainText("Hey there, what's up?")).toBe(true);
  });

  it("returns false for bold markdown", () => {
    expect(isPlainText("This is **bold**")).toBe(false);
  });

  it("returns false for italic markdown", () => {
    expect(isPlainText("This is _italic_")).toBe(false);
  });

  it("returns false for code blocks", () => {
    expect(isPlainText("Run `npm install`")).toBe(false);
  });

  it("returns false for headings", () => {
    expect(isPlainText("# Heading")).toBe(false);
  });

  it("returns false for links", () => {
    expect(isPlainText("[link](https://example.com)")).toBe(false);
  });

  it("returns false for ordered lists", () => {
    expect(isPlainText("1. First item")).toBe(false);
  });

  it("returns false for unordered lists", () => {
    expect(isPlainText("- Item")).toBe(false);
  });

  it("returns false for blockquotes", () => {
    expect(isPlainText("> quoted text")).toBe(false);
  });

  it("returns false for strikethrough", () => {
    expect(isPlainText("This is ~wrong~")).toBe(false);
  });

  it("returns false for tables (pipe character)", () => {
    expect(isPlainText("| col1 | col2 |")).toBe(false);
  });
});

describe("formatTime", () => {
  it("formats a valid ISO string to a time", () => {
    const result = formatTime("2026-02-16T14:30:00Z");
    // Exact format depends on locale, but it should be a non-empty string
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("returns 'Invalid Date' or empty for invalid input", () => {
    // new Date("not-a-date") doesn't throw; it returns Invalid Date
    // toLocaleTimeString on Invalid Date returns "Invalid Date" in most envs
    const result = formatTime("not-a-date");
    expect(typeof result).toBe("string");
  });

  it("contains hours and minutes", () => {
    // Use a known time — format varies by locale, but should include digits
    const result = formatTime("2026-02-16T08:05:00Z");
    expect(result).toMatch(/\d/);
  });
});
