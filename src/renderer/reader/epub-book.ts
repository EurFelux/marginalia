import ePub, { EpubCFI, type Book } from "epubjs";
import type Section from "epubjs/types/section";

/** 高亮 mark 的 class；CFI 计算 / toRange 时作为 ignoreClass 传入，防止 mark 污染 CFI 路径。 */
export const ANNO_IGNORE_CLASS = "anno";

export interface EpubBook {
  /** spine 项数（= VirtualDocs 的 count）。 */
  count: number;
  /** 渲染第 index 个 spine 项为资源已解析的 HTML 串（喂 VirtualDocs.loadSection）。 */
  loadSection: (index: number) => Promise<string>;
  /** spine 项的 href（→ chapterIdByHref → 当前章/进度）。 */
  hrefAtIndex: (index: number) => string | null;
  /** href → spine index（跳章）；找不到返回 -1。 */
  indexOfHref: (href: string) => number;
  /** 顶部 section 起点 CFI（进度存储）；section 未就绪返回 null。 */
  cfiAtIndex: (index: number) => string | null;
  /** CFI → spine index（恢复）；非法/越界返回 -1。 */
  indexOfCfi: (cfi: string) => number;
  /** iframe range → CFI（选区落点）；失败返回 null。 */
  cfiFromRange: (index: number, range: Range) => string | null;
  /** CFI 区间串 → 给定 section 文档内的 DOM Range（高亮渲染）；失败返回 null。 */
  rangeFromCfi: (cfi: string, doc: Document) => Range | null;
  /** 释放 epubjs 资源（卸载书、blob URL）。 */
  destroy: () => void;
}

/** 取 section 文档里第一个块级元素（section 起点 CFI 的锚）。 */
function firstBlock(doc: Document): Element {
  return doc.body?.firstElementChild ?? doc.documentElement;
}

/** 取 href 末段文件名（去 fragment/query），用于跨实现的 href 匹配兜底。 */
function basenameOf(href: string): string {
  const p = href.split("#")[0]!.split("?")[0]!;
  return p.slice(p.lastIndexOf("/") + 1);
}

/**
 * 用 epubjs 解析 ePub 字节，暴露虚拟化渲染 + CFI 所需的最小接口。
 * 不使用 epubjs 的 Rendition/manager；仅作解析/资源/CFI 库。
 */
export async function createEpubBook(bytes: Uint8Array): Promise<EpubBook> {
  // epubjs 接受 ArrayBuffer；Uint8Array 取其底层 buffer。
  const book: Book = ePub(bytes.buffer as ArrayBuffer);
  await book.ready;

  const spine = book.spine;
  // spine 项数：运行时 epubjs Spine 有 `.length`（unpack 时由 items.length 赋值），
  // 但 0.3.93 的 spine.d.ts 未声明该属性，故需断言读取。
  const count: number = (spine as unknown as { length: number }).length;

  const sectionAt = (index: number): Section | null => {
    try {
      // 运行时 spine.get 越界返回 null（.d.ts 标注为非空 Section，保留 ?? 防御）。
      return spine.get(index) ?? null;
    } catch {
      return null;
    }
  };

  return {
    count,

    loadSection: async (index) => {
      const s = sectionAt(index);
      if (!s) return "<p>（本节不存在）</p>";
      // render 产出资源已解析的 HTML 串；request = book.load.bind(book)。
      // 注：section.d.ts 0.3.93 把 render 误标为同步返回 string，但运行时返回 Promise<string>
      // （lib/section.js 里 render 返回 defer().promise），故按真实类型断言后 await。
      // 渲染后 s.document 保留，供 cfiAtIndex/cfiFromRange（不 unload）。
      const html = await (s.render(book.load.bind(book)) as unknown as Promise<string>);
      return html;
    },

    hrefAtIndex: (index) => sectionAt(index)?.href ?? null,

    indexOfHref: (href) => {
      const bare = href.split("#")[0]!;
      // 先按 epubjs 的 href 空间精确查（spine.get(string) 内部已去 fragment、查 href 表）。
      const direct = (() => {
        try {
          return spine.get(bare) ?? spine.get(href) ?? null;
        } catch {
          return null;
        }
      })();
      if (direct) return direct.index;
      // 兜底：epub-parser 的 href 带 OPF 目录前缀（如 OEBPS/ch1.xhtml），而 epubjs 的
      // section.href 是 OPF 内裸形式（ch1.xhtml）——前缀不对称会让上面的精确查对「OPF 在子目录」
      // 的书失配（跳章失效）。退到 basename 匹配（与 chapterIdByHref 对称）；多命中视为歧义返 -1。
      const base = basenameOf(bare);
      let found = -1;
      for (let i = 0; i < count; i++) {
        const s = sectionAt(i);
        if (s && basenameOf(s.href) === base) {
          if (found !== -1) return -1;
          found = i;
        }
      }
      return found;
    },

    cfiAtIndex: (index) => {
      const s = sectionAt(index);
      // s.document 在 render 前为 undefined；.d.ts 标为非空 Document，保留真值检查防御。
      if (!s || !s.document) return null;
      try {
        // section.cfiFromElement 签名不收 ignoreClass，改用 EpubCFI 构造器传入 ANNO_IGNORE_CLASS，
        // 确保已插入的 <mark class="anno"> 节点对 CFI 路径透明。
        return new EpubCFI(firstBlock(s.document), s.cfiBase, ANNO_IGNORE_CLASS).toString();
      } catch {
        return null;
      }
    },

    indexOfCfi: (cfi) => {
      try {
        const parsed = new EpubCFI(cfi);
        const pos = parsed.spinePos;
        return typeof pos === "number" && pos >= 0 ? pos : -1;
      } catch {
        return -1;
      }
    },

    cfiFromRange: (index, range) => {
      const s = sectionAt(index);
      if (!s) return null;
      try {
        // section.cfiFromRange 签名不收 ignoreClass，改用 EpubCFI 构造器传入 ANNO_IGNORE_CLASS，
        // 确保已插入的 <mark class="anno"> 节点对 CFI 路径透明。
        return new EpubCFI(range, s.cfiBase, ANNO_IGNORE_CLASS).toString();
      } catch {
        return null;
      }
    },

    rangeFromCfi: (cfi, doc) => {
      try {
        return new EpubCFI(cfi).toRange(doc, ANNO_IGNORE_CLASS);
      } catch {
        return null;
      }
    },

    destroy: () => {
      try {
        book.destroy();
      } catch {
        /* best-effort 释放 */
      }
    },
  };
}
