import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownEditor } from "@renderer/components/MarkdownEditor";
import { Button } from "@renderer/components/ui/button";

interface ReportEditorProps {
  initialContent: string;
  disabled: boolean;
  onSave: (content: string) => void;
  onCancel: () => void;
}

export function ReportEditor({ initialContent, disabled, onSave, onCancel }: ReportEditorProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState(initialContent);
  const trimmed = content.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        inert={disabled || undefined}
        className={disabled ? "pointer-events-none opacity-50" : undefined}
      >
        <MarkdownEditor
          defaultValue={initialContent}
          onChange={setContent}
          onSubmit={(value) => onSave(value.trim())}
          onCancel={onCancel}
          autoFocus
          className="min-h-80"
        />
      </div>
      <div className="flex items-center justify-end gap-2 font-sans">
        <Button variant="ghost" onClick={onCancel} disabled={disabled}>
          {t("common.cancel", "取消")}
        </Button>
        <Button onClick={() => onSave(trimmed)} disabled={disabled || !trimmed}>
          {t("common.save", "保存")}
        </Button>
      </div>
    </div>
  );
}
