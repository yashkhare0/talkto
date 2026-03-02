/**
 * Tests for the search route — snippet highlighting and query behavior.
 */

import { describe, test, expect } from "bun:test";
import { highlightSnippet } from "../src/routes/search";

describe("search snippet highlighting", () => {
  test("wraps matched term in <mark> tags", () => {
    const result = highlightSnippet("Hello world, this is a test", "world");
    expect(result).toContain("<mark>world</mark>");
  });

  test("case-insensitive matching", () => {
    const result = highlightSnippet("Hello World", "world");
    expect(result).toContain("<mark>World</mark>");
  });

  test("highlights all occurrences", () => {
    const result = highlightSnippet("test this test and test", "test");
    const matches = result.match(/<mark>/g);
    expect(matches?.length).toBe(3);
  });

  test("adds ellipsis for long content with match in middle", () => {
    const longContent = "a".repeat(100) + " MATCH " + "b".repeat(100);
    const result = highlightSnippet(longContent, "MATCH", 20);
    expect(result).toStartWith("…");
    expect(result).toEndWith("…");
    expect(result).toContain("<mark>MATCH</mark>");
  });

  test("no leading ellipsis when match is near start", () => {
    const result = highlightSnippet("MATCH " + "x".repeat(200), "MATCH", 20);
    expect(result).not.toStartWith("…");
    expect(result).toEndWith("…");
  });

  test("no trailing ellipsis when match is near end", () => {
    const result = highlightSnippet("x".repeat(200) + " MATCH", "MATCH", 20);
    expect(result).toStartWith("…");
    expect(result).not.toEndWith("…");
  });

  test("short content has no ellipsis", () => {
    const result = highlightSnippet("short text", "short");
    expect(result).not.toContain("…");
  });

  test("handles regex special characters in query", () => {
    const result = highlightSnippet("price is $100.00 total", "$100.00");
    expect(result).toContain("<mark>$100.00</mark>");
  });

  test("fallback when no match found", () => {
    const result = highlightSnippet("some content here", "nonexistent");
    expect(result).toBe("some content here");
  });

  test("fallback truncates long content when no match", () => {
    const longContent = "x".repeat(300);
    const result = highlightSnippet(longContent, "nonexistent", 80);
    expect(result.length).toBeLessThan(300);
    expect(result).toEndWith("…");
  });
});
