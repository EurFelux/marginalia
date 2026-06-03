/** 仅当拖拽负载含「外部文件」时才响应——忽略选区文本拖拽、内部元素拖拽。 */
export function isFilesDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

export interface SortedDrop<T> {
  epubs: T[];
  ignored: T[];
}

/**
 * 按 .epub 后缀（大小写不敏感）把拖入项分组：命中进 epubs，其余进 ignored。
 * 不依赖 MIME（epub 的 type 上报不稳定）；文件夹/pdf/txt 均无 .epub 后缀 → ignored。
 * 泛型保留真实 File 类型；输入顺序保留，便于稳定断言。
 */
export function pickEpubFiles<T extends { name: string }>(files: readonly T[]): SortedDrop<T> {
  const epubs: T[] = [];
  const ignored: T[] = [];
  for (const f of files) {
    if (f.name.toLowerCase().endsWith(".epub")) epubs.push(f);
    else ignored.push(f);
  }
  return { epubs, ignored };
}

/** 取路径末段文件名（按钮导入路径的失败提示用）。兼容 / 与 \ 分隔。 */
export function fileNameOf(path: string): string {
  const seg = path.split(/[\\/]/);
  return seg[seg.length - 1] || path;
}
