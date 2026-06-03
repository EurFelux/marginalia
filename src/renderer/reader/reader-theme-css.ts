/**
 * 暗色书页注入 iframe 的 CSS（由 VirtualDocs 拼在 ePub 自带样式**之前**）；
 * 亮色返回 "" 保留 ePub 原纸张样式。颜色写死十六进制（iframe 取不到父文档 CSS 变量），
 * 取护眼柔和暗（非纯黑）；`:where(...)` 0 特异性 + !important 救回带显式深色的正文元素。
 * 已知局限：带 `!important` 硬编码颜色的书无法被覆盖（注入在其样式之前）。
 */
export function readerThemeCss(isDark: boolean): string {
  if (!isDark) return "";
  return [
    `html { background-color: #15181c !important; }`,
    `body { background-color: #15181c !important; color: #c9cdd1 !important; }`,
    `body :where(p,li,dd,dt,blockquote,span,div,h1,h2,h3,h4,h5,h6,td,th,figcaption) { color: inherit !important; }`,
    `a { color: #6cb6d9 !important; }`,
    `img { filter: brightness(0.9); }`,
  ].join("\n");
}
