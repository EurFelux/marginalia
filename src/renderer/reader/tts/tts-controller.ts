import { createLogger } from "@renderer/logger";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useTtsStore } from "@renderer/store/tts-store";
import { detectParagraphLang } from "./detect-lang";
import { pickVoice } from "./pick-voice";
import { segmentParagraphs, type TtsParagraph } from "./segment-paragraphs";
import { createTtsEngine, type TtsEngine } from "./tts-engine";
import { browserSpeechPort, currentPlatform, getVoicesReady } from "./voices";

const log = createLogger("tts");

/** EpubReader attach 进来的上下文（卸载时 detach）。 */
export interface ReaderTtsContext {
  sectionCount: number;
  getTopSectionIndex: () => number;
  scrollToSection: (index: number) => void;
}

const SECTION_DOC_POLL_MS = 100;
const SECTION_DOC_TIMEOUT_MS = 5000;
/** 自动滚动后的 scroll 事件忽略窗（区分用户滚动以挂起跟随）。 */
const AUTO_SCROLL_IGNORE_MS = 300;

function sectionDoc(index: number): Document | null {
  const frame = document.querySelector<HTMLIFrameElement>(`[data-section-index="${index}"] iframe`);
  const doc = frame?.contentDocument ?? null;
  return doc?.body && doc.body.childNodes.length > 0 ? doc : null;
}

function sectionFrame(index: number): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>(`[data-section-index="${index}"] iframe`);
}

function scrollerEl(): Element | null {
  return document.querySelector(".no-scrollbar");
}

/** 视口内第一个可见段；无（图片页等）→ 0（spec §6：从该 section 第一段起）。 */
function firstVisibleParagraph(paras: TtsParagraph[], frame: HTMLIFrameElement): number {
  const scroller = scrollerEl();
  if (!scroller) return 0;
  const frameTop = frame.getBoundingClientRect().top;
  const view = scroller.getBoundingClientRect();
  for (let i = 0; i < paras.length; i++) {
    const r = paras[i]!.element.getBoundingClientRect(); // iframe 不内滚：主坐标 = frameTop + r
    if (frameTop + r.bottom > view.top + 4 && frameTop + r.top < view.bottom) return i;
  }
  return 0;
}

class TtsController {
  private ctx: ReaderTtsContext | null = null;
  private engine: TtsEngine | null = null;
  private paragraphs: TtsParagraph[] = [];
  private sectionIndex = 0;
  private voices: SpeechSynthesisVoice[] = [];
  /** 自动跨章中：忽略引擎的瞬时 idle、抑制用户导航打断判定。 */
  private crossing = false;
  private followSuspended = false;
  private ignoreScrollUntil = 0;
  private readonly onScrollerScroll = () => {
    if (performance.now() > this.ignoreScrollUntil && this.status() !== "idle") {
      this.followSuspended = true;
    }
  };

  attach(ctx: ReaderTtsContext): void {
    this.ctx = ctx;
    // scroll 不冒泡但可捕获（EpubReader 既有同款监听）；iframe 内滚轮经 VirtualDocs 转发
    // 后最终体现为 scroller 滚动，捕获 document scroll 即可观测到。
    document.addEventListener("scroll", this.onScrollerScroll, true);
  }

  detach(): void {
    this.stop();
    document.removeEventListener("scroll", this.onScrollerScroll, true);
    this.ctx = null;
  }

  status() {
    return useTtsStore.getState().status;
  }

  async playFromViewport(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.voices = await getVoicesReady();
    // await 期间换书/卸载则放弃本次起播
    if (this.ctx !== ctx) return;
    const index = ctx.getTopSectionIndex();
    const doc = sectionDoc(index);
    const frame = sectionFrame(index);
    if (!doc || !frame) {
      log.warn(`play aborted: section ${index} iframe not ready`);
      return;
    }
    const paras = segmentParagraphs(doc.body);
    if (paras.length === 0) {
      log.warn(`play aborted: section ${index} has no readable paragraphs`);
      return;
    }
    this.followSuspended = false;
    this.startSection(index, paras, firstVisibleParagraph(paras, frame));
  }

  pause(): void {
    this.engine?.pause();
  }

  resume(): void {
    this.followSuspended = false;
    this.engine?.resume();
  }

  stop(): void {
    this.crossing = false;
    this.engine?.stop();
    this.clearHighlight();
  }

  setRate(rate: number): void {
    this.engine?.setRate(rate);
  }

  /** 用户主动导航（跳章/标注跳转）→ 打断（spec §6）；自动跨章不算。 */
  notifyUserNavigation(): void {
    if (this.crossing || this.status() === "idle") return;
    this.stop();
  }

  private ensureEngine(): TtsEngine {
    if (this.engine) return this.engine;
    this.engine = createTtsEngine(browserSpeechPort(), {
      onParagraphChange: (i) => this.onParagraph(i),
      onStateChange: (s) => {
        if (this.crossing && s === "idle") return; // 跨章瞬时 idle 不发布
        useTtsStore.setState({ status: s });
      },
      onQueueEnd: () => void this.advanceSection(),
      onUtteranceError: (text, err) => log.warn(`utterance failed: ${text.slice(0, 40)}`, err),
    });
    return this.engine;
  }

  private startSection(index: number, paras: TtsParagraph[], startPara: number): void {
    const prefs = usePrefsStore.getState().ttsPrefs;
    const platform = currentPlatform();
    this.sectionIndex = index;
    this.paragraphs = paras;
    this.ensureEngine().play(
      paras.map((p) => p.text),
      startPara,
      {
        rate: prefs.rate,
        pickVoiceFor: (text) => pickVoice(detectParagraphLang(text), this.voices, prefs, platform),
      },
    );
  }

  private async advanceSection(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    let next = this.sectionIndex + 1;
    this.crossing = true;
    this.clearHighlight(); // 在 sectionIndex 指向旧章节时清除残留高亮
    try {
      while (next < ctx.sectionCount) {
        this.ignoreScrollUntil = performance.now() + AUTO_SCROLL_IGNORE_MS + SECTION_DOC_TIMEOUT_MS;
        ctx.scrollToSection(next);
        const doc = await this.waitForSectionDoc(next);
        if (!doc) {
          // crossing 已被 stop() 清除 → 用户主动停止，静默退出；否则真超时才 warn
          if (this.crossing) log.warn(`section ${next} iframe not ready in time, stopping`);
          break;
        }
        const paras = segmentParagraphs(doc.body);
        if (paras.length > 0) {
          this.ignoreScrollUntil = performance.now() + AUTO_SCROLL_IGNORE_MS;
          this.startSection(next, paras, 0);
          this.crossing = false;
          return;
        }
        next++; // 空 section（封面图等）继续向后
      }
    } finally {
      if (this.crossing) {
        this.crossing = false;
        this.clearHighlight();
        useTtsStore.setState({ status: "idle" }); // 书末/失败：收口为停止态
      }
    }
  }

  private waitForSectionDoc(index: number): Promise<Document | null> {
    return new Promise((resolve) => {
      const deadline = performance.now() + SECTION_DOC_TIMEOUT_MS;
      const tick = () => {
        if (this.crossing === false) return resolve(null); // 等待中被 stop
        const doc = sectionDoc(index);
        if (doc) return resolve(doc);
        if (performance.now() > deadline) return resolve(null);
        setTimeout(tick, SECTION_DOC_POLL_MS);
      };
      tick();
    });
  }

  private onParagraph(i: number): void {
    const para = this.paragraphs[i];
    const doc = sectionDoc(this.sectionIndex);
    if (!para || !doc) return;
    this.applyHighlight(doc, para.element);
    if (!this.followSuspended) this.scrollToParagraph(para.element);
  }

  private applyHighlight(doc: Document, el: Element): void {
    const win = doc.defaultView;
    if (!win?.CSS?.highlights) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    // 用 iframe realm 的 Highlight 构造器（跨 realm Range 注册不可靠）
    win.CSS.highlights.set("tts-current", new win.Highlight(range));
  }

  private clearHighlight(): void {
    const doc = sectionDoc(this.sectionIndex);
    doc?.defaultView?.CSS?.highlights?.delete("tts-current");
  }

  private scrollToParagraph(el: Element): void {
    const frame = sectionFrame(this.sectionIndex);
    const scroller = scrollerEl();
    if (!frame || !scroller) return;
    const view = scroller.getBoundingClientRect();
    const topMain = frame.getBoundingClientRect().top + el.getBoundingClientRect().top;
    if (topMain >= view.top && topMain <= view.bottom - 80) return; // 已可见
    this.ignoreScrollUntil = performance.now() + AUTO_SCROLL_IGNORE_MS;
    scroller.scrollBy({ top: topMain - view.top - view.height / 3 });
  }
}

/** 模块单例：顶栏/控制条直接调方法（命令式），状态经 useTtsStore 发布。
 *  单例跨书复位依赖 detach 链：换书时 EpubReader 先 detach（→ stop → ctx=null）再 attach 新 ctx。
 */
export const ttsController = new TtsController();
