import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";

/**
 * 助手设置：SOUL（name + persona）+ 全局 instructions。
 * 文本输入提交模式：onBlur 时提交，空值回退原值（镜像既有设置组件的 Input 模式）。
 */
export function AgentSettings() {
  const { t } = useTranslation();
  const soul = usePrefsStore((s) => s.soul);
  const setSoul = usePrefsStore((s) => s.setSoul);
  const instructions = usePrefsStore((s) => s.instructions);
  const setInstructions = usePrefsStore((s) => s.setInstructions);

  const [draftName, setDraftName] = useState<string | null>(null);
  const [draftPersona, setDraftPersona] = useState<string | null>(null);
  const [draftInstructions, setDraftInstructions] = useState<string | null>(null);

  const commitName = () => {
    if (draftName === null) return;
    const trimmed = draftName.trim();
    if (trimmed) {
      setSoul({ ...soul, name: trimmed });
    }
    setDraftName(null);
  };

  const commitPersona = () => {
    if (draftPersona === null) return;
    setSoul({ ...soul, persona: draftPersona });
    setDraftPersona(null);
  };

  const commitInstructions = () => {
    if (draftInstructions === null) return;
    setInstructions(draftInstructions);
    setDraftInstructions(null);
  };

  return (
    <section className="space-y-5">
      <h2 className="font-serif text-lg">{t("settings.agent", "助手")}</h2>

      {/* 名字 */}
      <div className="space-y-1.5">
        <label htmlFor="agent-name" className="block text-sm font-medium">
          {t("settings.agent.name", "助手名字")}
        </label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("settings.agent.nameDesc", "AI 的称呼，显示在对话界面。不允许为空。")}
        </p>
        <Input
          id="agent-name"
          value={draftName ?? soul.name}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitName}
          placeholder={t("settings.agent.namePlaceholder", "输入助手名字")}
          className="max-w-xs"
        />
      </div>

      {/* 人设 persona */}
      <div className="space-y-1.5">
        <label htmlFor="agent-persona" className="block text-sm font-medium">
          {t("settings.agent.persona", "人设")}
        </label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("settings.agent.personaDesc", "描述 AI 的性格与说话风格。用 markdown 自由书写。")}
        </p>
        <Textarea
          id="agent-persona"
          value={draftPersona ?? soul.persona}
          onChange={(e) => setDraftPersona(e.target.value)}
          onBlur={commitPersona}
          placeholder={t("settings.agent.personaPlaceholder", "描述助手的性格与风格……")}
          className="min-h-28"
        />
      </div>

      {/* 全局指令 instructions */}
      <div className="space-y-1.5">
        <label htmlFor="agent-instructions" className="block text-sm font-medium">
          {t("settings.agent.instructions", "全局指令")}
        </label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "settings.agent.instructionsDesc",
            "叠加在人设之上的额外行为要求，例如「回复时始终引用原文」、「优先用中文」等。每次对话都会生效。",
          )}
        </p>
        <Textarea
          id="agent-instructions"
          value={draftInstructions ?? instructions}
          onChange={(e) => setDraftInstructions(e.target.value)}
          onBlur={commitInstructions}
          placeholder={t("settings.agent.instructionsPlaceholder", "输入全局指令……")}
          className="min-h-28"
        />
      </div>
    </section>
  );
}
