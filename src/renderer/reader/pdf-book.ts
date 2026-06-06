import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
// vite worker 入口：打包为独立 worker chunk，经 workerPort 接给 pdfjs
// oxlint-disable-next-line import/default -- Vite ?worker 虚拟模块，oxlint 无法解析默认导出
import PdfWorker from "pdfjs-dist/build/pdf.worker.mjs?worker";

if (!pdfjsLib.GlobalWorkerOptions.workerPort) {
  pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();
}

export interface PdfBook {
  pageCount: number;
  /** 第 1 页 scale=1 尺寸（v1 假设全书同尺寸，覆盖书籍/技术文档主流场景）。 */
  baseSize: { width: number; height: number };
  /**
   * 渲染第 index（0-based）页到 canvas：cssWidth 为目标 CSS 宽度，内部按
   * devicePixelRatio 放大物理像素。返回 cancel 句柄（滚走/卸载时调用）。
   */
  renderPage: (
    index: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
  ) => { done: Promise<void>; cancel: () => void };
  destroy: () => void;
}

export async function createPdfBook(bytes: Uint8Array): Promise<PdfBook> {
  // pdfjs 会 transfer 传入 buffer——传副本，避免 react-query 缓存的 bytes 被 neuter。
  const doc: PDFDocumentProxy = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const baseSize = { width: base.width, height: base.height };
  first.cleanup();

  return {
    pageCount: doc.numPages,
    baseSize,

    renderPage: (index, canvas, cssWidth) => {
      let task: RenderTask | null = null;
      let cancelled = false;
      const done = (async () => {
        const page = await doc.getPage(index + 1);
        try {
          if (cancelled) return;
          const dpr = window.devicePixelRatio || 1;
          const pageBase = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (cssWidth / pageBase.width) * dpr });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          // pdfjs v6 RenderParameters.canvas は必須フィールド（HTMLCanvasElement | null）。
          // renderer は実 DOM 環境なので型キャスト不要。
          task = page.render({ canvasContext: ctx, canvas, viewport });
          try {
            await task.promise;
          } catch (err) {
            // RenderingCancelledException = 主动取消，静默；其他错误透传
            if ((err as Error).name !== "RenderingCancelledException") throw err;
          }
        } finally {
          page.cleanup();
        }
      })();
      return {
        done,
        cancel: () => {
          cancelled = true;
          task?.cancel();
        },
      };
    },

    destroy: () => {
      // PDFDocumentProxy 无直接 destroy()；遵循 parse.ts 的模式：cleanup + loadingTask.destroy()。
      void doc.cleanup();
      void doc.loadingTask.destroy();
    },
  };
}
