const SHOW_TEXT = 4;
const IGNORED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);
const POSITION_ELEMENTS =
  "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figcaption,div,article,section,main,aside,header,footer,figure,td,th,dt,dd";

function isReadableText(text: Text, body: HTMLElement): boolean {
  if (!text.data.trim() || !body.contains(text)) return false;

  for (let element = text.parentElement; element; element = element.parentElement) {
    if (
      IGNORED_TAGS.has(element.tagName) ||
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    if (element === body) break;
  }

  return true;
}

function readableTextNodes(doc: Document): Text[] {
  const body = doc.body;
  if (!body) return [];

  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(body, SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    if (isReadableText(text, body)) nodes.push(text);
    node = walker.nextNode();
  }
  return nodes;
}

export function firstReadableTextNode(root: Node): Text | null {
  const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  if (!doc) return null;

  return readableTextNodes(doc).find((text) => root.contains(text)) ?? null;
}

export function readableTextLength(doc: Document): number {
  return readableTextNodes(doc).reduce((total, text) => total + text.data.length, 0);
}

export function readableTextOffsetAtRange(doc: Document, range: Range): number | null {
  const start = range.startContainer;
  if (start.ownerDocument !== doc || start.nodeType !== 3) return null;

  let offset = 0;
  for (const text of readableTextNodes(doc)) {
    if (text === start) {
      return offset + Math.min(Math.max(range.startOffset, 0), text.data.length);
    }
    offset += text.data.length;
  }

  return null;
}

/**
 * Find the first readable character in the content block crossing a document-space y coordinate.
 * EPUBs commonly use generic divs, table cells, or direct body text instead of semantic paragraphs,
 * so the body is always a fallback and the deepest matching content block wins.
 */
export function readableTextRangeAtY(doc: Document, targetY: number): Range | null {
  const body = doc.body;
  if (!body) return null;

  const textNodes = readableTextNodes(doc);
  if (textNodes.length === 0) return null;

  const readableElements = new Set<Element>([body]);
  for (const text of textNodes) {
    for (let element = text.parentElement; element; element = element.parentElement) {
      if (element === body || element.matches(POSITION_ELEMENTS)) readableElements.add(element);
      if (element === body) break;
    }
  }

  const candidates = [body, ...body.querySelectorAll(POSITION_ELEMENTS)].filter((element) =>
    readableElements.has(element),
  );
  let crossing: Element | null = null;
  let preceding: Element | null = null;
  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    if (rect.top <= targetY + 4) preceding = element;
    if (rect.top <= targetY + 4 && rect.bottom > targetY - 4) crossing = element;
  }

  const root = crossing ?? preceding ?? candidates[0]!;
  const text = textNodes.find((node) => root.contains(node)) ?? null;
  if (!text) return null;

  const range = doc.createRange();
  range.setStart(text, 0);
  range.collapse(true);
  return range;
}
