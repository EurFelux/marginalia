import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft } from "lucide-react";
import { Kbd, KbdGroup, ModKey } from "@renderer/components/ui/kbd";
import { Textarea } from "@renderer/components/ui/textarea";
import { Button } from "@renderer/components/ui/button";

export type BookNoteEditorState =
  | { mode: "create" }
  | { mode: "edit"; noteId: string; initialContent: string };

/**
 * 全高内嵌笔记编辑器：占满 BookNotesPanel 整区（替代列表视图），与 AI 面板同级并存
 * ——写笔记时可同时查看/复制对话内容（曾是居中 Dialog，模态遮罩挡 AI 面板故弃用）。
 * 由调用方按 state != null 条件挂载；每次进入编辑态都是全新挂载，初值经 useState 初始化即可。
 */
export function BookNoteEditor({
  state,
  onSave,
  onClose,
}: {
  state: BookNoteEditorState;
  /** 保存回调；只会收到 trim 后非空的 content。edit 模式的 noteId 由调用方从 state 取。 */
  onSave: (content: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(state.mode === "edit" ? state.initialContent : "");

  const save = () => {
    const content = text.trim();
    if (!content) return;
    onSave(content);
    onClose();
  };

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <h3 className="shrink-0 px-1 text-sm font-semibold">
        {state.mode === "edit"
          ? t("bookNotes.editTitle", "编辑笔记")
          : t("bookNotes.addTitle", "新建笔记")}
      </h3>
      <Textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Cmd(macOS)/Ctrl(Win/Linux)+Enter 保存；Esc 取消（镜像原 Dialog 的关闭语义）
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={t("bookNotes.placeholder", "写点对这本书的想法…")}
        className="no-scrollbar min-h-0 flex-1 resize-none leading-relaxed"
      />
      <p className="shrink-0 px-1 text-xs text-muted-foreground">
        {t("bookNotes.markdownHint", "支持 Markdown，保存后渲染")}
      </p>
      <div className="flex shrink-0 justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("common.cancel", "取消")}
        </Button>
        <Button size="sm" onClick={save} disabled={text.trim() === ""}>
          {t("common.save", "保存")}
          <KbdGroup>
            <ModKey className="border-transparent bg-primary-foreground/20 text-primary-foreground" />
            <Kbd className="border-transparent bg-primary-foreground/20 text-primary-foreground">
              <CornerDownLeft className="size-3" />
            </Kbd>
          </KbdGroup>
        </Button>
      </div>
    </div>
  );
}
