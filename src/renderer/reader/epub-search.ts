import { buildTextFlow, type FlowAdapter, type TextFlow } from "@marginalia/epub-parser";
import { findMatches, type TextMatch } from "@shared/text-search";

/**
 * ePub 搜索命中在 section iframe 文档里的锚定与高亮（spec 2026-09-24 in-book-search §4）。
 * 文本流规则与主进程 sectionTextFlows 共用 buildTextFlow，故「第 k 个命中」两侧一致。
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const domAdapter: FlowAdapter<Node> = {
  children: (n) => Array.from(n.childNodes),
  text: (n) => (n.nodeType === TEXT_NODE ? (n.nodeValue ?? "") : null),
  tag: (n) => (n.nodeType === ELEMENT_NODE ? (n as Element).localName.toLowerCase() : null),
  id: (n) => (n.nodeType === ELEMENT_NODE ? (n as Element).id || null : null),
};

export function domTextFlow(doc: Document): TextFlow<Node> {
  return buildTextFlow<Node>(doc.body ?? doc.documentElement, domAdapter);
}

/** 文本流偏移 → DOM 位置。end 为开区间：落在两段交界时归前一段末尾。 */
function positionAt(flow: TextFlow<Node>, offset: number, isEnd: boolean) {
  const segs = flow.segments;
  let lo = 0;
  let hi = segs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid]!;
    if (isEnd ? s.start < offset : s.start <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const seg = segs[found]!;
  return { node: seg.node, offset: offset - seg.start };
}

export interface DomPosition {
  node: Node;
  offset: number;
}

/** 每个命中在文档里的起止位置（文本节点 + 节点内偏移）。 */
export function searchPositions(
  doc: Document,
  query: string,
): Array<{ start: DomPosition; end: DomPosition }> {
  const flow = domTextFlow(doc);
  return findMatches(flow, query).flatMap((m: TextMatch) => {
    const start = positionAt(flow, m.start, false);
    const end = positionAt(flow, m.end, true);
    return start && end ? [{ start, end }] : [];
  });
}

export function searchRanges(doc: Document, query: string): Range[] {
  return searchPositions(doc, query).map(({ start, end }) => {
    const range = doc.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  });
}

/** 取第 occurrence 个命中；数量对不上（解析差异）时退到最后一个，不静默失败。 */
export function locateSearchHit(doc: Document, query: string, occurrence: number): Range | null {
  const ranges = searchRanges(doc, query);
  return ranges[occurrence] ?? ranges.at(-1) ?? null;
}

const ALL = "marginalia-search";
const ACTIVE = "marginalia-search-active";

/** 注入 section iframe 的样式：CSS Custom Highlight API，不改 DOM、不影响 CFI 与标注 <mark>。 */
export const SEARCH_HIGHLIGHT_CSS = `
::highlight(${ALL}) { background-color: rgb(250 204 21 / 0.35); }
::highlight(${ACTIVE}) { background-color: rgb(249 115 22 / 0.55); }
`;

type HighlightWindow = Window & {
  CSS?: { highlights?: Map<string, unknown> };
  Highlight?: new (...ranges: Range[]) => unknown;
};

/** 在该文档里高亮 query 的全部命中，并突出第 activeOccurrence 个；query 为 null 时清除。 */
export function applySearchHighlights(
  doc: Document,
  query: string | null,
  activeOccurrence: number | null,
): void {
  // Highlight 与 registry 必须取自 iframe 自己的 window（跨 realm）。
  const win = doc.defaultView as HighlightWindow | null;
  const registry = win?.CSS?.highlights;
  const Highlight = win?.Highlight;
  if (!registry || !Highlight) return;
  registry.delete(ALL);
  registry.delete(ACTIVE);
  if (!query) return;
  const ranges = searchRanges(doc, query);
  if (ranges.length === 0) return;
  registry.set(ALL, new Highlight(...ranges));
  if (activeOccurrence !== null) {
    const active = ranges[activeOccurrence] ?? ranges.at(-1);
    if (active) registry.set(ACTIVE, new Highlight(active));
  }
}
