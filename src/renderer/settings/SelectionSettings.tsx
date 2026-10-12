// 「划词」设置页（spec 2026-10-12-custom-selection-actions-design §3.6）：工具栏显示文字开关 + 划词指令。
// 指令区左右分栏：左栏列表（拖拽排序、显示开关），右栏编辑区（改动自动保存，没有保存按钮）。
import { Fragment, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { TFunction } from "i18next";
import { cn } from "@renderer/lib/utils";
import { ipcErrorMessage } from "@renderer/lib/ipc-error";
import { qk } from "@renderer/query/keys";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import {
  builtinSelectionDefaults,
  useSelectionActionsQuery,
} from "@renderer/ai/use-selection-actions";
import { SELECTION_ACTION_ICON_COMPONENTS } from "@renderer/ai/selection-action-icons";
import { inlineCountFor, moreDividerAfter } from "@renderer/ai/selection-action-layout";
import {
  planAutosave,
  validateFields,
  type EditorFields,
  type FieldError,
} from "@renderer/settings/selection-action-autosave";
import {
  BUILTIN_SELECTION_ACTION_ICONS,
  FALLBACK_SELECTION_ACTION_ICON,
  SELECTION_ACTION_ICON_GROUPS,
  SELECTION_ACTION_LABEL_MAX,
  SELECTION_ACTION_MAX,
  SELECTION_ACTION_PROMPT_MAX,
  resolveSelectionAction,
  toSelectionActionIcon,
  type BuiltinSelectionDefaults,
  type SelectionActionDto,
  type SelectionActionIcon,
  type SelectionActionIconGroupId,
  type UpdateSelectionActionInput,
} from "@shared/selection-actions";

/** 文字、提示语停止输入多久后自动保存（ms）。 */
const AUTOSAVE_DELAY_MS = 500;

type Selected = { kind: "saved"; id: string } | { kind: "draft" };
/** 一次「添加指令」的编辑会话：新建成功后编辑区沿用同一个 key，不重挂（不打断正在输入）。 */
type DraftSession = { key: string; createdId: string | null };

function patchInput(
  dto: SelectionActionDto,
  patch: { enabled?: boolean },
): UpdateSelectionActionInput {
  return dto.kind === "builtin"
    ? { kind: "builtin", id: dto.id, patch }
    : { kind: "custom", id: dto.id, patch };
}

function applyPatch(
  dto: SelectionActionDto,
  input: UpdateSelectionActionInput,
): SelectionActionDto {
  if (dto.kind === "builtin" && input.kind === "builtin") return { ...dto, ...input.patch };
  if (dto.kind === "custom" && input.kind === "custom") return { ...dto, ...input.patch };
  return dto;
}

/** 列表缓存的读写与失败处理；增删改都先改缓存（工具栏立即看到），失败时提示并重取。 */
function useActionsCache() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const get = () => qc.getQueryData<SelectionActionDto[]>(qk.selectionActions) ?? [];
  const set = (fn: (list: SelectionActionDto[]) => SelectionActionDto[]) =>
    qc.setQueryData<SelectionActionDto[]>(qk.selectionActions, (old) => fn(old ?? []));
  const replace = (dto: SelectionActionDto) =>
    set((list) => list.map((a) => (a.id === dto.id ? dto : a)));
  const fail = (err: unknown) => {
    toast.error(
      t("settings.selection.saveFailed", "没能保存：{{message}}", {
        message: ipcErrorMessage(err),
      }),
    );
    void qc.invalidateQueries({ queryKey: qk.selectionActions });
  };
  return { get, set, replace, fail };
}

export function SelectionSettings() {
  const { t } = useTranslation();
  const showLabels = usePrefsStore((s) => s.selectionToolbarLabels);
  const setShowLabels = usePrefsStore((s) => s.setSelectionToolbarLabels);
  const inlineCount = inlineCountFor(showLabels);
  const cache = useActionsCache();
  const actions = useSelectionActionsQuery().data ?? [];
  const defaults = builtinSelectionDefaults(t);

  const [selected, setSelected] = useState<Selected | null>(null);
  const [draft, setDraft] = useState<DraftSession | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [deleting, setDeleting] = useState<SelectionActionDto | null>(null);
  const draftSeq = useRef(0);

  // 当前选中项：选中的已保存指令不在了（被删）就退回第一项。
  const current: Selected | null =
    selected?.kind === "draft" ||
    (selected?.kind === "saved" && actions.some((a) => a.id === selected.id))
      ? selected
      : actions[0]
        ? { kind: "saved", id: actions[0].id }
        : null;
  const currentDto =
    current?.kind === "saved" ? (actions.find((a) => a.id === current.id) ?? null) : null;
  const editorKey =
    draft && (current?.kind === "draft" || currentDto?.id === draft.createdId)
      ? draft.key
      : currentDto?.id;

  const select = (id: string) => {
    setSelected({ kind: "saved", id });
    setDraft(null);
  };
  const addDraft = () => {
    if (current?.kind === "draft") return;
    draftSeq.current += 1;
    setDraft({ key: `draft-${draftSeq.current}`, createdId: null });
    setDraftLabel("");
    setSelected({ kind: "draft" });
  };
  // 草稿新建成功：仍选中草稿时转为选中新指令（编辑区不重挂）；已离开则不打扰当前选择。
  const onCreated = (id: string) => {
    setDraft((d) => (d ? { ...d, createdId: id } : d));
    setSelected((s) => (s?.kind === "draft" ? { kind: "saved", id } : s));
  };

  const toggle = (dto: SelectionActionDto, enabled: boolean) => {
    cache.replace({ ...dto, enabled });
    window.api.selectionActions
      .update(patchInput(dto, { enabled }))
      .then(cache.replace)
      .catch(cache.fail);
  };

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const overId = e.over?.id;
    if (overId === undefined || e.active.id === overId) return;
    const from = actions.findIndex((a) => a.id === e.active.id);
    const to = actions.findIndex((a) => a.id === overId);
    if (from < 0 || to < 0) return;
    const next = arrayMove(actions, from, to);
    cache.set(() => next);
    window.api.selectionActions
      .reorder({ ids: next.map((a) => a.id) })
      .then((list) => cache.set(() => list))
      .catch(cache.fail);
  };

  const confirmDelete = () => {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    cache.set((list) => list.filter((a) => a.id !== target.id));
    setSelected(null);
    setDraft(null);
    window.api.selectionActions.delete({ id: target.id }).catch(cache.fail);
  };

  const dividerAfter = moreDividerAfter(actions, inlineCount);
  const full = actions.length >= SELECTION_ACTION_MAX;

  return (
    <>
      <section className="space-y-4">
        <h2 className="font-serif text-lg">{t("settings.selection", "划词")}</h2>

        <div className="flex items-start justify-between gap-3">
          <label htmlFor="selection-show-labels" className="min-w-0 cursor-pointer">
            <span className="block text-sm font-medium">
              {t("settings.selection.showLabels", "工具栏显示文字")}
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
              {t("settings.selection.showLabelsDesc", "关掉后只显示图标，鼠标悬停时显示文字。")}
            </span>
          </label>
          <Switch
            id="selection-show-labels"
            checked={showLabels}
            onCheckedChange={setShowLabels}
            className="mt-0.5"
          />
        </div>

        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">{t("settings.selection.actions", "划词指令")}</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {t(
                "settings.selection.actionsDesc",
                "选中文字后，工具栏上的 AI 指令。前 {{count}} 个直接显示，其余收进「更多」。",
                { count: inlineCount },
              )}
            </p>
          </div>

          <div className="flex h-[30rem] overflow-hidden rounded-lg border border-border">
            <div className="flex w-52 shrink-0 flex-col border-e border-border bg-muted/30">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={actions.map((a) => a.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ul className="min-h-0 flex-1 overflow-y-auto p-1">
                    {actions.map((dto, i) => (
                      <Fragment key={dto.id}>
                        <ActionRow
                          dto={dto}
                          defaults={defaults}
                          selected={current?.kind === "saved" && current.id === dto.id}
                          onSelect={() => select(dto.id)}
                          onToggle={(v) => toggle(dto, v)}
                        />
                        {i === dividerAfter && <MoreDivider />}
                      </Fragment>
                    ))}
                    {current?.kind === "draft" && <DraftRow label={draftLabel} />}
                  </ul>
                </SortableContext>
              </DndContext>
              <div className="space-y-1 border-t border-border p-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addDraft}
                  disabled={full}
                  className="w-full"
                >
                  <Plus />
                  {t("settings.selection.add", "添加指令")}
                </Button>
                {full && (
                  <p className="text-center text-[11px] text-muted-foreground">
                    {t("settings.selection.limit", "最多 {{count}} 个指令", {
                      count: SELECTION_ACTION_MAX,
                    })}
                  </p>
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              {editorKey !== undefined && (current?.kind === "draft" || currentDto) && (
                <ActionEditor
                  key={editorKey}
                  initial={currentDto}
                  defaults={defaults}
                  onCreated={onCreated}
                  onDraftLabel={setDraftLabel}
                  onDelete={() => currentDto && setDeleting(currentDto)}
                />
              )}
            </div>
          </div>
        </div>
      </section>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("settings.selection.deleteConfirm", "删除指令「{{label}}」？", {
              label: deleting?.kind === "custom" ? deleting.label : "",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("settings.selection.deleteConfirmDesc", "删除后不能恢复。")}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t("settings.selection.cancel", "取消")}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t("settings.selection.delete", "删除指令")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function MoreDivider() {
  const { t } = useTranslation();
  return (
    <li aria-hidden className="flex items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {t("settings.selection.moreDivider", "以下收进「更多」")}
      <span className="h-px flex-1 bg-border" />
    </li>
  );
}

function ActionRow({
  dto,
  defaults,
  selected,
  onSelect,
  onToggle,
}: {
  dto: SelectionActionDto;
  defaults: BuiltinSelectionDefaults;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: dto.id });
  const view = resolveSelectionAction(dto, defaults);
  const Icon = SELECTION_ACTION_ICON_COMPONENTS[view.icon];
  return (
    <li
      ref={setNodeRef}
      // transform/transition 是拖拽中的运行时计算值（内联 style 合规）。
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-1 rounded-md pe-1.5",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        isDragging && "relative z-10 bg-background shadow-md",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={t("settings.selection.dragHandle", "拖动排序")}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-accent active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 py-1.5 text-start",
          !dto.enabled && "opacity-45",
        )}
      >
        <Icon className={cn("size-3.5 shrink-0", dto.id === "ask" && "text-primary")} />
        <span className="truncate text-sm">{view.label}</span>
        {view.autoSend && <Send className="size-3 shrink-0 text-muted-foreground" />}
      </button>
      <Switch
        size="sm"
        checked={dto.enabled}
        onCheckedChange={onToggle}
        aria-label={t("settings.selection.show", "显示")}
      />
    </li>
  );
}

function DraftRow({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-1 rounded-md bg-accent py-1.5 ps-7 pe-1.5 text-accent-foreground">
      <span className={cn("truncate text-sm", !label.trim() && "text-muted-foreground italic")}>
        {label.trim() || t("settings.selection.untitled", "未命名")}
      </span>
    </li>
  );
}

function initialFields(dto: SelectionActionDto | null): EditorFields {
  if (!dto) {
    return { label: "", icon: FALLBACK_SELECTION_ACTION_ICON, prompt: "", autoSend: false };
  }
  if (dto.kind === "builtin") {
    return {
      label: "",
      icon: BUILTIN_SELECTION_ACTION_ICONS[dto.id],
      prompt: dto.prompt ?? "",
      autoSend: dto.autoSend,
    };
  }
  return {
    label: dto.label,
    icon: toSelectionActionIcon(dto.icon),
    prompt: dto.prompt,
    autoSend: dto.autoSend,
  };
}

/**
 * 编辑区：initial 为 null = 新建草稿。字段改动自动保存——开关与图标立即存；文字与提示语停止输入
 * AUTOSAVE_DELAY_MS 后存、失去焦点时也存。不合规的字段不写入（输入框标红），离开后回到已保存的值。
 */
function ActionEditor({
  initial,
  defaults,
  onCreated,
  onDraftLabel,
  onDelete,
}: {
  initial: SelectionActionDto | null;
  defaults: BuiltinSelectionDefaults;
  onCreated: (id: string) => void;
  onDraftLabel: (label: string) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const cache = useActionsCache();
  const [fields, setFields] = useState(() => initialFields(initial));
  const [touched, setTouched] = useState<{ label?: boolean; prompt?: boolean }>({});
  const fieldsRef = useRef(fields);
  const targetIdRef = useRef<string | null>(initial?.id ?? null);
  const creatingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const kind = initial?.kind ?? "custom";
  const builtinId = initial?.kind === "builtin" ? initial.id : null;
  const defaultPrompt = builtinId ? defaults.prompt(builtinId) : "";

  const flush = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const id = targetIdRef.current;
    if (id === null) {
      const req = planAutosave(
        { kind: "draft", creating: creatingRef.current },
        fieldsRef.current,
        "",
      );
      if (req?.kind !== "create") return;
      creatingRef.current = true;
      window.api.selectionActions
        .create(req.input)
        .then((dto) => {
          targetIdRef.current = dto.id;
          creatingRef.current = false;
          cache.set((list) => [...list, dto]);
          onCreated(dto.id);
          flush(); // 新建请求在路上时的改动，回来后补存
        })
        .catch((err: unknown) => {
          creatingRef.current = false;
          cache.fail(err);
        });
      return;
    }
    const saved = cache.get().find((a) => a.id === id);
    if (!saved) return; // 已被删除
    const req = planAutosave({ kind: "saved", dto: saved }, fieldsRef.current, defaultPrompt);
    if (req?.kind !== "update") return;
    cache.replace(applyPatch(saved, req.input));
    window.api.selectionActions.update(req.input).then(cache.replace).catch(cache.fail);
  };

  // 离开编辑区（换选中项、关设置）时把等待中的改动存掉。
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(
    () => () => {
      if (timerRef.current) flushRef.current();
    },
    [],
  );

  const change = (patch: Partial<EditorFields>, immediate: boolean) => {
    const next = { ...fieldsRef.current, ...patch };
    fieldsRef.current = next;
    setFields(next);
    if (patch.label !== undefined && targetIdRef.current === null) onDraftLabel(patch.label);
    if (immediate) {
      flush();
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, AUTOSAVE_DELAY_MS);
  };

  const errors = new Set<FieldError>(validateFields(kind, fields));
  const labelError = touched.label
    ? errors.has("labelEmpty")
      ? t("settings.selection.labelEmpty", "文字不能为空")
      : null
    : null;
  const promptError = touched.prompt
    ? errors.has("promptEmpty")
      ? t("settings.selection.promptEmpty", "提示语不能为空")
      : errors.has("promptTooLong")
        ? t("settings.selection.promptTooLong", "提示语最多 {{count}} 字", {
            count: SELECTION_ACTION_PROMPT_MAX,
          })
        : null
    : null;
  const labelLength = fields.label.trim().length;
  const hasPrompt = (fields.prompt.trim() || defaultPrompt.trim()) !== "";
  const BuiltinIcon = builtinId ? SELECTION_ACTION_ICON_COMPONENTS[fields.icon] : null;

  return (
    <div className="space-y-4">
      {builtinId && BuiltinIcon ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2">
          <BuiltinIcon className={cn("size-4", builtinId === "ask" && "text-primary")} />
          <span className="text-sm font-medium">{defaults.label(builtinId)}</span>
          <span className="ms-auto text-[11px] text-muted-foreground">
            {t("settings.selection.builtinHint", "内置指令，文字和图标不可改")}
          </span>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <IconPicker value={fields.icon} onChange={(icon) => change({ icon }, true)} />
            <div className="relative min-w-0 flex-1">
              <Input
                autoFocus={initial === null}
                value={fields.label}
                maxLength={SELECTION_ACTION_LABEL_MAX}
                aria-label={t("settings.selection.label", "文字")}
                aria-invalid={labelError !== null || labelLength > SELECTION_ACTION_LABEL_MAX}
                placeholder={t("settings.selection.labelPlaceholder", "比如：找反驳")}
                onChange={(e) => {
                  setTouched((s) => ({ ...s, label: true }));
                  change({ label: e.target.value }, false);
                }}
                onBlur={flush}
                className="pe-12"
              />
              <span
                className={cn(
                  "pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-[11px] tabular-nums",
                  labelLength > SELECTION_ACTION_LABEL_MAX
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {labelLength}/{SELECTION_ACTION_LABEL_MAX}
              </span>
            </div>
          </div>
          {labelError && <p className="ps-10 text-[11px] text-destructive">{labelError}</p>}
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="selection-action-prompt" className="block text-sm font-medium">
          {t("settings.selection.prompt", "提示语")}
        </label>
        <Textarea
          id="selection-action-prompt"
          value={fields.prompt}
          rows={4}
          maxLength={SELECTION_ACTION_PROMPT_MAX}
          aria-invalid={promptError !== null}
          placeholder={
            builtinId === "ask"
              ? t("settings.selection.askPlaceholder", "留空：只附上选中的文字，由你自己提问")
              : builtinId
                ? defaultPrompt
                : t("settings.selection.promptPlaceholder", "比如：这段话的观点有哪些可能的反驳？")
          }
          onChange={(e) => {
            setTouched((s) => ({ ...s, prompt: true }));
            change({ prompt: e.target.value }, false);
          }}
          onBlur={flush}
          className="max-h-48"
        />
        {promptError && <p className="text-[11px] text-destructive">{promptError}</p>}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {builtinId && `${t("settings.selection.promptDefaultDesc", "留空则使用默认提示语。")} `}
          {t(
            "settings.selection.promptDesc",
            "选中的文字会作为上下文附在消息上，提示语里不用再写。",
          )}
        </p>
      </div>

      <div className="flex items-start justify-between gap-3">
        <label
          htmlFor="selection-action-auto-send"
          className={cn("min-w-0", hasPrompt ? "cursor-pointer" : "cursor-not-allowed")}
        >
          <span className={cn("block text-sm font-medium", !hasPrompt && "opacity-50")}>
            {t("settings.selection.autoSend", "直接发送")}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            {hasPrompt
              ? t("settings.selection.autoSendDesc", "点了就发给 AI，不再填进输入框等你补充。")
              : t(
                  "settings.selection.autoSendNeedsPrompt",
                  "要先写提示语才能开启：没有提示语，就没有可以直接发出去的内容。",
                )}
          </span>
        </label>
        <Switch
          id="selection-action-auto-send"
          checked={fields.autoSend && hasPrompt}
          disabled={!hasPrompt}
          onCheckedChange={(autoSend) => change({ autoSend }, true)}
          className="mt-0.5"
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-[11px] text-muted-foreground">
          {t("settings.selection.autosave", "改动会自动保存")}
        </span>
        {initial?.kind === "custom" && (
          <Button variant="ghost" size="sm" onClick={onDelete} className="text-destructive">
            <Trash2 />
            {t("settings.selection.delete", "删除指令")}
          </Button>
        )}
      </div>
    </div>
  );
}

function iconGroupLabel(t: TFunction, id: SelectionActionIconGroupId): string {
  switch (id) {
    case "reading":
      return t("settings.selection.iconGroup.reading", "阅读与语言");
    case "thinking":
      return t("settings.selection.iconGroup.thinking", "思考与提问");
    case "structure":
      return t("settings.selection.iconGroup.structure", "结构与比较");
    case "topics":
      return t("settings.selection.iconGroup.topics", "学科与主题");
    case "other":
      return t("settings.selection.iconGroup.other", "其他");
  }
}

/** 图标按钮：显示当前图标，点一下弹出分组网格；点选后收起（spec §3.6）。 */
function IconPicker({
  value,
  onChange,
}: {
  value: SelectionActionIcon;
  onChange: (icon: SelectionActionIcon) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const Current = SELECTION_ACTION_ICON_COMPONENTS[value];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="icon" aria-label={t("settings.selection.icon", "图标")}>
            <Current />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-80">
        {SELECTION_ACTION_ICON_GROUPS.map((group) => (
          <div key={group.id}>
            <div className="mb-1 text-[11px] text-muted-foreground">
              {iconGroupLabel(t, group.id)}
            </div>
            <div className="flex flex-wrap gap-0.5">
              {group.icons.map((name) => {
                const Icon = SELECTION_ACTION_ICON_COMPONENTS[name];
                return (
                  <button
                    key={name}
                    type="button"
                    aria-label={name}
                    aria-pressed={value === name}
                    onClick={() => {
                      onChange(name);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md hover:bg-accent",
                      value === name && "bg-primary text-primary-foreground hover:bg-primary",
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
