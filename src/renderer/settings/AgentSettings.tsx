import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AssistantAvatar } from "@renderer/ai/AssistantAvatar";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { usePrefsStore } from "@renderer/store/prefs-store";

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
  const showAgentAvatar = usePrefsStore((s) => s.showAgentAvatar);
  const setShowAgentAvatar = usePrefsStore((s) => s.setShowAgentAvatar);
  const setAvatarBlobId = usePrefsStore((s) => s.setAvatarBlobId);

  const onPickAvatar = async () => {
    const r = await window.api.agent.pickAvatar();
    if (r.status === "set") setAvatarBlobId(r.blobId);
    else if (r.status === "too-large")
      toast.error(t("settings.agent.avatarTooLarge", "图片太大，请选择 2 MB 以内的图片"));
    else if (r.status === "unsupported")
      toast.error(t("settings.agent.avatarUnsupported", "不支持的图片格式"));
  };

  const onResetAvatar = async () => {
    await window.api.agent.resetAvatar();
    setAvatarBlobId(null);
  };

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

      {/* 头像 */}
      <div className="space-y-1.5">
        <span className="block text-sm font-medium">{t("settings.agent.avatar", "头像")}</span>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "settings.agent.avatarDesc",
            "显示在对话中的 AI 头像。支持 png/jpg/webp/gif，2 MB 以内。",
          )}
        </p>
        <div className="flex items-center gap-3">
          <AssistantAvatar className="size-14" />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onPickAvatar}>
              {t("settings.agent.avatarUpload", "上传头像")}
            </Button>
            <Button variant="ghost" size="sm" onClick={onResetAvatar}>
              {t("settings.agent.avatarReset", "恢复默认")}
            </Button>
          </div>
        </div>
        <label className="mt-1 flex items-center gap-2 text-sm">
          <Checkbox
            checked={showAgentAvatar}
            onCheckedChange={(v) => setShowAgentAvatar(v === true)}
          />
          {t("settings.agent.avatarShowInChat", "在对话中显示头像")}
        </label>
      </div>

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
