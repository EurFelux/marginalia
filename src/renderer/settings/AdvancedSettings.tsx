import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FolderOpen, Upload } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { clampStepLimit } from "@renderer/settings/settings-logic";
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";

export function AdvancedSettings() {
  const { t } = useTranslation();
  const stepLimit = usePrefsStore((s) => s.stepLimit);
  const setStepLimit = usePrefsStore((s) => s.setStepLimit);
  const unlimited = stepLimit === 0;
  const [busy, setBusy] = useState(false);

  const onExport = async () => {
    setBusy(true);
    try {
      const res = await window.api.backup.export();
      if (res)
        window.alert(t("settings.backup.exportDone", "备份已导出：{{path}}", { path: res.path }));
    } catch {
      window.alert(t("settings.backup.exportFailed", "备份导出失败"));
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async () => {
    setBusy(true);
    try {
      const ins = await window.api.backup.inspect();
      if (!ins) return; // 用户取消
      if (!ins.compatible) {
        window.alert(
          t("settings.backup.incompatible", "无法还原：备份来自更新版本（{{reason}}）", {
            reason: ins.reason ?? "",
          }),
        );
        return;
      }
      const when = new Date(ins.manifest.createdAt).toLocaleString();
      const ok = window.confirm(
        t(
          "settings.backup.confirmRestore",
          "将用此备份整体替换当前全部数据（{{count}} 本书，导出于 {{when}}）。当前数据会先存入 pre-restore 副本，随后应用将重启。继续？",
          { count: ins.manifest.bookCount, when },
        ),
      );
      if (!ok) return;
      await window.api.backup.restore({ path: ins.path });
      // 成功后主进程 relaunch，正常不会执行到这里。
    } catch {
      window.alert(t("settings.backup.restoreFailed", "还原失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.advanced", "高级")}</h2>

      <div className="flex items-start justify-between gap-3">
        <label htmlFor="step-limit" className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium">
            {t("settings.advanced.stepLimit", "单次回复最多步数")}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.advanced.stepLimitDesc",
              "AI 单次回复中连续调用工具的步数上限，阅读 PDF 逐页时需要调高。勾选「不限制」后仅靠模型自然停止与手动停止收尾——模型若陷入循环会持续消耗额度。",
            )}
          </span>
        </label>
        <div className="flex shrink-0 items-center gap-3">
          <Input
            id="step-limit"
            type="number"
            min={1}
            max={99}
            value={unlimited ? "" : stepLimit}
            disabled={unlimited}
            onChange={(e) => setStepLimit(clampStepLimit(e.target.valueAsNumber))}
            className="w-16"
          />
          <label
            htmlFor="step-limit-unlimited"
            className="flex cursor-pointer items-center gap-1.5"
          >
            <Checkbox
              id="step-limit-unlimited"
              checked={unlimited}
              onCheckedChange={(checked) => setStepLimit(checked ? 0 : DEFAULT_STEP_LIMIT)}
            />
            <span className="text-sm">{t("settings.advanced.stepLimitUnlimited", "不限制")}</span>
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{t("settings.logs", "日志")}</span>
        <Button variant="outline" size="sm" onClick={() => void window.api.app.openLogsDir()}>
          <FolderOpen />
          {t("settings.openLogsFolder", "打开日志文件夹")}
        </Button>
      </div>

      <div className="space-y-2">
        <span className="text-sm font-medium">{t("settings.backup.title", "备份与还原")}</span>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "settings.backup.warning",
            "备份包含全部书籍、标注、进度、会话与设置；其中 API key 以明文随包导出，请妥善保管。",
          )}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void onExport()}>
            <Download />
            {t("settings.backup.export", "导出备份")}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void onRestore()}>
            <Upload />
            {t("settings.backup.restore", "还原备份")}
          </Button>
        </div>
      </div>
    </section>
  );
}
