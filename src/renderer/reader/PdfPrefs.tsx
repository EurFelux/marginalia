import { useTranslation } from "react-i18next";
import { Minus, Plus, ZoomIn } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { clampPdfZoom, PDF_ZOOM_STEP } from "./pdf-zoom";

/**
 * 缩放百分比输入框（对齐浏览器 PDF viewer）：点击全选、输入数字、Enter/失焦应用。
 * 非受控 + key=display：合法提交后 zoom 变化触发重挂重置；非法/同值提交则手动还原显示。
 */
function ZoomValueInput({ zoom, onCommit }: { zoom: number; onCommit: (pct: number) => void }) {
  const { t } = useTranslation();
  const display = `${Math.round(zoom * 100)}%`;
  return (
    <input
      key={display}
      type="text"
      inputMode="numeric"
      defaultValue={display}
      aria-label={t("reader.pdf.zoom", "缩放")}
      className="w-12 bg-transparent text-center text-xs tabular-nums outline-none"
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      onBlur={(e) => {
        // 容忍 "85%"、" 85 " 等输入；非法（NaN/非正数）不提交。
        const pct = Number.parseFloat(e.currentTarget.value.replace(/[^\d.]/g, ""));
        if (Number.isFinite(pct) && pct > 0) onCommit(pct);
        e.currentTarget.value = display; // 非法或 clamp 后同值时还原；变化时 key 重挂覆盖
      }}
    />
  );
}

/** PDF 阅读偏好弹层（顶栏触发，对齐 ePub 的 ReaderPrefs）：目前仅缩放倍率。 */
export function PdfPrefs() {
  const { t } = useTranslation();
  const pdfZoom = usePrefsStore((s) => s.pdfZoom);
  const setPdfZoom = usePrefsStore((s) => s.setPdfZoom);
  const zoom = clampPdfZoom(pdfZoom);
  const label = t("reader.pdf.zoom", "缩放");

  const step = (delta: number) => setPdfZoom(clampPdfZoom(zoom + delta));

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            aria-label={t("reader.prefs.title", "阅读偏好")}
          />
        }
      >
        <ZoomIn />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-60 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <div className="flex items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 py-1">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => step(-PDF_ZOOM_STEP)}
              aria-label={t("reader.prefs.decrease", "减小{{label}}", { label })}
            >
              <Minus />
            </Button>
            <ZoomValueInput zoom={zoom} onCommit={(pct) => setPdfZoom(clampPdfZoom(pct / 100))} />
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => step(PDF_ZOOM_STEP)}
              aria-label={t("reader.prefs.increase", "增大{{label}}", { label })}
            >
              <Plus />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
