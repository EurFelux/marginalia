import { strFromU8, unzipSync } from "fflate";
import { NodeType, parse as parseHtml, type HTMLElement, type Node } from "node-html-parser";
import { readSpine } from "./parse";
import { buildTextFlow, type FlowAdapter } from "./text-flow";

/** 单个 spine 文件的可搜索文本流（spec 2026-09-24 in-book-search §2）。 */
export interface SectionTextFlow {
  /** 包内路径（与 spine / 章节 href 同一空间）。 */
  href: string;
  text: string;
  breaks: number[];
  /** 元素 id → 该元素开始处的文本流偏移。 */
  anchors: Record<string, number>;
}

const htmlAdapter: FlowAdapter<Node> = {
  children: (n) => n.childNodes,
  text: (n) => (n.nodeType === NodeType.TEXT_NODE ? n.text : null),
  tag: (n) =>
    n.nodeType === NodeType.ELEMENT_NODE
      ? ((n as HTMLElement).rawTagName?.toLowerCase() ?? null)
      : null,
  id: (n) => (n.nodeType === NodeType.ELEMENT_NODE ? (n as HTMLElement).id || null : null),
};

/**
 * 按 spine 顺序取每个文件的文本流：`<body>` 下全部文本节点（不像 htmlToText 只收块级元素，
 * 表格与 div 段落也在内）。**只解压一次**。纯函数：不碰 DB/fs。
 */
export function sectionTextFlows(bytes: Uint8Array): SectionTextFlow[] {
  const files = unzipSync(bytes);
  const out: SectionTextFlow[] = [];
  for (const { href } of readSpine(files)) {
    const entry = files[href];
    if (!entry) continue; // spine 列了但 zip 缺失 → 容错跳过
    const root = parseHtml(strFromU8(entry));
    const body = root.querySelector("body") ?? root;
    const flow = buildTextFlow<Node>(body, htmlAdapter);
    out.push({
      href,
      text: flow.text,
      breaks: flow.breaks,
      anchors: Object.fromEntries(flow.anchors),
    });
  }
  return out;
}
