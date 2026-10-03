import { useTranslation } from "react-i18next";
import { Minus, Pause, Play, Plus, Square } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useAutoScrollStore } from "@renderer/store/auto-scroll-store";
import { autoScrollController } from "@renderer/reader/auto-scroll/auto-scroll-controller";
import {
  MAX_SPEED_LEVEL,
  MIN_SPEED_LEVEL,
  clampSpeedLevel,
  formatSpeedLevel,
  stepSpeedLevel,
} from "@renderer/reader/auto-scroll/auto-scroll";

/** 自动滚动浮动控制条（spec §3.1）：样式与位置同 TtsControlBar；status=idle 时不渲染。 */
export function AutoScrollControlBar() {
  const { t } = useTranslation();
  const status = useAutoScrollStore((s) => s.status);
  const speed = clampSpeedLevel(usePrefsStore((s) => s.autoScrollSpeed));
  const setAutoScrollSpeed = usePrefsStore((s) => s.setAutoScrollSpeed);
  if (status === "idle") return null;

  const toggleLabel =
    status === "running"
      ? t("reader.autoScroll.pause", "暂停")
      : t("reader.autoScroll.resume", "继续");
  return (
    <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover px-2 py-1 shadow-md">
      <Button
        variant="ghost"
        size="icon"
        aria-label={toggleLabel}
        onClick={() =>
          status === "running" ? autoScrollController.pause() : autoScrollController.resume()
        }
      >
        {status === "running" ? <Pause /> : <Play />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("reader.autoScroll.slower", "减速")}
        disabled={speed <= MIN_SPEED_LEVEL}
        onClick={() => setAutoScrollSpeed(stepSpeedLevel(speed, -1))}
      >
        <Minus />
      </Button>
      <span
        className="w-10 text-center text-sm tabular-nums"
        aria-label={t("reader.autoScroll.speed", "滚动速度")}
      >
        {formatSpeedLevel(speed)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("reader.autoScroll.faster", "加速")}
        disabled={speed >= MAX_SPEED_LEVEL}
        onClick={() => setAutoScrollSpeed(stepSpeedLevel(speed, 1))}
      >
        <Plus />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("reader.autoScroll.stop", "停止自动滚动")}
        onClick={() => autoScrollController.stop()}
      >
        <Square />
      </Button>
    </div>
  );
}
