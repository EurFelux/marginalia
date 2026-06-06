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
  const doc = await openPdf(bytes);
  try {
    const page = await doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const scale = opts.scale ?? (opts.targetWidth ? opts.targetWidth / base.width : 1);
    const viewport = page.getViewport({ scale: Math.min(scale, 4) });
    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    const context = canvas.getContext("2d");
    // pdfjs RenderParameters.canvas 要求 HTMLCanvasElement，但 Node 环境用 @napi-rs/canvas；
    // 运行时 pdfjs 实际只需 canvas 形状匹配，类型上整体转为 unknown 再 as never 绕开。
    await page.render({ canvasContext: context as never, canvas: canvas as never, viewport })
      .promise;
    page.cleanup();
    return new Uint8Array(canvas.toBuffer("image/png"));
  } finally {
    await doc.cleanup();
    await doc.loadingTask.destroy();
  }
}
