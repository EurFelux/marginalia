/** 选区信息（S3 由 ReaderPane 写入；字段对齐 @shared/chat 的 buildChipsInput）。 */
export interface SelectionInfo {
  selectionText: string;
  paragraphBefore: string | null;
  paragraphCurrent: string;
  paragraphAfter: string | null;
  /** 选区锚点矩形（浮动工具栏定位用；S3 填充）。 */
  rect: { x: number; y: number; width: number; height: number } | null;
}

export interface ReaderPrefs {
  fontScale: number;
  lineHeight: number;
  maxWidth: number;
}
