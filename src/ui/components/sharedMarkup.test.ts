import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { findSharedMarkup } from "obsidian-llm-hub-common/check-markup";

/**
 * Shared chat UI markup lives in obsidian-llm-hub-common, so the three plugins cannot drift apart.
 * These classes are shared styling this plugin applies from code that is not chat UI; each says why.
 */
const HOST_OWNED = [
  // the Obsidian view container, added imperatively in ChatView
  "chat-container",
  // a selector, not markup: mobile keyboard tracking uses closest()
  "input-container",
  // the Obsidian view container, added imperatively in ChatView
  "wide-sidebar",
  // Native image previews retain this Safe Guard attachment-count/name marker.
  "pending-attachment",
];

/**
 * Chat UI this plugin still renders itself, waiting to move into the library. The list only ever
 * shrinks: the second test fails once an entry is gone, and nothing is added to make new code pass.
 */
const STILL_HOST_RENDERED: string[] = [
  "preview-btn",
];

const sourceDir = fileURLToPath(new URL("../..", import.meta.url));

describe("shared chat UI markup", () => {
  it("is not re-implemented outside the migration allowlist", async () => {
    const findings = await findSharedMarkup({ dir: sourceDir, classPrefix: "llm-hub", allow: [...HOST_OWNED, ...STILL_HOST_RENDERED] });
    const markup = [];
    for (const finding of findings) {
      const tree = ts.createSourceFile(finding.file, await readFile(finding.file, 'utf8'), ts.ScriptTarget.Latest, true);
      let selector = false;
      const inspect = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ['querySelector', 'querySelectorAll', 'closest'].includes(node.expression.name.text)) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument) && argument.text.includes(finding.className)
            && tree.getLineAndCharacterOfPosition(argument.getStart(tree)).line + 1 === finding.line) selector = true;
        }
        ts.forEachChild(node, inspect);
      };
      inspect(tree);
      if (!selector) markup.push(`${finding.className} (${finding.file}:${finding.line})`);
    }
    expect(markup).toEqual([]);
  });

  it("has no allowlist entries that are already migrated", async () => {
    const findings = await findSharedMarkup({ dir: sourceDir, classPrefix: "llm-hub" });
    const rendered = new Set(findings.map((finding) => finding.className.replace("llm-hub-", "")));
    expect([...HOST_OWNED, ...STILL_HOST_RENDERED].filter((className) => !rendered.has(className))).toEqual([]);
  });
});
