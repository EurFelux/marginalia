const STYLE_ID = "vd-style";
const PAINT_STYLE_ID = "vd-paint";

/**
 * 把（可能是片段或完整文档的）HTML 包成带注入 style 的完整文档串。两段注入样式都插在 `<head>` 最前，
 * 排在书自带样式之前：styleCss 在先，paintCss 在后。
 */
export function buildSrcDoc(html: string, styleCss?: string, paintCss?: string): string {
  const style =
    `<style id="${STYLE_ID}">${styleCss ?? ""}</style>` +
    `<style id="${PAINT_STYLE_ID}">${paintCss ?? ""}</style>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${style}`);
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}

/** 原地替换已载入文档里的 paintCss：不动 srcDoc，iframe 不重载。 */
export function applyPaintCss(doc: Document, paintCss: string): void {
  const el = doc.getElementById(PAINT_STYLE_ID);
  if (el && el.textContent !== paintCss) el.textContent = paintCss;
}
