import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { qk } from "@renderer/query/keys";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";

export function MemorySettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const memoryEnabled = usePrefsStore((s) => s.memoryEnabled);
  const setMemoryEnabled = usePrefsStore((s) => s.setMemoryEnabled);
  const memoryAutoConsolidate = usePrefsStore((s) => s.memoryAutoConsolidate);
  const setMemoryAutoConsolidate = usePrefsStore((s) => s.setMemoryAutoConsolidate);

  const memories = useQuery({
    queryKey: qk.memories,
    queryFn: () => window.api.memories.list(),
    // 记忆由 AI 工具在主进程后台写入（不经渲染层 mutation），全局 staleTime=∞ 会让
    // 面板停留在「上次打开时」的快照——例如开过设置后再聊天写入记忆，重开设置仍空。
    // staleTime:0 使每次打开记忆面板都重新拉取最新列表（参照 conversation-queries 同型处理）。
    staleTime: 0,
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editBody, setEditBody] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; title: string; description: string; body: string }) =>
      window.api.memories.update(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.memories });
      setEditingId(null);
    },
    onError: () => {
      toast.error(t("settings.memory.updateFailed", "记忆保存失败，请重试"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => window.api.memories.delete({ id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.memories });
      setDeleteTarget(null);
    },
    onError: () => {
      toast.error(t("settings.memory.deleteFailed", "记忆删除失败，请重试"));
    },
  });

  const startEdit = (mem: { id: string; title: string; description: string; body: string }) => {
    setEditingId(mem.id);
    setEditTitle(mem.title);
    setEditDescription(mem.description);
    setEditBody(mem.body);
    setExpandedId(mem.id);
  };

  const saveEdit = () => {
    if (!editingId) return;
    updateMutation.mutate({
      id: editingId,
      title: editTitle.trim(),
      description: editDescription.trim(),
      body: editBody.trim(),
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setExpandedId(null);
  };

  return (
    <>
      <section className="space-y-4">
        <h2 className="font-serif text-lg">{t("settings.memory", "记忆")}</h2>

        {/* 总开关 */}
        <div className="flex items-start justify-between gap-3">
          <label htmlFor="memory-enabled" className="min-w-0 cursor-pointer">
            <span className="block text-sm font-medium">
              {t("settings.memory.enabled", "启用 AI 记忆")}
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
              {t(
                "settings.memory.enabledDesc",
                "AI 会在对话中自动记录重要信息（偏好、阅读习惯、个人背景等），供后续对话参考。关闭后 AI 将不再写入新记忆，已有记忆仍保留。",
              )}
            </span>
          </label>
          <Checkbox
            id="memory-enabled"
            checked={memoryEnabled}
            onCheckedChange={setMemoryEnabled}
            className="mt-0.5"
          />
        </div>

        {/* 后台自动整理开关（受总开关约束） */}
        <div className="flex items-start justify-between gap-3">
          <label htmlFor="memory-auto-consolidate" className="min-w-0 cursor-pointer">
            <span className="block text-sm font-medium">
              {t("settings.memory.autoConsolidate", "后台自动整理记忆")}
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
              {t(
                "settings.memory.autoConsolidateDesc",
                "每隔几轮对话，Lia 会在后台补记漏掉的要点并整理已有记忆。会产生额外的模型调用，默认关闭。",
              )}
            </span>
          </label>
          <Checkbox
            id="memory-auto-consolidate"
            checked={memoryAutoConsolidate}
            onCheckedChange={setMemoryAutoConsolidate}
            disabled={!memoryEnabled}
            className="mt-0.5"
          />
        </div>

        {/* 记忆列表 */}
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t("settings.memory.list", "已记忆的内容")}</h3>

          {memories.isError && (
            <p className="text-sm text-destructive">
              {t("settings.memory.loadFailed", "记忆加载失败")}
            </p>
          )}

          {memories.data?.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t(
                "settings.memory.empty",
                "还没有记忆。记忆会在与 AI 的对话中自然积累——只需正常交流，AI 会自动记录有用的信息。",
              )}
            </p>
          )}

          {memories.data?.map((mem) => (
            <div key={mem.id} className="rounded-lg border border-border">
              {editingId === mem.id ? (
                /* 编辑态 */
                <div className="space-y-2 p-3">
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder={t("settings.memory.titlePlaceholder", "标题")}
                  />
                  <Input
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder={t("settings.memory.descPlaceholder", "简短描述")}
                  />
                  <Textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    placeholder={t("settings.memory.bodyPlaceholder", "记忆正文")}
                    className="min-h-24"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={cancelEdit}>
                      {t("settings.memory.cancel", "取消")}
                    </Button>
                    <Button
                      size="sm"
                      onClick={saveEdit}
                      disabled={
                        updateMutation.isPending ||
                        !editTitle.trim() ||
                        !editDescription.trim() ||
                        !editBody.trim()
                      }
                    >
                      {t("settings.memory.save", "保存")}
                    </Button>
                  </div>
                </div>
              ) : (
                /* 展示态 */
                <div>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
                      onClick={() => setExpandedId(expandedId === mem.id ? null : mem.id)}
                    >
                      {expandedId === mem.id ? (
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate text-sm font-medium">{mem.title}</span>
                      {mem.sourceBookTitle && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          · {mem.sourceBookTitle}
                        </span>
                      )}
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => startEdit(mem)}
                        aria-label={t("settings.memory.edit", "编辑")}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(mem.id)}
                        aria-label={t("settings.memory.delete", "删除")}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>

                  {expandedId === mem.id && (
                    <div className="border-t border-border px-3 pb-3 pt-2 space-y-1.5">
                      {mem.description && (
                        <p className="text-[11px] text-muted-foreground">{mem.description}</p>
                      )}
                      <p className="whitespace-pre-wrap text-sm">{mem.body}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {t("settings.memory.updatedAt", "更新于 {{when}}", {
                          when: new Date(mem.updatedAt).toLocaleString(),
                        })}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 删除确认 */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t("settings.memory.deleteTitle", "删除记忆？")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("settings.memory.deleteDesc", "此操作无法撤销，该条记忆将被永久删除。")}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("settings.memory.cancel", "取消")}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget);
              }}
            >
              {t("settings.memory.delete", "删除")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
