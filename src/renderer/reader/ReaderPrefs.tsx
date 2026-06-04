import { useTranslation } from "react-i18next";
import { Minus, Plus, Type } from "lucide-react";
import "lxgw-wenkai-webfont/lxgwwenkai-regular.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-serif-sc/400.css";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { usePrefsStore } from "@renderer/store/prefs-store";
import type { ReaderFontFamily } from "@renderer/types";
import { FONT_STACKS } from "./font-stacks";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

function Row({
  label,
  value,
  onDec,
  onInc,
}: {
  label: string;
  value: string;
  onDec: () => void;
  onInc: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 py-1">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDec}
          aria-label={t("reader.prefs.decrease", "减小{{label}}", { label })}
        >
          <Minus />
        </Button>
        <span className="w-12 text-center text-xs tabular-nums">{value}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onInc}
          aria-label={t("reader.prefs.increase", "增大{{label}}", { label })}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

const FONT_OPTIONS: ReadonlyArray<{ value: ReaderFontFamily; stack?: string }> = [
  { value: "default" },
  { value: "wenkai", stack: FONT_STACKS.wenkai },
  { value: "serif", stack: FONT_STACKS.serif },
  { value: "sans", stack: FONT_STACKS.sans },
];

function FontRow() {
  const { t } = useTranslation();
  const fontFamily = usePrefsStore((s) => s.prefs.fontFamily);
  const updatePrefs = usePrefsStore((s) => s.updatePrefs);
  // label 必须是字面 t() 调用:i18next-cli extract 识别不了动态键,动态键会被 removeUnusedKeys 清掉
  const labels: Record<ReaderFontFamily, string> = {
    default: t("reader.prefs.fontDefault", "原书默认"),
    wenkai: t("reader.prefs.fontWenkai", "文楷"),
    serif: t("reader.prefs.fontSerif", "宋体"),
    sans: t("reader.prefs.fontSans", "黑体"),
  };
  return (
    <div className="space-y-1.5">
      <span className="text-xs text-muted-foreground">{t("reader.prefs.fontFamily", "字体")}</span>
      <div className="grid grid-cols-2 gap-1.5">
        {FONT_OPTIONS.map((o) => (
          <Button
            key={o.value}
            variant={fontFamily === o.value ? "secondary" : "outline"}
            size="sm"
            aria-pressed={fontFamily === o.value}
            // 预览即所得:按钮用自家字体栈渲染(运行时数据驱动,内联 style 属规范允许的例外)
            style={o.stack ? { fontFamily: o.stack } : undefined}
            onClick={() => updatePrefs({ fontFamily: o.value })}
          >
            {labels[o.value]}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function ReaderPrefs() {
  const { t } = useTranslation();
  const prefs = usePrefsStore((s) => s.prefs);
  const updatePrefs = usePrefsStore((s) => s.updatePrefs);

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
        <Type />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-60 space-y-2">
        <Row
          label={t("reader.prefs.fontSize", "字号")}
          value={`${Math.round(prefs.fontScale * 100)}%`}
          onDec={() => updatePrefs({ fontScale: round2(clamp(prefs.fontScale - 0.05, 0.8, 1.5)) })}
          onInc={() => updatePrefs({ fontScale: round2(clamp(prefs.fontScale + 0.05, 0.8, 1.5)) })}
        />
        <Row
          label={t("reader.prefs.lineHeight", "行距")}
          value={prefs.lineHeight.toFixed(1)}
          onDec={() => updatePrefs({ lineHeight: round2(clamp(prefs.lineHeight - 0.1, 1.4, 2.4)) })}
          onInc={() => updatePrefs({ lineHeight: round2(clamp(prefs.lineHeight + 0.1, 1.4, 2.4)) })}
        />
        <Row
          label={t("reader.prefs.columnWidth", "栏宽")}
          value={`${prefs.maxWidth}px`}
          onDec={() => updatePrefs({ maxWidth: clamp(prefs.maxWidth - 40, 480, 820) })}
          onInc={() => updatePrefs({ maxWidth: clamp(prefs.maxWidth + 40, 480, 820) })}
        />
        <FontRow />
      </PopoverContent>
    </Popover>
  );
}
