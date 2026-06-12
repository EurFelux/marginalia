/**
 * 朗读段（spec §4.1）：text 是规范化空白后的朗读文本；element 是高亮/滚动锚点。
 * 持 Element 而非 Range 端点——高亮时惰性 `range.selectNodeContents(element)`，
 * 等价满足 spec「不持有 live Range」的意图且更不易失效。
 */
export interface TtsParagraph {
  text: string;
  element: Element;
}

/** 块级段选择器：与 EpubReader.topElementCfi 的块清单同族，外加 div 叶兜底（裸 div 段落的 ePub）。 */
const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dt,dd,pre,div";

const SKIP_CLOSEST = "script,style,template,noscript,[hidden],[aria-hidden='true']";

/**
 * 把 section 文档切成有序朗读段（spec §4.1）：取**最内层**块级元素（含块级后代的容器
 * 被滤掉，防嵌套重复），规范化空白，跳过空段/纯标点段/隐藏子树。
 * 已知限制：直接置于同时含块级子元素的容器内的文本节点（如 `<div>导语<p>…</p></div>` 中
 * 的"导语"）不会被朗读——此为最内层块策略的设计权衡，不改行为。
 */
export function segmentParagraphs(root: ParentNode): TtsParagraph[] {
  const out: TtsParagraph[] = [];
  for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
    if (el.querySelector(BLOCK_SELECTOR)) continue;
    if (el.closest(SKIP_CLOSEST)) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
    out.push({ text, element: el });
  }
  return out;
}
