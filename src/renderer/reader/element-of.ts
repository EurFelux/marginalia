/**
 * 节点所在的元素（文本节点取父元素）。按 nodeType 判断而非 instanceof：ePub 正文在 iframe 里，
 * 那里的节点不是外层 window 的 Element 实例。
 */
export function elementOf(node: Node | null | undefined): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}
