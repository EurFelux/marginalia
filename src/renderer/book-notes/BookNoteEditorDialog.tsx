import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft } from "lucide-react";
import { Kbd, KbdGroup, ModKey } from "@renderer/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Textarea } from "@renderer/components/ui/textarea";
import { Button } from "@renderer/components/ui/button";

export type BookNoteEditorState =
  | { mode: "create" }
  | { mode: "edit"; noteId: string; initialContent: string };

/** 居中笔记编辑 Dialog（新建/编辑共用）；书库场景下叠在笔记列表 Dialog 之上（Base UI 支持嵌套）。 */
export function BookNoteEditorDialog({
  state,
  onSave,
  onClose,
}: {
  /** null = 关闭。每次打开传新对象（保证初始化 effect 重跑）。 */
  state: BookNoteEditorState | null;
  /** 保存回调；只会收到 trim 后非空的 content。edit 模式的 noteId 由调用方从 state 取。 */
  onSave: (content: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");

  // 打开时初始化文本 + 聚焦（state 每次打开均为新对象引用，effect 必重跑、文本必重置）。
  useEffect(() => {
    if (!state) return;
    setText(state.mode === "edit" ? state.initialContent : "");
    taRef.current?.focus();
  }, [state]);

  if (!state) return null;

  const save = () => {
    const content = text.trim();
    if (!content) return;
    onSave(content);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="font-sans sm:max-w-[36rem]">
        <DialogHeader>
          <DialogTitle>
            {state.mode === "edit"
              ? t("bookNotes.editTitle", "编辑笔记")
              : t("bookNotes.addTitle", "新建笔记")}
          </DialogTitle>
        </DialogHeader>
        <Textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Cmd(macOS)/Ctrl(Win/Linux)+Enter 保存
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder={t("bookNotes.placeholder", "写点对这本书的想法…")}
          className="no-scrollbar min-h-55 resize-none leading-relaxed"
        />
        <p className="text-xs text-muted-foreground">
          {t("bookNotes.markdownHint", "支持 Markdown，保存后渲染")}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel", "取消")}
          </Button>
          <Button onClick={save} disabled={text.trim() === ""}>
            {t("common.save", "保存")}
            <KbdGroup>
              <ModKey className="border-transparent bg-primary-foreground/20 text-primary-foreground" />
              <Kbd className="border-transparent bg-primary-foreground/20 text-primary-foreground">
                <CornerDownLeft className="size-3" />
              </Kbd>
            </KbdGroup>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
