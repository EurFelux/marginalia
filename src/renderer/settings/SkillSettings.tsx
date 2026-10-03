// 「技能」设置页（spec 2026-10-03-bash-skills-permissions-design §7、§8）：已安装列表 + 从其他位置导入。
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { qk } from "@renderer/query/keys";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { ipcErrorMessage } from "@renderer/lib/ipc-error";
import { cn } from "@renderer/lib/utils";
import { formatList } from "@renderer/lib/list-format";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Switch } from "@renderer/components/ui/switch";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_IMPORT_ROOTS,
  SKILL_MAX_BYTES,
  SKILL_NAME_MAX,
} from "@shared/skills";
import type {
  SkillDto,
  SkillErrorCode,
  SkillImportCandidate,
  SkillImportFailure,
  SkillImportResult,
  SkillImportStatus,
} from "@shared/skills";

function errorLabel(code: SkillErrorCode, t: TFunction): string {
  switch (code) {
    case "missingSkillMd":
      return t("settings.skills.error.missingSkillMd", "文件夹里没有 SKILL.md");
    case "unreadable":
      return t("settings.skills.error.unreadable", "SKILL.md 读不出来");
    case "missingFrontmatter":
      return t("settings.skills.error.missingFrontmatter", "SKILL.md 开头缺少 --- 包住的属性区");
    case "badYaml":
      return t("settings.skills.error.badYaml", "属性区不是合法的 YAML");
    case "missingName":
      return t("settings.skills.error.missingName", "缺少 name");
    case "badName":
      return t(
        "settings.skills.error.badName",
        "name 只能用小写字母、数字和连字符，最长 {{max}} 个字符",
        { max: SKILL_NAME_MAX },
      );
    case "missingDescription":
      return t("settings.skills.error.missingDescription", "缺少 description");
    case "descriptionTooLong":
      return t("settings.skills.error.descriptionTooLong", "description 超过 {{max}} 个字符", {
        max: SKILL_DESCRIPTION_MAX,
      });
    case "nameMismatch":
      return t("settings.skills.error.nameMismatch", "文件夹名和 name 不一致");
  }
}

function failureLabel(reason: SkillImportFailure, t: TFunction): string {
  switch (reason) {
    case "notFound":
      return t("settings.skills.failure.notFound", "原位置找不到了，请重新扫描");
    case "invalid":
      return t("settings.skills.failure.invalid", "格式无效");
    case "manualOnly":
      return t("settings.skills.failure.manualOnly", "需要手动调用，暂不支持");
    case "tooLarge":
      return t("settings.skills.failure.tooLarge", "超过 {{size}} MB", {
        size: SKILL_MAX_BYTES / (1024 * 1024),
      });
    case "copyFailed":
      return t("settings.skills.failure.copyFailed", "复制失败");
  }
}

/** 候选列表的排序：能动手的在前。 */
const STATUS_ORDER: Record<SkillImportStatus, number> = {
  importable: 0,
  conflict: 1,
  imported: 2,
  manualOnly: 3,
  invalid: 4,
};

const selectable = (c: SkillImportCandidate) =>
  c.status === "importable" || c.status === "conflict";

export function SkillSettings() {
  const { t } = useTranslation();
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="font-serif text-lg">{t("settings.skills", "技能")}</h2>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "settings.skills.description",
            "技能是写给 AI 的操作说明（SKILL.md，兼容 Agent Skills 格式）。遇到对应的任务时，AI 会先读说明再动手；技能附带的脚本通过命令执行，照常需要你批准。",
          )}
        </p>
      </div>
      <InstalledSkills />
      <ImportSkills />
    </section>
  );
}

function InstalledSkills() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const disabled = usePrefsStore((s) => s.disabledSkills);
  const setSkillEnabled = usePrefsStore((s) => s.setSkillEnabled);
  const [deleteTarget, setDeleteTarget] = useState<SkillDto | null>(null);
  const skills = useQuery({
    queryKey: qk.skills,
    queryFn: () => window.api.skills.list(),
    // 用户可能在应用外往技能文件夹里放东西：每次打开都重新读。
    staleTime: 0,
  });
  const openDir = (folder?: string) =>
    window.api.skills.openDir({ folder }).catch((err: unknown) =>
      toast.error(
        t("settings.skills.openFailed", "没能打开文件夹：{{message}}", {
          message: ipcErrorMessage(err),
        }),
      ),
    );
  const remove = useMutation({
    mutationFn: (folder: string) => window.api.skills.delete({ folder }),
    onSuccess: () => {
      setDeleteTarget(null);
      void qc.invalidateQueries({ queryKey: qk.skills });
      void qc.invalidateQueries({ queryKey: qk.skillCandidates });
    },
    onError: (err) =>
      toast.error(
        t("settings.skills.deleteFailed", "技能删除失败：{{message}}", {
          message: ipcErrorMessage(err),
        }),
      ),
  });

  const list = skills.data ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("settings.skills.installed", "已安装")}</h3>
        <Button variant="ghost" size="sm" onClick={() => void openDir()}>
          <FolderOpen data-icon="inline-start" />
          {t("settings.skills.openFolder", "打开技能文件夹")}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          {t(
            "settings.skills.empty",
            "还没有技能。可以从下方导入，或者把技能文件夹直接放进技能文件夹。",
          )}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {list.map((skill) => {
            const usable = skill.error === null && !skill.manualOnly;
            const enabled = !disabled.includes(skill.name);
            return (
              <li key={skill.folder} className="flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs font-medium">{skill.name}</span>
                  {skill.description && (
                    <span className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {skill.description}
                    </span>
                  )}
                  {skill.error && (
                    <span className="mt-0.5 block text-[11px] text-destructive">
                      {errorLabel(skill.error, t)}
                    </span>
                  )}
                  {skill.manualOnly && (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {t("settings.skills.manualOnly", "需要手动调用，暂不支持")}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("settings.skills.openSkillFolder", "打开 {{name}} 的文件夹", {
                      name: skill.name,
                    })}
                    onClick={() => void openDir(skill.folder)}
                    className="text-muted-foreground"
                  >
                    <FolderOpen />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("settings.skills.delete", "删除 {{name}}", { name: skill.name })}
                    onClick={() => setDeleteTarget(skill)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                  <Switch
                    checked={usable && enabled}
                    disabled={!usable}
                    onCheckedChange={(checked) => setSkillEnabled(skill.name, checked)}
                    aria-label={t("settings.skills.enable", "启用 {{name}}", { name: skill.name })}
                    className="ms-1"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("settings.skills.deleteTitle", "删除技能「{{name}}」？", {
              name: deleteTarget?.name ?? "",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("settings.skills.deleteDesc", "它的文件夹会被移到废纸篓，需要时可以从那里找回。")}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("settings.skills.cancel", "取消")}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleteTarget && remove.mutate(deleteTarget.folder)}
            >
              {t("settings.skills.deleteConfirm", "删除")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusTag({ candidate }: { candidate: SkillImportCandidate }) {
  const { t } = useTranslation();
  const base = "shrink-0 rounded px-1.5 py-px text-[10px]";
  switch (candidate.status) {
    case "importable":
      return null;
    case "imported":
      return (
        <span className={cn(base, "bg-muted text-muted-foreground")}>
          {t("settings.skills.status.imported", "已导入")}
        </span>
      );
    case "conflict":
      return (
        <span className={cn(base, "bg-amber-500/15 text-amber-700 dark:text-amber-300")}>
          {t("settings.skills.status.conflict", "已有同名技能，内容不同")}
        </span>
      );
    case "manualOnly":
      return (
        <span className={cn(base, "bg-muted text-muted-foreground")}>
          {t("settings.skills.manualOnly", "需要手动调用，暂不支持")}
        </span>
      );
    case "invalid":
      return (
        <span className={cn(base, "bg-destructive/10 text-destructive")}>
          {candidate.error
            ? errorLabel(candidate.error, t)
            : t("settings.skills.status.invalid", "格式无效")}
        </span>
      );
  }
}

function importSummary(result: SkillImportResult, t: TFunction): string {
  const parts: string[] = [
    t("settings.skills.imported", "已导入 {{count}} 个技能", { count: result.imported.length }),
  ];
  for (const f of result.failed) {
    parts.push(
      t("settings.skills.importFailedItem", "{{name}}：{{reason}}", {
        name: f.name,
        reason: failureLabel(f.reason, t),
      }),
    );
  }
  for (const s of result.skippedLinks) {
    parts.push(
      t("settings.skills.skippedLinks", "{{name}}：跳过了 {{count}} 个符号链接", {
        name: s.name,
        count: s.paths.length,
      }),
    );
  }
  return parts.join("\n");
}

function ImportSkills() {
  const { t, i18n } = useTranslation();
  // 来源目录与大小上限等规则值取自共享常量，插值进文案，不写死在翻译里。
  const sources = formatList(SKILL_IMPORT_ROOTS, i18n.language);
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const candidates = useQuery({
    queryKey: qk.skillCandidates,
    queryFn: () => window.api.skills.scanImportable(),
    staleTime: 0,
  });
  const run = useMutation({
    mutationFn: (sources: string[]) => window.api.skills.import({ sources }),
    onSuccess: (result) => {
      setSelected([]);
      setConfirmOverwrite(false);
      void qc.invalidateQueries({ queryKey: qk.skills });
      void qc.invalidateQueries({ queryKey: qk.skillCandidates });
      const message = importSummary(result, t);
      if (result.failed.length > 0) toast.warning(message);
      else toast.success(message);
    },
    onError: (err) =>
      toast.error(
        t("settings.skills.importFailed", "导入失败：{{message}}", {
          message: ipcErrorMessage(err),
        }),
      ),
  });

  const list = [...(candidates.data ?? [])].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  );
  const chosen = list.filter((c) => selected.includes(c.source) && selectable(c));
  const overwriting = chosen.filter((c) => c.status === "conflict");
  const toggle = (source: string, on: boolean) =>
    setSelected((s) => (on ? [...s, source] : s.filter((x) => x !== source)));
  const start = () => {
    if (overwriting.length > 0) setConfirmOverwrite(true);
    else run.mutate(chosen.map((c) => c.source));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("settings.skills.import", "从其他位置导入")}</h3>
        {/* 列表可能很长：操作按钮放在列表上方，勾选后不用滚到底。 */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={candidates.isFetching}
            onClick={() => void candidates.refetch()}
          >
            <RefreshCw data-icon="inline-start" />
            {t("settings.skills.rescan", "重新扫描")}
          </Button>
          <Button size="sm" disabled={chosen.length === 0 || run.isPending} onClick={start}>
            {t("settings.skills.importSelected", "导入所选（{{count}}）", { count: chosen.length })}
          </Button>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t(
          "settings.skills.importDesc",
          "扫描 {{sources}}。导入会复制一份到应用的技能文件夹，之后不随原处同步，原处更新了就再导入一次。技能内部的符号链接不会被复制。",
          { sources },
        )}
      </p>
      {list.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/70">
          {candidates.isFetching
            ? t("settings.skills.scanning", "正在扫描…")
            : t("settings.skills.noCandidates", "{{sources}} 里都没有找到技能。", { sources })}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {list.map((c) => {
            const id = `skill-import-${c.source}`;
            const can = selectable(c);
            return (
              <li
                key={c.source}
                className={cn("flex items-start gap-3 px-3 py-2", !can && "opacity-60")}
              >
                <Checkbox
                  id={id}
                  checked={can && selected.includes(c.source)}
                  disabled={!can}
                  onCheckedChange={(checked) => toggle(c.source, checked)}
                  className="mt-0.5"
                />
                <label htmlFor={id} className={cn("min-w-0 flex-1", can && "cursor-pointer")}>
                  <span className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-medium">{c.name}</span>
                    <StatusTag candidate={c} />
                  </span>
                  {c.description && (
                    <span className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                      {c.description}
                    </span>
                  )}
                  <span
                    className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/70"
                    title={c.foundAt.join("\n")}
                  >
                    {c.foundAt[0]}
                    {c.foundAt.length > 1 &&
                      t("settings.skills.alsoAt", " 等 {{count}} 处", { count: c.foundAt.length })}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog open={confirmOverwrite} onOpenChange={setConfirmOverwrite}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("settings.skills.overwriteTitle", "覆盖已安装的同名技能？")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "settings.skills.overwriteDesc",
              "已装过、但内容和这次要导入的不同：{{names}}。继续会用新内容替换已安装的版本，你在应用里做过的改动会丢失。",
              { names: overwriting.map((c) => c.name).join("、") },
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmOverwrite(false)}>
              {t("settings.skills.cancel", "取消")}
            </Button>
            <Button
              variant="destructive"
              disabled={run.isPending}
              onClick={() => run.mutate(chosen.map((c) => c.source))}
            >
              {t("settings.skills.overwriteConfirm", "覆盖并导入")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
