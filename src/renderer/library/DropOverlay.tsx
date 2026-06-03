import { Download } from "lucide-react";
import { cn } from "@renderer/lib/utils";
import type { EpubDropHandlers } from "./use-epub-drop";

/**
 * 居中投放卡片 overlay（暗背景 + 虚线卡片）。
 * active=指针在卡片上 → accent 激活样式。zoneHandlers 接在卡片上（drop 落卡片才导入）。
 * 容器铺满视口、是书库根的 DOM 子节点，拖拽事件经冒泡回到 rootHandlers。
 */
export function DropOverlay({
  active,
  zoneHandlers,
}: {
  active: boolean;
  zoneHandlers: EpubDropHandlers;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 font-sans">
      <div
        {...zoneHandlers}
        className={cn(
          "flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-12 py-10 text-center transition",
          active
            ? "scale-105 border-primary bg-primary/10 text-primary ring-4 ring-primary/25"
            : "border-muted-foreground/40 bg-popover/60 text-muted-foreground",
        )}
      >
        <Download className="size-10" />
        <p className="text-base font-medium">{active ? "松手即导入" : "拖放 ePub 到此导入"}</p>
        <p className="text-xs opacity-70">支持一次拖入多本，非 ePub 会被忽略</p>
      </div>
    </div>
  );
}
