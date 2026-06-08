import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";

/** user 消息就地编辑：textarea + 保存/取消。Enter 保存、Shift+Enter 换行、Esc 取消。 */
export function MessageEditor({
  initialText,
  busy,
  onSave,
  onCancel,
}: {
  initialText: string;
  busy: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // 挂载时聚焦并把光标置末尾（命令式，React Compiler 不接管 effect 清理/聚焦）。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const trimmed = text.trim();
  const canSave = trimmed.length > 0 && !busy;
  const save = () => {
    if (canSave) onSave(trimmed);
  };

  return (
    <div className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-background p-2">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={3}
        className="w-full resize-none bg-transparent text-sm leading-relaxed outline-none"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("ai.editCancel", "取消")}
        </Button>
        <Button size="sm" disabled={!canSave} onClick={save}>
          {t("ai.editSave", "发送")}
        </Button>
      </div>
    </div>
  );
}
