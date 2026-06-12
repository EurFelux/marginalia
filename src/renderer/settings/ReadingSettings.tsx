import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Volume2 } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { usePrefsStore } from "@renderer/store/prefs-store";
import type { TtsLang } from "@renderer/reader/tts/detect-lang";
import { NOVELTY_BLOCKLIST, pickVoice } from "@renderer/reader/tts/pick-voice";
import { currentPlatform, getVoicesReady } from "@renderer/reader/tts/voices";
import { ttsController } from "@renderer/reader/tts/tts-controller";

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const AUTO_VALUE = "__auto__";
const PREVIEW_TEXT: Record<string, string> = {
  zh: "你好，这是朗读功能的试听。",
  en: "Hello, this is a read-aloud preview.",
};

function VoiceRow({ lang, label }: { lang: TtsLang; label: string }) {
  const { t } = useTranslation();
  const ttsPrefs = usePrefsStore((s) => s.ttsPrefs);
  const updateTtsPrefs = usePrefsStore((s) => s.updateTtsPrefs);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    let alive = true;
    void getVoicesReady().then((list) => {
      if (alive) setVoices(list);
    });
    return () => {
      alive = false;
    };
  }, []);
  const options = voices.filter(
    (v) => v.lang.toLowerCase().startsWith(lang) && !NOVELTY_BLOCKLIST.includes(v.name),
  );
  const selected = ttsPrefs.voiceByLang[lang] ?? AUTO_VALUE;
  const preview = () => {
    // 试听前停掉朗读会话——直接 cancel 会让引擎误推进
    ttsController.stop();
    const u = new SpeechSynthesisUtterance(PREVIEW_TEXT[lang]);
    // 与正文朗读同一条选声链（用户偏好→推荐表→兜底）——「自动」档若不显式设 voice，
    // utterance 会继承 <html lang>（UI 语言）、用中文 voice 读英文（spike 点名的坑）。
    const v = pickVoice(lang, voices, ttsPrefs, currentPlatform());
    if (v) u.voice = v;
    u.rate = ttsPrefs.rate;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  };
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-1">
        <Select
          value={selected}
          onValueChange={(val) => {
            if (val == null) return;
            const next = { ...ttsPrefs.voiceByLang };
            if (val === AUTO_VALUE) delete next[lang];
            else next[lang] = val;
            updateTtsPrefs({ voiceByLang: next });
          }}
        >
          <SelectTrigger className="w-44" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_VALUE}>
              {t("settings.tts.autoVoice", "自动（推荐）")}
            </SelectItem>
            {options.map((v) => (
              <SelectItem key={v.name} value={v.name}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("settings.tts.preview", "试听")}
          onClick={preview}
        >
          <Volume2 />
        </Button>
      </div>
    </div>
  );
}

export function ReadingSettings() {
  const { t } = useTranslation();
  const autoSummarize = usePrefsStore((s) => s.autoSummarize);
  const setAutoSummarize = usePrefsStore((s) => s.setAutoSummarize);
  const ttsPrefs = usePrefsStore((s) => s.ttsPrefs);
  const updateTtsPrefs = usePrefsStore((s) => s.updateTtsPrefs);
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.reading", "阅读")}</h2>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor="auto-summarize" className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium">
            {t("settings.reading.autoSummarize", "开章自动生成本章摘要")}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.reading.autoSummarizeDesc",
              "打开 / 切换章节时后台生成本章摘要，就绪后随提问一并提供给 AI（会产生模型调用）。关闭时可在 AI 面板的摘要 pill 里手动生成。",
            )}
          </span>
        </label>
        <Checkbox
          id="auto-summarize"
          checked={autoSummarize}
          onCheckedChange={setAutoSummarize}
          className="mt-0.5"
        />
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-medium">{t("settings.tts.title", "朗读")}</h3>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t("settings.tts.rate", "语速")}</span>
          <Select
            value={String(ttsPrefs.rate)}
            onValueChange={(val) => {
              if (val == null) return;
              updateTtsPrefs({ rate: Number(val) });
            }}
          >
            <SelectTrigger className="w-44" aria-label={t("settings.tts.rate", "语速")}>
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
        <VoiceRow lang="zh" label={t("settings.tts.voiceZh", "中文 voice")} />
        <VoiceRow lang="en" label={t("settings.tts.voiceEn", "英文 voice")} />
      </div>
    </section>
  );
}
