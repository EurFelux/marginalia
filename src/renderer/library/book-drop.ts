/** 仅当拖拽负载含「外部文件」时才响应——忽略选区文本拖拽、内部元素拖拽。 */
export function isFilesDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

const BOOK_EXTENSIONS = [".epub", ".pdf"];

export interface SortedDrop<T> {
  books: T[];
  ignored: T[];
}

/**
 * 按受支持的书籍后缀（大小写不敏感）把拖入项分组：命中进 books，其余进 ignored。
 * 不依赖 MIME（type 上报不稳定）；文件夹/txt 等无匹配后缀 → ignored。
 * 泛型保留真实 File 类型；输入顺序保留，便于稳定断言。
 */
export function pickBookFiles<T extends { name: string }>(files: readonly T[]): SortedDrop<T> {
  const books: T[] = [];
  const ignored: T[] = [];
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (BOOK_EXTENSIONS.some((ext) => lower.endsWith(ext))) books.push(f);
    else ignored.push(f);
  }
  return { books, ignored };
}

/** 取路径末段文件名（按钮导入路径的失败提示用）。兼容 / 与 \ 分隔。 */
export function fileNameOf(path: string): string {
  const seg = path.split(/[\\/]/);
  return seg[seg.length - 1] || path;
}
