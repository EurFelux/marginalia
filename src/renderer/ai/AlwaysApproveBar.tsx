// 「总是批准」开着时输入框正上方的常驻横条（spec 2026-10-03-bash-skills-permissions-design §5.5）。
// 视觉照原型（proto/approval-ui 分支 reference/C-*-10-always-approve-badge.png）。点击即关闭，无需确认。
import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePrefsStore } from "@renderer/store/prefs-store";

export function AlwaysApproveBar() {
  const { t } = useTranslation();
  const bashEnabled = usePrefsStore((s) => s.bashEnabled);
  const alwaysApprove = usePrefsStore((s) => s.bashAlwaysApprove);
  const setAlwaysApprove = usePrefsStore((s) => s.setBashAlwaysApprove);
  if (!bashEnabled || !alwaysApprove) return null;
  return (
    <button
      type="button"
      onClick={() => setAlwaysApprove(false)}
      className="flex shrink-0 items-center gap-1.5 border-t border-border bg-amber-500/10 px-3 py-1 text-start text-[11px] text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
    >
      <Zap className="size-3" />
      <span>{t("ai.bash.alwaysApproveOn", "命令自动批准中")}</span>
      <span className="ms-auto text-muted-foreground">
        {t("ai.bash.clickToTurnOff", "点击关闭")}
      </span>
    </button>
  );
}
