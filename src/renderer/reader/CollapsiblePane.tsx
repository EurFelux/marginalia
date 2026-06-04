import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/utils";

/** 三向收起的物理类映射（DD-6：定位/位移/边框统一物理坐标——transform 无逻辑变体）。 */
const PEEK = {
  left: {
    pinned: "border-r",
    trigger: "inset-y-0 left-0 w-3",
    handle: "inset-y-0 left-0 w-1",
    drawer: "inset-y-0 left-0 border-r",
    closed: "-translate-x-full",
  },
  right: {
    pinned: "border-l",
    trigger: "inset-y-0 right-0 w-3",
    handle: "inset-y-0 right-0 w-1",
    drawer: "inset-y-0 right-0 border-l",
    closed: "translate-x-full",
  },
  top: {
    pinned: "border-b",
    trigger: "inset-x-0 top-0 h-3",
    handle: "inset-x-0 top-0 h-1",
    drawer: "inset-x-0 top-0 border-b",
    closed: "-translate-y-full",
  },
} as const;

interface CollapsiblePaneProps {
  side: "left" | "right" | "top";
  /** 钉住（true=文档流占位；false=收起为边缘 peek 抽屉）。 */
  open: boolean;
  /** 面板尺寸类（如 "w-64" / "w-96" / "h-12"）。 */
  sizeClass: string;
  /** 收起态边缘热区的 aria-label。 */
  label: string;
  /**
   * 追加到面板元素的类（两种模式都生效）。**勿传半透明背景**（如 bg-muted/30）——
   * tailwind-merge 会用它顶掉收起态抽屉的不透明 bg-background 底，浮层将透出正文；
   * 装饰性背景放 children 根元素（见 Sidebar / AIPanel）。
   */
  className?: string;
  children: ReactNode;
}

/**
 * 三向可收起面板（UP1 PeekDrawer 的单挂载点版）：钉住时在文档流占位；收起时同一元素
 * 切为贴边浮层抽屉——hover 3px 边缘热区滑出、移开 200ms 收回。children 树位置不变，
 * 开合不卸载（AIPanel 的 useChat 流式状态、Sidebar 滚动位置得以保活）。
 * 收起且未唤出时面板置 inert，挡掉离屏内容的 Tab 焦点与指针事件。
 */
export function CollapsiblePane({
  side,
  open,
  sizeClass,
  label,
  className,
  children,
}: CollapsiblePaneProps) {
  const [peekOpen, setPeekOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const c = PEEK[side];

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setPeekOpen(false), 200);
  };

  // 钉住时复位 peek 态；开合切换与卸载时清掉未决的收回计时器。
  useEffect(() => {
    if (open) setPeekOpen(false);
    return cancelClose;
  }, [open]);

  return (
    <>
      {/* 收起态：边缘 3px 热区 + 1px 常驻把手（hover 高亮并唤出抽屉） */}
      {!open && (
        <div
          aria-label={label}
          onMouseEnter={() => {
            cancelClose();
            setPeekOpen(true);
          }}
          className={cn("group absolute z-30", c.trigger)}
        >
          <div
            className={cn(
              "absolute bg-border/60 transition-colors group-hover:bg-primary/40",
              c.handle,
            )}
          />
        </div>
      )}

      {/* 面板本体：单挂载点，仅切 className（钉住=文档流；收起=贴边抽屉浮层） */}
      <div
        inert={!open && !peekOpen}
        onMouseEnter={open ? undefined : cancelClose}
        onMouseLeave={open ? undefined : scheduleClose}
        className={cn(
          "border-border",
          open
            ? cn("shrink-0", c.pinned)
            : cn(
                "absolute z-40 bg-background shadow-xl transition-transform duration-200 ease-out",
                c.drawer,
                peekOpen ? "translate-x-0 translate-y-0" : c.closed,
              ),
          sizeClass,
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
