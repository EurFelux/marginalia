// 「命令」设置页（spec 2026-10-03-bash-skills-permissions-design §8）：总开关、工作目录、总是批准、规则。
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { qk } from "@renderer/query/keys";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Input } from "@renderer/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import type { PermissionDecision, PermissionRuleDto } from "@shared/permissions";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function CommandSettings() {
  const { t } = useTranslation();
  const bashEnabled = usePrefsStore((s) => s.bashEnabled);
  const setBashEnabled = usePrefsStore((s) => s.setBashEnabled);
  const alwaysApprove = usePrefsStore((s) => s.bashAlwaysApprove);
  const setAlwaysApprove = usePrefsStore((s) => s.setBashAlwaysApprove);
  const [confirmAlways, setConfirmAlways] = useState(false);

  return (
    <>
      <section className="space-y-4">
        <h2 className="font-serif text-lg">{t("settings.commands", "命令")}</h2>

        <div className="flex items-start justify-between gap-3">
          <label htmlFor="bash-enabled" className="min-w-0 cursor-pointer">
            <span className="block text-sm font-medium">
              {t("settings.commands.enabled", "允许 AI 执行命令")}
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
              {t(
                "settings.commands.enabledDesc",
                "开启后，对话里的 AI 可以在你的电脑上执行终端命令（如 ls、node、git），用来和外部系统打交道。每条命令默认都要你批准。书、网页里的内容可能藏着诱导 AI 执行命令的指令，批准前请看清命令。",
              )}
            </span>
          </label>
          <Checkbox
            id="bash-enabled"
            checked={bashEnabled}
            onCheckedChange={setBashEnabled}
            className="mt-0.5"
          />
        </div>

        <WorkdirRow />

        <div className="flex items-start justify-between gap-3">
          <label htmlFor="bash-always-approve" className="min-w-0 cursor-pointer">
            <span className="block text-sm font-medium">
              {t("settings.commands.alwaysApprove", "总是批准")}
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
              {t(
                "settings.commands.alwaysApproveDesc",
                "开启后 AI 执行命令不再询问你，直接运行；拒绝规则仍然生效。开着时输入框上方会一直提示。",
              )}
            </span>
          </label>
          <Checkbox
            id="bash-always-approve"
            checked={alwaysApprove}
            onCheckedChange={(checked) =>
              checked ? setConfirmAlways(true) : setAlwaysApprove(false)
            }
            disabled={!bashEnabled}
            className="mt-0.5"
          />
        </div>

        <RulesSection />
      </section>

      <AlertDialog open={confirmAlways} onOpenChange={setConfirmAlways}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("settings.commands.alwaysConfirmTitle", "让 AI 执行命令不再经过你？")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "settings.commands.alwaysConfirmDesc",
              "书、网页和命令输出里可能藏着诱导 AI 执行命令的指令。打开后，AI 想执行的命令都会直接运行，不再询问你。拒绝规则仍然生效，但挡不住刻意绕过（比如把命令写进脚本再运行）。建议先在下方加几条拒绝规则。",
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmAlways(false)}>
              {t("settings.commands.cancel", "取消")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setAlwaysApprove(true);
                setConfirmAlways(false);
              }}
            >
              {t("settings.commands.alwaysConfirm", "仍然打开")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function WorkdirRow() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const bashWorkdir = usePrefsStore((s) => s.bashWorkdir);
  const setBashWorkdir = usePrefsStore((s) => s.setBashWorkdir);
  const info = useQuery({
    // 依赖偏好值：改目录后重新取一次实际路径与是否存在。
    queryKey: [...qk.bashWorkdir, bashWorkdir],
    queryFn: () => window.api.bash.workdirInfo(),
    staleTime: 0,
  });

  const pick = async () => {
    const dir = await window.api.bash.pickWorkdir();
    if (dir) setBashWorkdir(dir);
  };
  const open = () =>
    window.api.bash
      .openWorkdir()
      .then(() => qc.invalidateQueries({ queryKey: qk.bashWorkdir }))
      .catch((err: unknown) =>
        toast.error(
          t("settings.commands.openFailed", "没能打开工作目录：{{message}}", {
            message: errorMessage(err),
          }),
        ),
      );

  const data = info.data;
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium">
        {t("settings.commands.workdir", "工作目录")}
      </span>
      <span className="block text-[11px] leading-relaxed text-muted-foreground">
        {t(
          "settings.commands.workdirDesc",
          "每条命令都从这个文件夹开始执行。默认是应用自己的工作区。",
        )}
      </span>
      {data && (
        <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={data.path}>
            {data.path}
          </span>
          {data.isDefault ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {t("settings.commands.workdirDefault", "默认")}
            </span>
          ) : (
            !data.exists && (
              <span className="shrink-0 text-[11px] text-destructive">
                {t("settings.commands.workdirMissing", "文件夹不存在")}
              </span>
            )
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void pick()}>
          {t("settings.commands.workdirPick", "选择文件夹…")}
        </Button>
        {!data?.isDefault && (
          <Button type="button" variant="outline" size="sm" onClick={() => setBashWorkdir(null)}>
            {t("settings.commands.workdirReset", "恢复默认")}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={() => void open()}>
          {t("settings.commands.workdirOpen", "在访达中打开")}
        </Button>
      </div>
    </div>
  );
}

function RulesSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [decision, setDecision] = useState<PermissionDecision>("deny");
  const [pattern, setPattern] = useState("");
  const rules = useQuery({
    queryKey: qk.permissionRules,
    queryFn: () => window.api.permissions.rules.list(),
    // 规则也会在对话的审批操作栏里新增（不经本页 mutation），每次打开都重新拉取。
    staleTime: 0,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: qk.permissionRules });

  const add = useMutation({
    mutationFn: () =>
      window.api.permissions.rules.add({ tool: "bash", decision, pattern: pattern.trim() }),
    onSuccess: () => {
      setPattern("");
      void refresh();
    },
    onError: (err) =>
      toast.error(
        t("settings.commands.ruleAddFailed", "规则没能添加：{{message}}", {
          message: errorMessage(err),
        }),
      ),
  });
  const remove = useMutation({
    mutationFn: (id: string) => window.api.permissions.rules.delete({ id }),
    onSuccess: () => void refresh(),
    onError: () => toast.error(t("settings.commands.ruleDeleteFailed", "规则删除失败，请重试")),
  });

  const all = rules.data ?? [];
  const group = (d: PermissionDecision) => all.filter((r) => r.decision === d);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("settings.commands.rules", "规则")}</h3>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "settings.commands.rulesDesc",
            "规则按命令开头的完整词匹配：「git status」会放行 git status -s，但不放行 git log。允许规则只对不含 ; | & > 等符号的简单命令生效；拒绝规则会检查组合命令的每一段，「总是批准」也绕不过。",
          )}
        </p>
      </div>

      <RuleGroup
        title={t("settings.commands.allowRules", "允许")}
        empty={t(
          "settings.commands.noAllowRules",
          "还没有允许规则。在对话里批准命令时可以选「总是允许」。",
        )}
        rules={group("allow")}
        onDelete={(id) => remove.mutate(id)}
      />
      <RuleGroup
        title={t("settings.commands.denyRules", "拒绝")}
        empty={t("settings.commands.noDenyRules", "还没有拒绝规则。")}
        rules={group("deny")}
        onDelete={(id) => remove.mutate(id)}
      />

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pattern.trim()) add.mutate();
        }}
      >
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[decision]}
          onValueChange={(v) => v[0] && setDecision(v[0] as PermissionDecision)}
        >
          <ToggleGroupItem value="allow" className="text-xs">
            {t("settings.commands.allowRules", "允许")}
          </ToggleGroupItem>
          <ToggleGroupItem value="deny" className="text-xs">
            {t("settings.commands.denyRules", "拒绝")}
          </ToggleGroupItem>
        </ToggleGroup>
        <Input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder={t("settings.commands.rulePlaceholder", "命令开头，如 git status 或 rm")}
          className="font-mono text-xs"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={!pattern.trim() || add.isPending}
        >
          {t("settings.commands.ruleAdd", "添加")}
        </Button>
      </form>
    </div>
  );
}

function RuleGroup({
  title,
  empty,
  rules,
  onDelete,
}: {
  title: string;
  empty: string;
  rules: PermissionRuleDto[];
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <span className="block text-xs text-muted-foreground">{title}</span>
      {rules.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/70">{empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-center gap-2 px-2.5 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={rule.pattern}>
                {rule.pattern}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("settings.commands.ruleDelete", "删除规则 {{pattern}}", {
                  pattern: rule.pattern,
                })}
                onClick={() => onDelete(rule.id)}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
