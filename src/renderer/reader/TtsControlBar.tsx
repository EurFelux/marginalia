import { useTranslation } from "react-i18next";
import { Pause, Play, Square } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useTtsStore } from "@renderer/store/tts-store";
import { ttsController } from "@renderer/reader/tts/tts-controller";

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 朗读浮动控制条（spec §7.1）：正文区底部胶囊；status=idle 时不渲染。 */
export function TtsControlBar() {
  const { t } = useTranslation();
  const status = useTtsStore((s) => s.status);
  const rate = usePrefsStore((s) => s.ttsPrefs.rate);
  const updateTtsPrefs = usePrefsStore((s) => s.updateTtsPrefs);
  if (status === "idle") return null;

  const toggleLabel =
    status === "playing" ? t("reader.tts.pause", "暂停") : t("reader.tts.resume", "继续");
  return (
    <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover px-2 py-1 shadow-md">
      <Button
        variant="ghost"
        size="icon"
        aria-label={toggleLabel}
        onClick={() => (status === "playing" ? ttsController.pause() : ttsController.resume())}
      >
        {status === "playing" ? <Pause /> : <Play />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("reader.tts.stop", "停止")}
        onClick={() => ttsController.stop()}
      >
        <Square />
      </Button>
      <Select
        value={String(rate)}
        onValueChange={(val) => {
          if (val == null) return;
          const r = Number(val);
          updateTtsPrefs({ rate: r });
          ttsController.setRate(r);
        }}
      >
        <SelectTrigger
          className="h-8 w-20 border-none shadow-none"
          aria-label={t("reader.tts.rate", "语速")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RATE_OPTIONS.map((r) => (
            <SelectItem key={r} value={String(r)}>
              {r}×
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
