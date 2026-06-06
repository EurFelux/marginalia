import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-10 font-sans">
      <div
        {...zoneHandlers}
        className={cn(
          "flex min-h-[55vh] w-full max-w-2xl flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed text-center transition",
          active
            ? "scale-[1.02] border-primary bg-primary/10 text-primary ring-4 ring-primary/25"
            : "border-muted-foreground/40 bg-popover/60 text-muted-foreground",
        )}
      >
        <Download className="size-14" />
        <p className="text-xl font-medium">
          {active
            ? t("library.dropActive", "松手即导入")
            : t("library.dropHint", "拖放 ePub / PDF 到此导入")}
        </p>
        <p className="text-sm opacity-70">
          {t("library.dropSubhint", "支持一次拖入多本，不支持的文件会被忽略")}
        </p>
      </div>
    </div>
  );
}
