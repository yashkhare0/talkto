/**
 * Prompt engine tests — validates template rendering logic:
 * - {{ variable }} substitution
 * - {{ X or Y }} fallback syntax
 * - {% if X %} / {% if X or Y %} / {% if X and Y %} conditions
 * - {% else %} blocks
 * - {% include "file" %} directives
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// We need a fresh PromptEngine instance pointing at a temp dir.
// The class isn't exported directly, but we can import the module and
// instantiate via the constructor. Let's use a workaround:
// re-import the module source to get the class.

// Actually, the singleton is exported. We'll create our own engine by
// dynamically constructing one. The class is not exported, so let's
// test through a minimal wrapper that calls render() on a custom dir.

// Simplest approach: create a temp prompts dir and use a fresh engine.
// We can access the PromptEngine class by importing the module file.
// Since only the singleton is exported, we'll build a thin test helper.

const TEST_PROMPTS_DIR = join(import.meta.dir, "__test_prompts__");

// We need the PromptEngine class — it's not directly exported, but we
// can construct one by importing the module. Let's just re-create the
// render logic inline? No — better to test the real code. We'll use
// a trick: import the module, get the singleton, and create a new
// instance of the same class.
import { promptEngine } from "../src/services/prompt-engine";

// Use Object.getPrototypeOf to construct a new instance with our test dir
const PromptEngineClass = Object.getPrototypeOf(promptEngine).constructor;

let engine: typeof promptEngine;

beforeAll(() => {
  mkdirSync(TEST_PROMPTS_DIR, { recursive: true });
  mkdirSync(join(TEST_PROMPTS_DIR, "blocks"), { recursive: true });
  engine = new PromptEngineClass(TEST_PROMPTS_DIR);
});

afterAll(() => {
  rmSync(TEST_PROMPTS_DIR, { recursive: true, force: true });
});

function writeTemplate(name: string, content: string) {
  writeFileSync(join(TEST_PROMPTS_DIR, name), content, "utf-8");
}

// ──────────────────────────────────────────────────────────────────
// Basic variable substitution
// ──────────────────────────────────────────────────────────────────

describe("prompt-engine: {{ variable }} substitution", () => {
  test("replaces single variable", () => {
    writeTemplate("simple.md", "Hello {{ name }}!");
    expect(engine.render("simple.md", { name: "Alice" })).toBe("Hello Alice!");
  });

  test("replaces multiple variables", () => {
    writeTemplate("multi.md", "{{ greeting }} {{ name }}, welcome to {{ place }}.");
    const result = engine.render("multi.md", {
      greeting: "Hi",
      name: "Bob",
      place: "TalkTo",
    });
    expect(result).toBe("Hi Bob, welcome to TalkTo.");
  });

  test("leaves unknown variables as-is", () => {
    writeTemplate("unknown.md", "Hello {{ unknown_var }}!");
    // Since the var isn't in the map, the regex won't match it from
    // the entries loop. The result keeps the placeholder.
    const result = engine.render("unknown.md", {});
    expect(result).toBe("Hello {{ unknown_var }}!");
  });

  test("handles whitespace in braces", () => {
    writeTemplate("ws.md", "Hello {{  name  }}!");
    expect(engine.render("ws.md", { name: "Alice" })).toBe("Hello Alice!");
  });

  test("replaces same variable multiple times", () => {
    writeTemplate("repeat.md", "{{ x }} and {{ x }} again");
    expect(engine.render("repeat.md", { x: "val" })).toBe("val and val again");
  });
});

// ──────────────────────────────────────────────────────────────────
// {{ X or Y }} fallback syntax
// ──────────────────────────────────────────────────────────────────

describe("prompt-engine: {{ X or Y }} fallback", () => {
  test("uses first non-empty value", () => {
    writeTemplate("fallback.md", "Name: {{ display_name or name }}");
    const result = engine.render("fallback.md", {
      display_name: "Alice",
      name: "alice123",
    });
    expect(result).toBe("Name: Alice");
  });

  test("falls back to second when first is empty", () => {
    writeTemplate("fallback2.md", "Name: {{ display_name or name }}");
    const result = engine.render("fallback2.md", {
      display_name: "",
      name: "alice123",
    });
    expect(result).toBe("Name: alice123");
  });

  test("falls back to second when first is missing", () => {
    writeTemplate("fallback3.md", "Name: {{ display_name or name }}");
    const result = engine.render("fallback3.md", {
      name: "alice123",
    });
    expect(result).toBe("Name: alice123");
  });

  test("returns empty when all fallbacks are empty", () => {
    writeTemplate("fallback4.md", "Name: {{ a or b or c }}");
    const result = engine.render("fallback4.md", { a: "", b: "", c: "" });
    expect(result).toBe("Name: ");
  });

  test("supports three-way fallback", () => {
    writeTemplate("fallback5.md", "{{ a or b or c }}");
    expect(engine.render("fallback5.md", { a: "", b: "", c: "third" })).toBe("third");
    expect(engine.render("fallback5.md", { a: "", b: "second", c: "third" })).toBe("second");
    expect(engine.render("fallback5.md", { a: "first", b: "second", c: "third" })).toBe("first");
  });
});

// ──────────────────────────────────────────────────────────────────
// {% if var %} conditionals
// ──────────────────────────────────────────────────────────────────

describe("prompt-engine: {% if %} conditionals", () => {
  test("renders block when variable is truthy", () => {
    writeTemplate("if1.md", "{% if name %}Hello {{ name }}{% endif %}");
    expect(engine.render("if1.md", { name: "Alice" })).toBe("Hello Alice");
  });

  test("hides block when variable is empty", () => {
    writeTemplate("if2.md", "Before{% if name %} Hello{% endif %} After");
    expect(engine.render("if2.md", { name: "" })).toBe("Before After");
  });

  test("hides block when variable is missing", () => {
    writeTemplate("if3.md", "Before{% if name %} Hello{% endif %} After");
    expect(engine.render("if3.md", {})).toBe("Before After");
  });
});

// ──────────────────────────────────────────────────────────────────
// {% if X or Y %} conditionals
// ──────────────────────────────────────────────────────────────────

describe("prompt-engine: {% if X or Y %}", () => {
  test("renders when first var is truthy", () => {
    writeTemplate("ifor1.md", "{% if a or b %}yes{% endif %}");
    expect(engine.render("ifor1.md", { a: "val", b: "" })).toBe("yes");
  });

  test("renders when second var is truthy", () => {
    writeTemplate("ifor2.md", "{% if a or b %}yes{% endif %}");
    expect(engine.render("ifor2.md", { a: "", b: "val" })).toBe("yes");
  });

  test("renders when both are truthy", () => {
    writeTemplate("ifor3.md", "{% if a or b %}yes{% endif %}");
    expect(engine.render("ifor3.md", { a: "x", b: "y" })).toBe("yes");
  });

  test("hides when both are empty", () => {
    writeTemplate("ifor4.md", "{% if a or b %}yes{% endif %}");
    expect(engine.render("ifor4.md", { a: "", b: "" })).toBe("");
  });

  test("hides when both are missing", () => {
    writeTemplate("ifor5.md", "{% if a or b %}yes{% endif %}");
    expect(engine.render("ifor5.md", {})).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────
// {% if X and Y %} conditionals
// ──────────────────────────────────────────────────────────────────

describe("prompt-engine: {% if X and Y %}", () => {
  test("renders when both are truthy", () => {
    writeTemplate("ifand1.md", "{% if a and b %}yes{% endif %}");
    expect(engine.render("ifand1.md", { a: "x", b: "y" })).toBe("yes");
  });

  test("hides when first is empty", () => {
    writeTemplate("ifand2.md", "{% if a and b %}yes{% endif %}");
    expect(engine.render("ifand2.md", { a: "", b: "y" })).toBe("");
  });

  test("hides when second is empty", () => {
    writeTemplate("ifand3.md", "{% if a and b %}yes{% endif %}");
    expect(engine.render("ifand3.md", { a: "x", b: "" })).toBe("");
  });

  test("hides when both are empty", () => {
    writeTemplate("ifand4.md", "{% if a and b %}yes{% endif %}");
    expect(engine.render("ifand4.md", { a: "", b: "" })).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────
// {% else %} blocks
// ──────────────────────────────────────────────────────────────────

describe("prompt-engine: {% else %}", () => {
  test("renders if-branch when truthy", () => {
    writeTemplate("else1.md", "{% if name %}Hello {{ name }}{% else %}No name{% endif %}");
    expect(engine.render("else1.md", { name: "Alice" })).toBe("Hello Alice");
  });

  test("renders else-branch when falsy", () => {
    writeTemplate("else2.md", "{% if name %}Hello {{ name }}{% else %}No name{% endif %}");
    expect(engine.render("else2.md", { name: "" })).toBe("No name");
  });

  test("renders else-branch when missing", () => {
    writeTemplate("else3.md", "{% if name %}Hello{{ name }}{% else %}No name{% endif %}");
    expect(engine.render("else3.md", {})).toBe("No name");
  });

  test("else with or-condition", () => {
    writeTemplate("else4.md", "{% if a or b %}found{% else %}nothing{% endif %}");
    expect(engine.render("else4.md", { a: "x" })).toBe("found");
    expect(engine.render("else4.md", { a: "", b: "" })).toBe("nothing");
  });

  test("else with and-condition", () => {
    writeTemplate("else5.md", "{% if a and b %}both{% else %}not both{% endif %}");
    expect(engine.render("else5.md", { a: "x", b: "y" })).toBe("both");
    expect(engine.render("else5.md", { a: "x", b: "" })).toBe("not both");
  });
});

// ──────────────────────────────────────────────────────────────────
// {% include "file" %} directives
// ──────────────────────────────────────────────────────────────────

describe("prompt-engine: {% include %}", () => {
  test("includes a file", () => {
    writeTemplate("blocks/header.md", "HEADER CONTENT");
    writeTemplate("with-include.md", "Before {% include 'blocks/header.md' %} After");
    expect(engine.render("with-include.md", {})).toBe("Before HEADER CONTENT After");
  });

  test("missing include renders empty", () => {
    writeTemplate("missing-include.md", "Before {% include 'blocks/nonexistent.md' %} After");
    expect(engine.render("missing-include.md", {})).toBe("Before  After");
  });

  test("variables in included content are substituted", () => {
    writeTemplate("blocks/greeting.md", "Hello {{ name }}");
    writeTemplate("inc-vars.md", "{% include 'blocks/greeting.md' %}!");
    expect(engine.render("inc-vars.md", { name: "Alice" })).toBe("Hello Alice!");
  });
});

// ──────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────

describe("prompt-engine: edge cases", () => {
  test("missing template returns empty string", () => {
    expect(engine.render("nonexistent-template.md", {})).toBe("");
  });

  test("empty vars object works", () => {
    writeTemplate("novar.md", "Plain text with no variables.");
    expect(engine.render("novar.md")).toBe("Plain text with no variables.");
  });

  test("whitespace-only var treated as empty (falsy)", () => {
    writeTemplate("wsvar.md", "{% if name %}yes{% else %}no{% endif %}");
    expect(engine.render("wsvar.md", { name: "   " })).toBe("no");
  });

  test("whitespace-only var treated as empty in fallback", () => {
    writeTemplate("wsfallback.md", "{{ a or b }}");
    expect(engine.render("wsfallback.md", { a: "   ", b: "real" })).toBe("real");
  });
});
