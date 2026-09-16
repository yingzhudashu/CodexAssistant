// 使用成熟解析器处理围栏、列表和表格；禁止原始 HTML，正文不能变成可执行节点。
const markdown = window.markdownit({
  html: false,
  linkify: false,
  typographer: false,
});
markdown.renderer.rules.text = (tokens, index) =>
  markdown.utils
    .escapeHtml(tokens[index].content)
    .replace(/\$([^$\n]+)\$/g, '<span class="rich-math">$1</span>');
window.renderRichText = (text) =>
  markdown.render(String(text || "")) ||
  '<p class="muted">暂未提供可读内容。</p>';
