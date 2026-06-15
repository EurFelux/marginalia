import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { createLogger } from "@renderer/logger";

const log = createLogger("update");

/** 启动时静默查一次更新；有新版弹可跳转 toast，已最新/失败均静默（仅 log.warn）。useRef 守卫防 StrictMode 双跑。 */
export function useStartupUpdateCheck(): void {
  const { t } = useTranslation();
  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
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
