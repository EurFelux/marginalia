import { strFromU8 } from "fflate";
import { NodeType, parse as parseHtml, type HTMLElement, type Node } from "node-html-parser";
import { readSpineFromBytes, unzipEntry } from "./parse";
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

/** 有序 spine 文件路径。只解压 container.xml 与 OPF（大书的图片动辄上百 MB，不必解压）。 */
export function spineHrefs(bytes: Uint8Array): string[] {
  return readSpineFromBytes(bytes).map((s) => s.href);
}

/**
 * 单个 spine 文件的文本流：`<body>` 下全部文本节点（不像 htmlToText 只收块级元素，表格与 div
 * 段落也在内）。只解压该文件；缺失返回 null。纯函数：不碰 DB/fs。
 */
export function sectionTextFlow(bytes: Uint8Array, href: string): SectionTextFlow | null {
  const entry = unzipEntry(bytes, href);
  if (!entry) return null; // spine 列了但 zip 缺失 → 容错跳过
  const root = parseHtml(strFromU8(entry));
  const body = root.querySelector("body") ?? root;
  const flow = buildTextFlow<Node>(body, htmlAdapter);
  return { href, text: flow.text, breaks: flow.breaks, anchors: Object.fromEntries(flow.anchors) };
}

/** 按 spine 顺序取全部文件的文本流（一次性同步版本；主进程构建时逐章调用 sectionTextFlow 并让出事件循环）。 */
export function sectionTextFlows(bytes: Uint8Array): SectionTextFlow[] {
  return spineHrefs(bytes).flatMap((href) => sectionTextFlow(bytes, href) ?? []);
}
