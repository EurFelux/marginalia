/**
 * 书内搜索的文本流（spec 2026-09-24 in-book-search §2，主仓库 docs/specs）：某个文档根下所有文本节点按文档序拼接，
 * 排除脚本 / 样式类子树。块级元素边界记为虚拟断点（不占偏移，匹配时视作空白）。
 *
 * 经适配器同时作用于主进程的 node-html-parser 树与渲染层的真实 DOM：两侧规则必须一字不差，
 * 主进程算出的「第 k 个命中」才能在渲染层的 iframe 文档里取回同一处。
 */

export interface FlowAdapter<N> {
  children(node: N): readonly N[];
  /** 文本节点的文本（已解码）；非文本节点返回 null。 */
  text(node: N): string | null;
  /** 元素的小写标签名；非元素返回 null。 */
  tag(node: N): string | null;
  /** 元素 id；无则 null。 */
  id(node: N): string | null;
}

export interface TextFlow<N> {
  text: string;
  /** 升序、去重的虚拟断点（在 text[b] 之前）。 */
  breaks: number[];
  /** 每个文本节点及其在文本流中的起点。 */
  segments: Array<{ node: N; start: number }>;
  /** 元素 id → 该元素开始处的文本流偏移（同 id 取首次出现）。 */
  anchors: Map<string, number>;
}

const SKIPPED = new Set(["script", "style", "template", "noscript", "head"]);

const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "br",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

export function buildTextFlow<N>(root: N, adapter: FlowAdapter<N>): TextFlow<N> {
  let text = "";
  const breaks: number[] = [];
  const segments: TextFlow<N>["segments"] = [];
  const anchors = new Map<string, number>();

  const addBreak = () => {
    if (breaks.at(-1) !== text.length) breaks.push(text.length);
  };
  const visit = (node: N) => {
    const value = adapter.text(node);
    if (value !== null) {
      if (value.length > 0) {
        segments.push({ node, start: text.length });
        text += value;
      }
      return;
    }
    const tag = adapter.tag(node);
    if (tag !== null && SKIPPED.has(tag)) return;
    const id = adapter.id(node);
    if (id && !anchors.has(id)) anchors.set(id, text.length);
    const block = tag !== null && BLOCKS.has(tag);
    if (block) addBreak();
    for (const child of adapter.children(node)) visit(child);
    if (block) addBreak();
  };
  visit(root);
  return { text, breaks, segments, anchors };
}
