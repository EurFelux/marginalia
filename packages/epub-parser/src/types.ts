/**
 * ePub 目录树节点。
 * `label` and `href` are non-empty (parser-filtered); `href` is an intra-archive path.
 */
export interface TocNode {
  label: string;
  href: string;
  children?: TocNode[];
}

/** spine 项：id 为 manifest item id（书内唯一）；href 已解析为包内绝对路径 */
export interface SpineItem {
  id: string;
  href: string;
}

/** parseEpub 的产物 */
export interface ParsedEpub {
  uid: string | null; // dc:identifier；null = no dc:identifier, consumer falls back to a content hash
  title?: string;
  author?: string;
  cover?: Uint8Array;
  spine: SpineItem[];
  toc: TocNode[];
}
