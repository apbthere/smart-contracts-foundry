// Canned content for the scripted agents (STUB_ANTHROPIC=1). Written for the default slugify brief.

export const stubSpec = (brief: string) => `Brief: ${brief}

Acceptance criteria:
1. Exports \`slugify(title: string): string\`, written in TypeScript.
2. Output contains only lowercase a-z, 0-9 and hyphens.
3. Every run of other characters becomes a single hyphen; no leading, trailing or repeated hyphens.
4. Accented letters are transliterated, e.g. "Café Crème" -> "cafe-creme".
5. At least 5 test cases with expected values, covering: empty string, punctuation only, accents, surrounding whitespace, repeated separators.`;

const implementation = `// slugify.ts
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "") // drop combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}`;

export const stubDeliverable = `${implementation}

// slugify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./slugify.ts";

test("words", () => assert.equal(slugify("Hello World"), "hello-world"));
test("empty", () => assert.equal(slugify(""), ""));
test("punctuation only", () => assert.equal(slugify("!!!"), ""));
test("accents", () => assert.equal(slugify("Café Crème"), "cafe-creme"));
test("surrounding whitespace", () => assert.equal(slugify("  Hello  "), "hello"));
test("repeated separators", () => assert.equal(slugify("foo--bar__baz"), "foo-bar-baz"));`;

export const stubShortcutDeliverable = `${implementation}

Tests to follow.`;

/** The canned deliverables differ only in whether they include the tests (criterion 5). */
export const hasTests = (deliverable = "") => /\btest\(/.test(deliverable);
