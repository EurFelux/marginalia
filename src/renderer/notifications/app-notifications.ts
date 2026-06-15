import { useEffect } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AppNotification } from "@shared/chat";

/** 纯函数：把通知本地化成 toast 文案；无可展示内容返回 null。 */
export function notificationMessage(n: AppNotification, t: TFunction): string | null {
  switch (n.kind) {
    case "memoryConsolidated": {
      if (n.saved + n.updated + n.deleted <= 0) return null;
      return t("notify.memoryConsolidated", "Lia 整理了记忆 · 新增 {{saved}} · 更新 {{updated}}", {
        saved: n.saved,
        updated: n.updated,
      });
    }
    default:
      return null;
  }
}

/** 订阅 main→renderer 通知，本地化后弹轻 toast。App 挂载时调用一次。 */
export function useAppNotifications(): void {
  const { t } = useTranslation();
  useEffect(() => {
    if (typeof window === "undefined" || !window.api?.app?.onNotify) return;
    const unsub = window.api.app.onNotify((n) => {
      const msg = notificationMessage(n, t);
      if (msg) toast(msg);
    });
    return unsub;
  }, [t]);
}
