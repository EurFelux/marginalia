import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Download, FolderOpen, Upload } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Checkbox } from "@renderer/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { clampBackgroundConcurrency, clampStepLimit } from "@renderer/settings/settings-logic";
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";
import type { BackupInspection } from "@shared/backup";

export function AdvancedSettings() {
  const { t } = useTranslation();
  const stepLimit = usePrefsStore((s) => s.stepLimit);
  const setStepLimit = usePrefsStore((s) => s.setStepLimit);
  const backgroundConcurrency = usePrefsStore((s) => s.backgroundConcurrency);
  const setBackgroundConcurrency = usePrefsStore((s) => s.setBackgroundConcurrency);
  const unlimited = stepLimit === 0;
  const [busy, setBusy] = useState(false);
  // 已检视、待用户确认的还原目标；非 null 时打开确认弹窗。
  const [pendingRestore, setPendingRestore] = useState<BackupInspection | null>(null);

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [latestAvailable, setLatestAvailable] = useState<string | null>(null);

  useEffect(() => {
    void window.api.app.getInfo().then((info) => setAppVersion(info.version));
  }, []);

  const onCheckUpdate = async () => {
    setChecking(true);
    setLatestAvailable(null);
    try {
      const res = await window.api.app.checkUpdate();
      if (res.status === "update-available") {
        setLatestAvailable(res.latestVersion);
        toast(t("update.available", "发现新版本 {{version}}", { version: res.latestVersion }), {
          action: {
            label: t("update.view", "查看"),
            onClick: () => void window.api.app.openExternal({ url: res.releaseUrl }),
          },
          duration: Infinity,
          closeButton: true,
        });
      } else if (res.status === "up-to-date") {
        toast.success(t("update.upToDate", "已是最新版本"));
      } else {
        toast.error(t("update.checkFailed", "检查更新失败"));
      }
    } catch {
      toast.error(t("update.checkFailed", "检查更新失败"));
    } finally {
      setChecking(false);
    }
  };

  const onExport = async () => {
    setBusy(true);
    try {
      const res = await window.api.backup.export({ kind: "full" });
      if (res)
        toast.success(t("settings.backup.exportDone", "备份已导出：{{path}}", { path: res.path }));
    } catch {
      toast.error(t("settings.backup.exportFailed", "备份导出失败"));
    } finally {
      setBusy(false);
    }
  };

  // 选包并检视；兼容则打开确认弹窗，不兼容/读取失败弹 toast。
  const onPickRestore = async () => {
    setBusy(true);
    try {
      const ins = await window.api.backup.inspect();
      if (!ins) return; // 用户取消
      if (!ins.compatible) {
        toast.error(
          t("settings.backup.incompatible", "无法还原：备份来自更新版本（{{reason}}）", {
            reason: ins.reason ?? "",
          }),
        );
        return;
      }
      setPendingRestore(ins);
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : "";
      toast.error(msg || t("settings.backup.readFailed", "无法读取该备份"));
    } finally {
      setBusy(false);
    }
  };

  // 确认还原：成功后主进程 relaunch（正常不返回）；失败透传真实错误（含 pre-restore 恢复路径）。
  const onConfirmRestore = async () => {
    const ins = pendingRestore;
    setPendingRestore(null);
    if (!ins) return;
    setBusy(true);
    try {
      await window.api.backup.restore({ path: ins.path });
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : "";
      toast.error(msg || t("settings.backup.restoreFailed", "还原失败"), {
        closeButton: true,
        duration: Infinity,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
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

        <div className="flex items-start justify-between gap-3">
          <label htmlFor="background-concurrency" className="min-w-0 cursor-pointer">
            <span className="block text-sm font-medium">
              {t("settings.advanced.backgroundConcurrency", "后台任务并发上限")}
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
              {t(
                "settings.advanced.backgroundConcurrencyDesc",
                "同时进行的后台 AI 任务（章节/全书摘要、会话命名、长对话压缩）数量上限。调低可缓解额度/速率压力；不影响你正在进行的对话回复。",
              )}
            </span>
          </label>
          <Input
            id="background-concurrency"
            type="number"
            min={1}
            max={10}
            value={backgroundConcurrency}
            onChange={(e) =>
              setBackgroundConcurrency(clampBackgroundConcurrency(e.target.valueAsNumber))
            }
            className="w-16 shrink-0"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-sm font-medium">
              {t("settings.advanced.about", "关于")}
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
              {t("settings.advanced.currentVersion", "当前版本")} v{appVersion ?? "…"}
              {latestAvailable
                ? ` · ${t("update.available", "发现新版本 {{version}}", { version: latestAvailable })}`
                : ""}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={() => void onCheckUpdate()}
          >
            {t("settings.advanced.checkUpdate", "检查更新")}
          </Button>
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
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void onPickRestore()}
            >
              <Upload />
              {t("settings.backup.restore", "还原备份")}
            </Button>
          </div>
        </div>
      </section>

      <AlertDialog
        open={pendingRestore !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRestore(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t("settings.backup.restoreTitle", "还原备份？")}</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingRestore
              ? t(
                  "settings.backup.confirmRestore",
                  "将用此备份整体替换当前全部数据（{{count}} 本书，导出于 {{when}}）。替换前会自动保留一份当前数据的备份，随后应用将重启。",
                  {
                    count: pendingRestore.manifest.bookCount,
                    when: new Date(pendingRestore.manifest.createdAt).toLocaleString(),
                  },
                )
              : ""}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setPendingRestore(null)}>
              {t("settings.backup.cancel", "取消")}
            </Button>
            <Button variant="destructive" onClick={() => void onConfirmRestore()}>
              {t("settings.backup.restore", "还原备份")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
