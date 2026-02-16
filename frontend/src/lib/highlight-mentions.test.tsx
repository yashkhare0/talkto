/** Tests for mention highlighting pure functions. */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { highlightMentions, applyMentionsToChildren } from "./highlight-mentions";

describe("highlightMentions", () => {
  it("returns plain text when mentions is null", () => {
    const result = highlightMentions("Hello world", null);
    expect(result).toBe("Hello world");
  });

  it("returns plain text when mentions is empty array", () => {
    const result = highlightMentions("Hello world", []);
    expect(result).toBe("Hello world");
  });

  it("returns plain text when no mentions match in the text", () => {
    const result = highlightMentions("Hello world", ["cosmic-penguin"]);
    expect(result).toBe("Hello world");
  });

  it("highlights a single mention", () => {
    const result = highlightMentions("Hey @cosmic-penguin check this", ["cosmic-penguin"]);

    // Should return an array of React elements (not a plain string)
    expect(Array.isArray(result)).toBe(true);

    // Render and check the output
    const { container } = render(<span>{result}</span>);
    expect(container.textContent).toBe("Hey @cosmic-penguin check this");

    // The mention span should have the highlight class
    const mentionSpan = container.querySelector(".text-violet-500");
    expect(mentionSpan).not.toBeNull();
    expect(mentionSpan!.textContent).toBe("@cosmic-penguin");
  });

  it("highlights multiple mentions", () => {
    const text = "@agent-a and @agent-b should collaborate";
    const result = highlightMentions(text, ["agent-a", "agent-b"]);

    const { container } = render(<span>{result}</span>);
    const mentions = container.querySelectorAll(".text-violet-500");
    expect(mentions).toHaveLength(2);
    expect(mentions[0].textContent).toBe("@agent-a");
    expect(mentions[1].textContent).toBe("@agent-b");
  });

  it("handles special regex characters in mention names", () => {
    // Edge case: names with characters that could break regex
    const result = highlightMentions("Hey @test.agent", ["test.agent"]);

    const { container } = render(<span>{result}</span>);
    expect(container.textContent).toBe("Hey @test.agent");
    const mention = container.querySelector(".text-violet-500");
    expect(mention).not.toBeNull();
  });
});

describe("applyMentionsToChildren", () => {
  it("returns children unchanged when mentions is null", () => {
    const result = applyMentionsToChildren("Hello", null);
    expect(result).toBe("Hello");
  });

  it("returns children unchanged when mentions is empty", () => {
    const result = applyMentionsToChildren("Hello", []);
    expect(result).toBe("Hello");
  });

  it("highlights mentions in a string child", () => {
    const result = applyMentionsToChildren("Hey @agent-a!", ["agent-a"]);

    // Should be a React element (from highlightMentions)
    expect(typeof result).not.toBe("string");
  });

  it("passes through non-string children unchanged", () => {
    const element = <div>test</div>;
    const result = applyMentionsToChildren(element, ["agent-a"]);
    expect(result).toBe(element);
  });

  it("processes arrays of children", () => {
    const children = ["Hello @agent-a", <span key="x">!</span>];
    const result = applyMentionsToChildren(children, ["agent-a"]);

    expect(Array.isArray(result)).toBe(true);
  });
});
