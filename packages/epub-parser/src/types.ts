/** ePub 目录树节点 */
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
  uid: string; // dc:identifier；缺失时由消费方回退文件哈希
  title?: string;
  author?: string;
  cover?: Uint8Array;
  spine: SpineItem[];
  toc: TocNode[];
}
