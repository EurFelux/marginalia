import { createLogger } from "@renderer/logger";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useAutoScrollStore, type AutoScrollStatus } from "@renderer/store/auto-scroll-store";
import { advanceCursor, isAtScrollEnd, speedPxPerSec, type ScrollCursor } from "./auto-scroll";

const log = createLogger("reader");

/** 阅读器 attach 进来的上下文（卸载时 detach）。 */
export interface AutoScrollContext {
  /** 真实滚动容器（ePub = VirtualDocs 的 scroller，PDF = Virtuoso 的 scroller）。 */
  getScroller: () => HTMLElement | null;
  /**
   * 此刻能否接管视口；false 时先不滚动、逐帧重查（spec §5.1）。ePub 开书恢复的目标首次对齐前
   * 为 false，此时接管会取消整个恢复。PDF 不需要。
   */
  canClaimViewport?: () => boolean;
  /** 宣告用户接管视口；开始 / 继续后、首次滚动前调用。ePub 借此取消进行中的定位收敛，PDF 不需要。 */
  claimViewport?: () => void;
}

/**
 * 用户直接操作正文的输入（与 VirtualDocs 的输入探测同一组），运行中任一发生即暂停。
 * 覆盖 PDF 页面与 ePub 的 iframe 外区域；ePub iframe 内的输入不冒泡，由 EpubReader 转调 pause()。
 */
const USER_INPUT_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

function setStatus(status: AutoScrollStatus): void {
  useAutoScrollStore.setState({ status });
}

class AutoScrollController {
  private ctx: AutoScrollContext | null = null;
  /** 运行中的滚动容器，挂着输入监听；暂停 / 停止时摘掉并置空。 */
  private scroller: HTMLElement | null = null;
  private frameId: number | null = null;
  /** 上一帧的整数毫秒时间戳：先取整再相减，各帧取整误差首尾抵消、不累积。 */
  private lastFrameMs: number | null = null;
  /** 自管的整数滚动游标（见 advanceCursor）；null = 下一帧取回读值。 */
  private cursor: ScrollCursor | null = null;
  /** 本轮运行是否已接管视口；接管前不滚动。 */
  private claimed = false;
  private readonly onUserInput = () => this.pause();

  attach(ctx: AutoScrollContext): void {
    this.ctx = ctx;
  }

  detach(): void {
    this.stop();
    this.ctx = null;
  }

  status(): AutoScrollStatus {
    return useAutoScrollStore.getState().status;
  }

  start(): void {
    if (this.status() === "idle") this.run();
  }

  resume(): void {
    if (this.status() === "paused") this.run();
  }

  pause(): void {
    if (this.status() !== "running") return;
    this.halt();
    setStatus("paused");
  }

  stop(): void {
    if (this.status() === "idle") return;
    this.halt();
    setStatus("idle");
  }

  /** 用户主动跳转（跳章 / 标注 / 搜索 / 页内链接）→ 暂停（spec §3.3）。 */
  notifyUserNavigation(): void {
    this.pause();
  }

  private run(): void {
    const scroller = this.ctx?.getScroller() ?? null;
    if (!scroller) {
      log.warn("auto-scroll not started: scroller not ready");
      return;
    }
    // 无处可滚：空闲时不启动，暂停中则收口为停止。还不能接管时（定位进行中）几何不可信，留到接管时再判。
    if (this.ctx?.canClaimViewport?.() !== false && isAtScrollEnd(scroller)) {
      this.stop();
      return;
    }
    // 接管推迟到首帧（见 step）；输入监听先挂上：等待接管期间用户操作照常暂停。
    this.claimed = false;
    this.scroller = scroller;
    for (const type of USER_INPUT_EVENTS) {
      scroller.addEventListener(type, this.onUserInput, { passive: true });
    }
    this.cursor = null;
    this.lastFrameMs = null;
    setStatus("running");
    this.frameId = requestAnimationFrame(this.step);
  }

  private halt(): void {
    if (this.frameId != null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    const scroller = this.scroller;
    if (scroller) {
      for (const type of USER_INPUT_EVENTS) scroller.removeEventListener(type, this.onUserInput);
    }
    this.scroller = null;
  }

  private readonly step = (now: number) => {
    this.frameId = null;
    const scroller = this.scroller;
    if (!scroller) return;
    if (!this.claimed) {
      // 等待接管期间不判书末：开书恢复的半途中列表总高还是估算、视口可能被夹在底部，会误判为书末。
      if (this.ctx?.canClaimViewport?.() === false) {
        this.frameId = requestAnimationFrame(this.step);
        return;
      }
      if (isAtScrollEnd(scroller)) {
        this.stop();
        return;
      }
      // claimViewport 不派发输入事件，不会把自己暂停。
      this.ctx?.claimViewport?.();
      this.claimed = true;
    }
    if (isAtScrollEnd(scroller)) {
      this.stop();
      return;
    }
    const nowMs = Math.round(now);
    const dtMs = this.lastFrameMs == null ? 0 : nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    // 档位逐帧读：运行中调速即时生效。
    const pxPerSec = speedPxPerSec(usePrefsStore.getState().autoScrollSpeed);
    this.cursor = advanceCursor(this.cursor, scroller.scrollTop, pxPerSec, dtMs);
    scroller.scrollTop = this.cursor.position;
    this.frameId = requestAnimationFrame(this.step);
  };
}

/** 模块单例：顶栏 / 控制条直接调方法（命令式），状态经 useAutoScrollStore 发布。
 *  跨书复位依赖 detach：换书时阅读器先 detach（→ stop → ctx=null）再 attach 新 ctx。
 */
export const autoScrollController = new AutoScrollController();
