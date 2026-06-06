import { createCanvas } from "@napi-rs/canvas";
import { openPdf } from "./parse";

export interface RenderOptions {
  /** 渲染倍率；省略时按 targetWidth 计算。 */
  scale?: number;
  /** 目标像素宽（如封面 600）；与 scale 二选一，scale 优先。 */
  targetWidth?: number;
}

/**
 * 渲染单页为 PNG（Node 环境：直接用 @napi-rs/canvas 构建画布，
 * 无需依赖 pdfjs 内部 canvasFactory 私有 API）。
 * scale 上限为 4，防止超大页面耗尽内存。
 */
export async function renderPageImage(
  bytes: Uint8Array,
  pageNo: number,
  opts: RenderOptions = {},
): Promise<Uint8Array> {
  // 显式拒绝非正缩放：scale:0/targetWidth:0 会静默产出 0×0 退化 PNG（封面变空图），
  // 早抛比污染 books.cover 诚实。
  if (opts.scale !== undefined && opts.scale <= 0) {
    throw new RangeError(`renderPageImage: scale must be positive, got ${opts.scale}`);
  }
  if (opts.targetWidth !== undefined && opts.targetWidth <= 0) {
    throw new RangeError(`renderPageImage: targetWidth must be positive, got ${opts.targetWidth}`);
  }
  const doc = await openPdf(bytes);
  try {
    const page = await doc.getPage(pageNo);
    try {
      const base = page.getViewport({ scale: 1 });
      const scale = opts.scale ?? (opts.targetWidth ? opts.targetWidth / base.width : 1);
      const viewport = page.getViewport({ scale: Math.min(scale, 4) });
      const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
      const context = canvas.getContext("2d");
      // pdfjs RenderParameters.canvas 要求 HTMLCanvasElement，但 Node 环境用 @napi-rs/canvas；
      // 运行时 pdfjs 实际只需 canvas 形状匹配，类型上整体转为 unknown 再 as never 绕开。
      await page.render({ canvasContext: context as never, canvas: canvas as never, viewport })
        .promise;
      return new Uint8Array(canvas.toBuffer("image/png"));
    } finally {
      // render 失败也要清 page intent，否则外层 doc.cleanup() 会因「页面渲染中」抛误导性错误。
      page.cleanup();
    }
  } finally {
    await doc.cleanup();
    await doc.loadingTask.destroy();
  }
}
