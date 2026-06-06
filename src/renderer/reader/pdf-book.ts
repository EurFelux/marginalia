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
   * 约束：对同一 canvas 发起新渲染前必须先调用上一次的 cancel()——pdfjs 不允许
   * 同一 canvas 并发两次 render()。done 在成功或取消时 resolve，意外渲染错误时 reject
   * （调用方需 catch，参照 EpubReader 的 parseError 模式翻译后呈现）。
   */
  renderPage: (
    index: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
  ) => { done: Promise<void>; cancel: () => void };
  destroy: () => void;
}

/**
 * 上一本书的销毁进度。PDFWorker 对「销毁中」的共享 port 直接抛
 * "the worker is being destroyed"（pdfjs 源码要求 await destroy()-calls），
 * 而 PdfBook.destroy 是同步接口（React cleanup 不能 await）——
 * 故在下一次 createPdfBook 入口处串行等待上一本销毁完成。
 */
let lastDestroy: Promise<unknown> = Promise.resolve();

export async function createPdfBook(bytes: Uint8Array): Promise<PdfBook> {
  await lastDestroy;
  // pdfjs 会 transfer 传入 buffer——传副本，避免 react-query 缓存的 bytes 被 neuter。
  const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() });
  let doc: PDFDocumentProxy;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    // 加载失败时 task 不会自清——显式 destroy 释放 worker 端半初始化状态（对齐 parse.ts openPdf）。
    await loadingTask.destroy().catch(() => {});
    throw err;
  }
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
          // pdfjs v6 RenderParameters.canvas 为必填字段（HTMLCanvasElement | null）；
          // renderer 是真实 DOM 环境，无需类型断言。
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
      // PDFDocumentProxy 无直接 destroy()；cleanup + loadingTask.destroy() 释放 worker 端文档资源。
      // 实证（pdfjs v6 源码）：port 模式下 PDFWorker.#webWorker 恒为 null，destroy 不会
      // 终止共享 OS worker，只移除 wrapper——下次 getDocument 同 port 正常重建。
      // destroy 的完成 promise 存入 lastDestroy，由下一次 createPdfBook 串行等待（见上）。
      lastDestroy = doc.loadingTask.destroy().catch(() => {});
    },
  };
}
