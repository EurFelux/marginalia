import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { createLogger } from "@renderer/logger";

const log = createLogger("update");

/**
 * 启动时静默查一次更新；有新版弹可跳转 toast，已最新/失败均静默（仅 log.warn）。useRef 守卫防 StrictMode 双跑。
 * dev 构建跳过：拿开发版比对已发布版本没有意义，且频繁重启会耗尽 GitHub 未认证限额（60 次/小时/IP，#116）。
 * 设置页的手动「检查更新」不受影响。
 */
export function useStartupUpdateCheck(): void {
  const { t } = useTranslation();
  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    if (import.meta.env.DEV) {
      log.debug("startup update check skipped in dev");
      return;
    }
    void (async () => {
      try {
        const res = await window.api.app.checkUpdate();
        if (res.status === "update-available") {
          toast(t("update.available", "发现新版本 {{version}}", { version: res.latestVersion }), {
            action: {
              label: t("update.view", "查看"),
              onClick: () => void window.api.app.openExternal({ url: res.releaseUrl }),
            },
            duration: Infinity,
            closeButton: true,
          });
        } else if (res.status === "error") {
          log.warn("startup update check returned error", res.message);
        }
      } catch (err) {
        log.warn("startup update check failed", err);
      }
    })();
  }, [t]);
}
