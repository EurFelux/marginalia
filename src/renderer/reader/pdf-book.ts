import * as pdfjsLib from "pdfjs-dist";
import { AnnotationLayer, AnnotationType, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { PDFLinkService as PdfjsLinkService } from "pdfjs-dist/types/web/pdf_link_service.js";
// vite `?url` 资产引用：dev 给源模块 URL、build 输出 asset——pdfjs 按 workerSrc 每文档
// 自建 module worker，无共享状态。不用 `?worker` + GlobalWorkerOptions.workerPort：
// 共享 port 的 PDFWorker wrapper 在文档销毁/重建间存在竞态（CDP 冒烟实测
// getDocument 永久挂起、零报错），workerSrc 路径同环境实测正常。
// oxlint-disable-next-line import/default -- Vite ?url 虚拟模块，oxlint 无法解析默认导出
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfLinkService {
  externalLinkEnabled: boolean;
  getDestinationHash(dest: string | unknown[]): string;
  getAnchorUrl(anchor: string): string;
  addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void;
  goToDestination(dest: string | unknown[]): Promise<void>;
  goToPage(pageNumber: number | string): void;
  executeNamedAction(action: string): void;
}

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
    annotationLayerDiv?: HTMLDivElement,
    onLinkPage?: (pageNumber: number) => void,
  ) => { done: Promise<void>; cancel: () => void };
  destroy: () => void;
}

// pdfjs 资源目录（vite-plugin-static-copy 输出到产物根；dev 由插件中间件同路径供给）。
// 相对 document.baseURI 绝对化：dev = devserver 根，prod = .vite/renderer/main_window/。
const CMAP_URL = new URL("cmaps/", document.baseURI).href;
const STANDARD_FONT_DATA_URL = new URL("standard_fonts/", document.baseURI).href;

export async function createPdfBook(bytes: Uint8Array): Promise<PdfBook> {
  // pdfjs 会 transfer 传入 buffer——传副本，避免 react-query 缓存的 bytes 被 neuter。
  // cMapUrl：CID 字体（CJK 书常见）的编码映射，缺失会致部分书文字画错/textLayer 乱码；
  // standardFontDataUrl：标准 14 字体字形数据，非嵌入西文字体（Times/Arial 等）替代渲染用。
  // 注：未嵌入且替代表不认识的 CJK 字体名（方正系等）仍会回退默认字体——pdfjs 字体替代
  // 能力不及 Chrome 内置 PDFium（系统级 CJK 字体匹配链），属引擎边界非配置缺失。
  const loadingTask = pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });
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

  const makeLinkService = (goToPage: (pageNumber: number) => void): PdfLinkService => {
    const goToDestination = async (dest: string | unknown[]) => {
      const explicitDest = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicitDest)) return;
      const [destRef] = explicitDest;
      let pageNumber: number | null = null;
      if (destRef && typeof destRef === "object") {
        pageNumber = doc.cachedPageNumber(destRef as never);
        if (!pageNumber) pageNumber = (await doc.getPageIndex(destRef as never)) + 1;
      } else if (Number.isInteger(destRef)) {
        pageNumber = (destRef as number) + 1;
      }
      if (pageNumber != null && pageNumber >= 1 && pageNumber <= doc.numPages) goToPage(pageNumber);
    };
    return {
      externalLinkEnabled: true,
      getDestinationHash: (dest) => {
        if (typeof dest === "string") return dest.length > 0 ? `#${encodeURIComponent(dest)}` : "#";
        const encoded = encodeURIComponent(JSON.stringify(dest));
        return encoded.length > 0 ? `#${encoded}` : "#";
      },
      getAnchorUrl: (anchor) => anchor,
      addLinkAttributes: (link, url, newWindow = false) => {
        void newWindow;
        link.href = url;
        link.title = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer nofollow";
      },
      goToDestination,
      goToPage: (pageNumber) => {
        const n = typeof pageNumber === "string" ? Number.parseInt(pageNumber, 10) : pageNumber;
        if (Number.isInteger(n) && n >= 1 && n <= doc.numPages) goToPage(n);
      },
      executeNamedAction: (action) => {
        if (action === "FirstPage") goToPage(1);
        else if (action === "LastPage") goToPage(doc.numPages);
      },
    };
  };

  return {
    pageCount: doc.numPages,
    baseSize,

    renderPage: (index, canvas, cssWidth, textLayerDiv, annotationLayerDiv, onLinkPage) => {
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
          const annotationPromise = annotationLayerDiv
            ? (async () => {
                annotationLayerDiv.replaceChildren();
                annotationLayerDiv.style.setProperty("--total-scale-factor", String(cssScale));
                const linkService = makeLinkService((pageNumber) => onLinkPage?.(pageNumber));
                const annotationLayer = new AnnotationLayer({
                  div: annotationLayerDiv,
                  page,
                  viewport: page.getViewport({ scale: cssScale, dontFlip: true }),
                  linkService: linkService as unknown as PdfjsLinkService,
                  annotationStorage: doc.annotationStorage,
                  accessibilityManager: null,
                  annotationCanvasMap: null,
                  annotationEditorUIManager: null,
                  structTreeLayer: null,
                  commentManager: null,
                });
                const annotations = (await page.getAnnotations({ intent: "display" })).filter(
                  (a) => a.annotationType === AnnotationType.LINK,
                );
                await annotationLayer.render({
                  annotations,
                  div: annotationLayerDiv,
                  page,
                  viewport: page.getViewport({ scale: cssScale, dontFlip: true }),
                  linkService: linkService as unknown as PdfjsLinkService,
                  annotationStorage: doc.annotationStorage,
                  renderForms: false,
                });
              })()
            : Promise.resolve();
          const [canvasR, textR, annotationR] = await Promise.allSettled([
            task.promise.catch((err) => {
              // RenderingCancelledException = 主动取消，静默；其他错误透传
              if ((err as Error).name !== "RenderingCancelledException") throw err;
            }),
            textPromise.catch((err) => {
              // 取消时 TextLayer.render 以 AbortException reject——主动取消静默
              if (!cancelled) throw err;
            }),
            annotationPromise.catch((err) => {
              if (!cancelled) throw err;
            }),
          ]);
          if (canvasR.status === "rejected") throw canvasR.reason;
          if (textR.status === "rejected") throw textR.reason;
          if (annotationR.status === "rejected") throw annotationR.reason;
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
