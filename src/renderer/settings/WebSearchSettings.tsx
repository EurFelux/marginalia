// 「联网搜索」设置页（spec 2026-10-17-deepseek-web-backend-design §7.1）：左右分栏。
// 左栏：引擎列表（拖拽排序 = 失败时的回退顺序、启用开关），右栏：选中引擎的说明、能力与 key 配置。
// 开关与排序即改即存；Exa key 保留「保存」按钮。
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { AlertTriangle, ArrowRight, Check, GripVertical } from "lucide-react";
import type { TFunction } from "i18next";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Switch } from "@renderer/components/ui/switch";
import { isDeepseekProvider } from "@shared/providers";
import {
  DEFAULT_WEB_SEARCH,
  applyPresetBackendList,
  backendDisplayName,
  backendSupportsFetch,
  presetBackendList,
  type PresetBackendConfig,
} from "@shared/web-search";

type PresetKind = PresetBackendConfig["kind"];

/** 引擎在已启用列表里的角色：首选 / 备用 n / 未启用。 */
function roleLabel(list: PresetBackendConfig[], b: PresetBackendConfig, t: TFunction): string {
  if (b.enabled === false) return t("settings.webSearch.roleOff", "未启用");
  const index = list.filter((x) => x.enabled !== false).indexOf(b);
  return index === 0
    ? t("settings.webSearch.rolePrimary", "首选")
    : t("settings.webSearch.roleFallback", "备用 {{index}}", { index });
}

export function WebSearchSettings() {
  const { t } = useTranslation();
  const webSearch = usePrefsStore((s) => s.webSearch);
  const setWebSearch = usePrefsStore((s) => s.setWebSearch);
  const cfg = webSearch ?? DEFAULT_WEB_SEARCH;
  const list = presetBackendList(cfg);
  const [selectedKind, setSelectedKind] = useState<PresetKind>(list[0].kind);
  const selected = list.find((b) => b.kind === selectedKind) ?? list[0];

  // 内置 DeepSeek 的 key 状态（keyMask=null 即未配置）；查询未返回前为 undefined，不提前报警。
  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: () => window.api.settings.providers.list(),
  });
  const deepseekKeySet = providers.data
    ? Boolean(providers.data.find(isDeepseekProvider)?.keyMask)
    : undefined;

  const save = (next: PresetBackendConfig[]) => setWebSearch(applyPresetBackendList(cfg, next));
  const toggle = (kind: PresetKind, enabled: boolean) =>
    save(list.map((b) => (b.kind === kind ? { ...b, enabled } : b)));
  const saveExaKey = (apiKey: string) =>
    save(
      list.map((b) => {
        if (b.kind !== "exa-mcp") return b;
        const next: PresetBackendConfig = { ...b, apiKey };
        if (!apiKey) delete next.apiKey; // 留空 = 用免费层
        return next;
      }),
    );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = list.findIndex((b) => b.kind === active.id);
    const to = list.findIndex((b) => b.kind === over.id);
    if (from < 0 || to < 0) return;
    save(arrayMove(list, from, to));
  };

  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.webSearch", "联网搜索")}</h2>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t(
          "settings.webSearch.description",
          "AI 联网时按顺序尝试搜索引擎，前一个失败就自动改用下一个。每条消息是否联网，用 AI 面板的「联网」按钮控制。拖动左侧列表调整顺序。",
        )}
      </p>

      <div className="flex min-h-72 overflow-hidden rounded-lg border border-border">
        <div className="w-52 shrink-0 border-e border-border bg-muted/30">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={list.map((b) => b.kind)} strategy={verticalListSortingStrategy}>
              <ul className="p-1">
                {list.map((b) => (
                  <EngineRow
                    key={b.kind}
                    backend={b}
                    role={roleLabel(list, b, t)}
                    selected={b.kind === selected.kind}
                    keyMissing={b.kind === "deepseek" && deepseekKeySet === false}
                    onSelect={() => setSelectedKind(b.kind)}
                    onToggle={(v) => toggle(b.kind, v)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </div>

        <div className="min-w-0 flex-1 p-4">
          <EngineDetail
            key={selected.kind}
            backend={selected}
            role={roleLabel(list, selected, t)}
            deepseekKeySet={deepseekKeySet}
            onSaveExaKey={saveExaKey}
          />
        </div>
      </div>
    </section>
  );
}

function EngineRow({
  backend,
  role,
  selected,
  keyMissing,
  onSelect,
  onToggle,
}: {
  backend: PresetBackendConfig;
  role: string;
  selected: boolean;
  keyMissing: boolean;
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
  } = useSortable({ id: backend.kind });
  const enabled = backend.enabled !== false;
  const name = backendDisplayName(backend);
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
        aria-label={t("settings.webSearch.dragHandle", "拖动排序")}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-accent active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onSelect}
        className={cn("flex min-w-0 flex-1 flex-col py-1.5 text-start", !enabled && "opacity-45")}
      >
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm">{name}</span>
          {keyMissing && (
            <AlertTriangle
              className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
              aria-label={t("settings.webSearch.keyMissingShort", "未配置 API Key")}
            />
          )}
        </span>
        <span className="text-[10px] text-muted-foreground">{role}</span>
      </button>
      <Switch
        size="sm"
        checked={enabled}
        // 未配 key 的 DeepSeek 不让打开（注定失败）；已打开的始终可以关掉。
        disabled={keyMissing && !enabled}
        onCheckedChange={onToggle}
        aria-label={t("settings.webSearch.enable", "启用 {{name}}", { name })}
      />
    </li>
  );
}

function EngineDetail({
  backend,
  role,
  deepseekKeySet,
  onSaveExaKey,
}: {
  backend: PresetBackendConfig;
  role: string;
  deepseekKeySet: boolean | undefined;
  onSaveExaKey: (apiKey: string) => void;
}) {
  const { t } = useTranslation();
  const enabled = backend.enabled !== false;
  const caps = [
    t("settings.webSearch.capSearch", "搜索"),
    ...(backendSupportsFetch(backend) ? [t("settings.webSearch.capFetch", "读取网页")] : []),
  ];
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-base font-medium">{backendDisplayName(backend)}</h3>
          <span
            className={cn(
              "rounded-full px-1.5 py-px text-[10px] leading-4",
              enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
            )}
          >
            {role}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {backend.kind === "exa-mcp"
            ? t(
                "settings.webSearch.exaDesc",
                "免费层无需 API Key 即可使用；填入 Key 可提升速率限制与结果质量。",
              )
            : t(
                "settings.webSearch.deepseekDesc",
                "使用「模型」设置中 DeepSeek 的 API Key，按次计费。",
              )}
        </p>
      </div>

      <div className="space-y-1">
        <span className="block text-xs text-muted-foreground">
          {t("settings.webSearch.capabilities", "能力")}
        </span>
        <span className="flex items-center gap-1">
          {caps.map((c) => (
            <span
              key={c}
              className="rounded bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground"
            >
              {c}
            </span>
          ))}
        </span>
        {backendSupportsFetch(backend) && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.webSearch.fetchNote",
              "启用后 AI 还能读取网页全文，读取的内容会被标记为不可信，防止网页里的指令误导 AI。",
            )}
          </p>
        )}
      </div>

      {backend.kind === "exa-mcp" ? (
        <ExaKeyField initial={backend.apiKey ?? ""} onSave={onSaveExaKey} />
      ) : (
        <DeepseekKeyStatus keySet={deepseekKeySet} />
      )}
    </div>
  );
}

function ExaKeyField({ initial, onSave }: { initial: string; onSave: (apiKey: string) => void }) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState(initial);
  return (
    <div className="space-y-1">
      <label htmlFor="ws-exa-key" className="block text-xs text-muted-foreground">
        {t("settings.webSearch.apiKey", "API Key")}
        <span className="ml-1 text-muted-foreground/60">
          {t("settings.webSearch.apiKeyOptional", "（可选）")}
        </span>
      </label>
      <div className="flex items-center gap-2">
        <Input
          id="ws-exa-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("settings.webSearch.apiKeyPlaceholder", "exa-…（留空即用免费层）")}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => onSave(apiKey.trim())}>
          {t("common.save", "保存")}
        </Button>
      </div>
    </div>
  );
}

function DeepseekKeyStatus({ keySet }: { keySet: boolean | undefined }) {
  const { t } = useTranslation();
  const goToModels = () => useSettingsStore.getState().setActiveCategory("models");
  if (keySet === undefined) return null;
  return (
    <div className="space-y-1">
      <span className="block text-xs text-muted-foreground">
        {t("settings.webSearch.apiKey", "API Key")}
      </span>
      {keySet ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          {t("settings.webSearch.deepseekKeySet", "已使用「模型」设置中 DeepSeek 的 API Key")}
          <button type="button" onClick={goToModels} className="text-primary hover:underline">
            {t("settings.webSearch.manageKey", "管理")}
          </button>
        </p>
      ) : (
        <div className="flex items-center gap-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {t(
              "settings.webSearch.deepseekKeyMissing",
              "尚未在「模型」设置中配置 DeepSeek 的 API Key，配置后才能启用。",
            )}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={goToModels} className="h-6 px-2">
            {t("settings.webSearch.goConfigure", "前往配置")}
            <ArrowRight />
          </Button>
        </div>
      )}
    </div>
  );
}
