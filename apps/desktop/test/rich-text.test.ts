import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import MarkdownIt from "markdown-it";
import { expect, it } from "vitest";

it("renders closed code fences and tables while escaping HTML and dangerous links", async () => {
  const window: {
    markdownit: typeof MarkdownIt;
    renderRichText?: (text: string) => string;
  } = { markdownit: MarkdownIt };
  runInContext(
    await readFile(
      new URL("../src/renderer/rich-text.js", import.meta.url),
      "utf8",
    ),
    createContext({ window }),
  );
  const html = window.renderRichText!(
    '```js\nconst x = "<script>";\n```\n\n**after**\n\n|A|B|\n|---|---|\n|1|2|\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n$x+y$',
  );
  expect(html).toContain("</code></pre>");
  expect(html).toContain("<strong>after</strong>");
  expect(html).toContain("<table>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('<span class="rich-math">x+y</span>');
});
