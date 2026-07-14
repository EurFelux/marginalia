import { Archive, ChevronDown, Download } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { BackupKind } from "@shared/backup";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";

interface Props {
  disabled: boolean;
  onExport: (kind: BackupKind) => void;
}

export function BackupExportButton({ disabled, onExport }: Props) {
  const { t } = useTranslation();

  return (
    <div className="inline-flex">
      <Button
        data-slot="backup-export-compact"
        variant="outline"
        size="sm"
        className="rounded-r-none border-r-0"
        disabled={disabled}
        onClick={() => onExport("compact")}
      >
        <Download data-icon="inline-start" />
        {t("settings.backup.exportCompact", "导出精简备份")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-slot="backup-export-menu"
          render={
            <Button
              variant="outline"
              size="icon-sm"
              className="rounded-l-none px-1.5"
              disabled={disabled}
              aria-label={t("settings.backup.exportOptions", "选择备份类型")}
            />
          }
        >
          <ChevronDown data-icon="inline-start" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem data-slot="backup-export-full" onClick={() => onExport("full")}>
              <Archive />
              <span>
                <span className="block font-medium">
                  {t("settings.backup.exportFull", "导出完整备份")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("settings.backup.exportFullDesc", "包含所有 EPUB / PDF 原文件")}
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
