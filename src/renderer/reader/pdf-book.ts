import * as pdfjsLib from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
// vite `?url` 资产引用：dev 给源模块 URL、build 输出 asset——pdfjs 按 workerSrc 每文档
// 自建 module worker，无共享状态。不用 `?worker` + GlobalWorkerOptions.workerPort：
// 共享 port 的 PDFWorker wrapper 在文档销毁/重建间存在竞态（CDP 冒烟实测
// getDocument 永久挂起、零报错），workerSrc 路径同环境实测正常。
// oxlint-disable-next-line import/default -- Vite ?url 虚拟模块，oxlint 无法解析默认导出
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfBook {
  pageCount: number;
  /** 第 1 页 scale=1 尺寸（v1 假设全书同尺寸，覆盖书籍/技术文档主流场景）。 */
  baseSize: { width: number; height: number };
  /**
   * 渲染第 index（0-based）页到 canvas，并（若给了 textLayerDiv）叠加 pdfjs TextLayer
   * （透明 span 流，承载原生选区）。cssWidth 为目标 CSS 宽度，canvas 内部按
   * devicePixelRatio 放大物理像素；textLayer 坐标系为 CSS 像素。
   * 约束：对同一 canvas 发起新渲染前必须先调用上一次的 cancel()——pdfjs 不允许
   * 同一 canvas 并发两次 render()。done 在成功或取消时 resolve，意外渲染错误时 reject
   * （调用方需 catch，参照 EpubReader 的 parseError 模式翻译后呈现）。
   */
  renderPage: (
    index: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
    textLayerDiv?: HTMLDivElement,
  ) => { done: Promise<void>; cancel: () => void };
  destroy: () => void;
}

export async function createPdfBook(bytes: Uint8Array): Promise<PdfBook> {
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

    renderPage: (index, canvas, cssWidth, textLayerDiv) => {
      let task: RenderTask | null = null;
      let textLayer: InstanceType<typeof TextLayer> | null = null;
      let cancelled = false;
      const done = (async () => {
        const page = await doc.getPage(index + 1);
        try {
          if (cancelled) return;
          const dpr = window.devicePixelRatio || 1;
          const pageBase = page.getViewport({ scale: 1 });
          const cssScale = cssWidth / pageBase.width;
          const viewport = page.getViewport({ scale: cssScale * dpr });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          task = page.render({ canvasContext: ctx, canvas, viewport });
          // textLayer 与 canvas 共享同一次 getPage、两路都 settle 后才 cleanup——
          // 独立生命周期会在 page.cleanup() 与进行中的另一路渲染间竞态（pdfjs 抛错）。
          const textPromise = textLayerDiv
            ? (async () => {
                textLayerDiv.replaceChildren();
                // v6 的 CSS 缩放变量是 --total-scale-factor（span 字号经 calc() 换算）；
                // textLayer 用 CSS 像素 viewport（不乘 dpr）。
                textLayerDiv.style.setProperty("--total-scale-factor", String(cssScale));
                textLayer = new TextLayer({
                  textContentSource: page.streamTextContent(),
                  container: textLayerDiv,
                  viewport: page.getViewport({ scale: cssScale }),
                });
                await textLayer.render();
              })()
            : Promise.resolve();
          const [canvasR, textR] = await Promise.allSettled([
            task.promise.catch((err) => {
              // RenderingCancelledException = 主动取消，静默；其他错误透传
              if ((err as Error).name !== "RenderingCancelledException") throw err;
            }),
            textPromise.catch((err) => {
              // 取消时 TextLayer.render 以 AbortException reject——主动取消静默
              if (!cancelled) throw err;
            }),
          ]);
          if (canvasR.status === "rejected") throw canvasR.reason;
          if (textR.status === "rejected") throw textR.reason;
        } finally {
          page.cleanup();
        }
      })();
      return {
        done,
        cancel: () => {
          cancelled = true;
          task?.cancel();
          textLayer?.cancel();
        },
      };
    },

    destroy: () => {
      // PDFDocumentProxy 无直接 destroy()；loadingTask.destroy() 释放 worker 端文档资源
      // 并终止该文档自有的 worker 线程（workerSrc 模式每文档一个 worker，无共享态）。
      void doc.loadingTask.destroy().catch(() => {});
    },
  };
}
