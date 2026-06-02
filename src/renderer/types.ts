/** 选区信息（S3 由 ReaderPane 写入；字段对齐 @shared/chat 的 buildChipsInput）。 */
export interface SelectionInfo {
  selectionText: string;
  paragraphBefore: string | null;
  paragraphCurrent: string;
  paragraphAfter: string | null;
  /** 选区锚点矩形（浮动工具栏定位用；S3 填充）。 */
  rect: { x: number; y: number; width: number; height: number } | null;
  /** 选区的 CFI range（RA1-full 落点，供未来 RA3 标注；AI chips 不需要）。 */
  cfiRange: string | null;
}

export interface ReaderPrefs {
  fontScale: number;
  lineHeight: number;
  maxWidth: number;
}
