import { useTranslation } from "react-i18next";
import { isoAt } from "@renderer/ai/message-time";
import { cn } from "@renderer/lib/utils";

/**
 * 气泡上方 hover/focus 才浮现的完整日期时间（原 assistant 名字所占的那行）。
 * 绝对定位落在消息间距里，不占布局——不 hover 时消息流保持干净。
 */
export function MessageTimestamp({
  at,
  timeZone,
  align,
}: {
  at: number;
  timeZone: string;
  align: "start" | "end";
}) {
  const { i18n } = useTranslation();
  const text = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone,
  }).format(at);
  return (
    <time
      dateTime={isoAt(at, timeZone)}
      className={cn(
        "pointer-events-none absolute -top-4 whitespace-nowrap text-[11px] leading-4 tabular-nums text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
        align === "end" ? "end-0" : "start-0",
      )}
    >
      {text}
    </time>
  );
}
