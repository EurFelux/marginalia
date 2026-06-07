import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { Button } from "@renderer/components/ui/button";

export function AdvancedSettings() {
  const { t } = useTranslation();
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.advanced", "高级")}</h2>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{t("settings.logs", "日志")}</span>
        <Button variant="outline" size="sm" onClick={() => void window.api.app.openLogsDir()}>
          <FolderOpen />
          {t("settings.openLogsFolder", "打开日志文件夹")}
        </Button>
      </div>
    </section>
  );
}
