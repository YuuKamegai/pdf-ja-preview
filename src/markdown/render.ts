import MarkdownIt from 'markdown-it';

// html:false により原文中の生 HTML はエスケープされる。Webview の CSP と合わせた二重の防御。
const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });

export function renderMarkdown(markdown: string): string {
  return md.render(markdown);
}
