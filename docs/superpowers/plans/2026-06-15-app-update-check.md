# 应用更新检测（检测 + 跳转 Release 页）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 app 加轻量更新检测——启动静默查一次 GitHub Releases，发现新版弹 toast 跳转 release 页；设置「高级」加「关于」小节（版本 + 检查更新按钮三态）。只检测只跳转，不下载不安装。

**Architecture:** 主进程纯函数 `checkForUpdate(currentVersion, fetchImpl)` 调 GitHub `/releases` API（注入 `net.fetch` 走系统代理）、用 `semver.gt` 比较，返回判别联合 `UpdateCheckResult`（shared 单一源）。新 IPC channel `app:check-update`（无输入）。渲染层启动 hook + 设置面板按钮消费，跳转复用现成 `window.api.app.openExternal`。

**Tech Stack:** Electron `net.fetch`、Zod 判别联合、`semver`、Vercel 无关、sonner toast、react-i18next、vitest（注入假 fetch 测纯函数）。

**设计依据：** `docs/superpowers/specs/2026-06-15-app-update-check-design.md`（含「draft+prerelease 必须走 /releases 列表」「GitHub API 强制 User-Agent 头」两个坑）。

**全程提醒：** 当前在 git worktree（`.../.claude/worktrees/<name>`）。所有命令从 worktree 根跑；Write/Edit 用 worktree 路径或相对路径，**别用主仓库根绝对路径**（会污染主仓库、worktree git 看不到）。

---

### Task 1: 引入 semver 依赖

**Files:**

- Modify: `package.json`（deps / devDeps，由 pnpm 自动写）

- [ ] **Step 1: 装运行时依赖 + 类型**

Run:

```bash
pnpm add semver && pnpm add -D @types/semver
```

Expected: `package.json` 出现 `"semver"`（dependencies）与 `"@types/semver"`（devDependencies）。

- [ ] **Step 2: 兜底把 better-sqlite3 翻回 Electron ABI（装包会按系统 Node 重编）**

Run:

```bash
pnpm db:rebuild:electron
```

Expected: 重建完成无报错（postinstall 通常已自动跑，此步是保险）。

- [ ] **Step 3: 确认测试运行时仍正常**

Run: `pnpm test src/main/app/external-url.test.ts`
Expected: PASS（验证 native ABI 没被装包打坏）。

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add semver for update version comparison"
```

---

### Task 2: 主进程纯函数 `checkForUpdate` + shared 结果类型（TDD）

**Files:**

- Modify: `src/shared/ipc.ts`（加 `updateCheckResult` schema + `UpdateCheckResult` 类型，**先不加 channel**——避免 bindings-coverage 提前变红）
- Create: `src/main/app/update-check.ts`
- Test: `src/main/app/update-check.test.ts`

- [ ] **Step 1: 在 `src/shared/ipc.ts` 加结果类型（单一数据源）**

在 `appGetInfoResult`（约 line 76-80）之后插入：

```ts
/** app:check-update —— 更新检测结果（判别联合，discriminator=status） */
export const updateCheckResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("update-available"),
    currentVersion: z.string(),
    latestVersion: z.string(),
    releaseUrl: z.string(),
  }),
  z.object({
    status: z.literal("up-to-date"),
    currentVersion: z.string(),
    latestVersion: z.string(),
  }),
  z.object({
    status: z.literal("error"),
    currentVersion: z.string(),
    message: z.string(),
  }),
]);
export type UpdateCheckResult = z.infer<typeof updateCheckResult>;
```

- [ ] **Step 2: 写失败测试 `src/main/app/update-check.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { checkForUpdate } from "./update-check";

const REPO = { owner: "EurFelux", name: "marginalia" };

/** 造一个返回给定 releases 数组的假 fetch；记录最后一次请求的 init 以便断言请求头。 */
function fetchReturning(releases: unknown, init?: { ok?: boolean; status?: number }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (url: string, reqInit?: RequestInit) => {
    calls.push({ url, init: reqInit });
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      statusText: "OK",
      json: async () => releases,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("checkForUpdate", () => {
  it("reports update-available when latest tag is greater", async () => {
    const { impl } = fetchReturning([
      { tag_name: "v0.14.0", html_url: "https://x/releases/v0.14.0" },
    ]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res).toEqual({
      status: "update-available",
      currentVersion: "0.13.0",
      latestVersion: "0.14.0",
      releaseUrl: "https://x/releases/v0.14.0",
    });
  });

  it("treats prerelease tags via semver semantics", async () => {
    const { impl } = fetchReturning([{ tag_name: "v0.14.0-beta.1", html_url: "https://x/r" }]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res.status).toBe("update-available");
    if (res.status === "update-available") expect(res.latestVersion).toBe("0.14.0-beta.1");
  });

  it("reports up-to-date when latest equals current", async () => {
    const { impl } = fetchReturning([{ tag_name: "v0.13.0", html_url: "https://x/r" }]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res).toEqual({
      status: "up-to-date",
      currentVersion: "0.13.0",
      latestVersion: "0.13.0",
    });
  });

  it("reports up-to-date when latest is lower (no downgrade prompt)", async () => {
    const { impl } = fetchReturning([{ tag_name: "v0.12.0", html_url: "https://x/r" }]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res.status).toBe("up-to-date");
  });

  it("reports up-to-date on empty releases array", async () => {
    const { impl } = fetchReturning([]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res).toEqual({
      status: "up-to-date",
      currentVersion: "0.13.0",
      latestVersion: "0.13.0",
    });
  });

  it("reports error on non-200 response", async () => {
    const { impl } = fetchReturning([], { ok: false, status: 403 });
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res.status).toBe("error");
  });

  it("reports error when fetch rejects", async () => {
    const impl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res).toEqual({ status: "error", currentVersion: "0.13.0", message: "network down" });
  });

  it("reports error on unparseable tag", async () => {
    const { impl } = fetchReturning([{ tag_name: "nightly", html_url: "https://x/r" }]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res.status).toBe("error");
  });

  it("sends required User-Agent header (GitHub 403s without it)", async () => {
    const { impl, calls } = fetchReturning([{ tag_name: "v0.13.0", html_url: "https://x/r" }]);
    await checkForUpdate("0.13.0", impl, REPO);
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers["User-Agent"]).toBeTruthy();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/main/app/update-check.test.ts`
Expected: FAIL（`checkForUpdate` 未定义 / 模块不存在）。

- [ ] **Step 4: 实现 `src/main/app/update-check.ts`**

```ts
import semver from "semver";
import type { UpdateCheckResult } from "@shared/ipc";
import { createLogger } from "@main/logger";

const log = createLogger("update");

/** 与 forge.config.ts PublisherGithub 一致；发布全为 draft+prerelease，故走 /releases 列表（匿名 API 自动过滤 draft、含 prerelease、按 created_at 降序）。 */
const REPO = { owner: "EurFelux", name: "marginalia" } as const;

interface GithubRelease {
  tag_name: string;
  html_url: string;
}

export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch,
  repo: { owner: string; name: string } = REPO,
): Promise<UpdateCheckResult> {
  try {
    const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/releases?per_page=10`;
    const res = await fetchImpl(url, {
      headers: {
        // GitHub API 缺 User-Agent 直接 403，务必带上。
        "User-Agent": "marginalia",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      return {
        status: "error",
        currentVersion,
        message: `GitHub API ${res.status} ${res.statusText}`,
      };
    }
    const releases = (await res.json()) as GithubRelease[];
    if (!Array.isArray(releases) || releases.length === 0) {
      return { status: "up-to-date", currentVersion, latestVersion: currentVersion };
    }
    const latestVersion = releases[0].tag_name.replace(/^v/, "");
    if (!semver.valid(latestVersion)) {
      return {
        status: "error",
        currentVersion,
        message: `unparseable release tag: ${releases[0].tag_name}`,
      };
    }
    if (semver.gt(latestVersion, currentVersion)) {
      return {
        status: "update-available",
        currentVersion,
        latestVersion,
        releaseUrl: releases[0].html_url,
      };
    }
    return { status: "up-to-date", currentVersion, latestVersion };
  } catch (err) {
    log.warn("update check failed", err);
    return {
      status: "error",
      currentVersion,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/main/app/update-check.test.ts`
Expected: PASS（9 个用例全绿）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/main/app/update-check.ts src/main/app/update-check.test.ts
git commit -m "feat(update): add checkForUpdate pure function + shared result type"
```

---

### Task 3: 接线 IPC channel `app:check-update`（三处同步）

**Files:**

- Modify: `src/shared/ipc.ts:118-123`（`C` 对象 app 段加 channel）
- Modify: `src/main/ipc/app-handlers.ts`（import net + checkForUpdate；appBindings 加 bind）
- Modify: `src/preload-api.ts:29-35`（app 命名空间加 checkUpdate）

- [ ] **Step 1: `src/shared/ipc.ts` 的 `C` 对象 app 段加 channel**

在 `appOpenExternal` 行（约 line 122）之后加：

```ts
  appCheckUpdate: def("app:check-update", "invoke", z.void(), out<UpdateCheckResult>()),
```

- [ ] **Step 2: `src/main/ipc/app-handlers.ts` 加 import 与 binding**

把第 1 行 import 改为带 `net`：

```ts
import { app, ipcMain, net, shell } from "electron";
```

在第 6 行 `isAllowedExternalUrl` import 之后加：

```ts
import { checkForUpdate } from "@main/app/update-check";
```

在 `appBindings` 数组里（`appOpenExternal` 的 bind 之后、闭合 `]` 之前）加：

```ts
  bind(C.appCheckUpdate, () => checkForUpdate(app.getVersion(), net.fetch as typeof fetch)),
```

- [ ] **Step 3: `src/preload-api.ts` 的 app 命名空间暴露**

在 `openExternal: inv(C.appOpenExternal),`（约 line 34）之后加：

```ts
      checkUpdate: inv(C.appCheckUpdate),
```

- [ ] **Step 4: 跑覆盖测试 + 类型检查确认接线一致**

Run: `pnpm test src/main/ipc/bindings-coverage.test.ts src/preload-api.test.ts && pnpm typecheck`
Expected: PASS（bindings-coverage 双向相等含新 channel；preload 覆盖全部 invoke channel；typecheck 绿）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/app-handlers.ts src/preload-api.ts
git commit -m "feat(update): wire app:check-update IPC channel"
```

---

### Task 4: 渲染层启动自动检查 hook

**Files:**

- Create: `src/renderer/update/useStartupUpdateCheck.ts`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: 新建 `src/renderer/update/useStartupUpdateCheck.ts`**

```ts
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { createLogger } from "@renderer/logger";

const log = createLogger("update");

/** 启动时静默查一次更新；有新版弹可跳转 toast，已最新/失败均静默（仅 log.warn）。useRef 守卫防 StrictMode 双跑。 */
export function useStartupUpdateCheck(): void {
  const { t } = useTranslation();
  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    void (async () => {
      try {
        const res = await window.api.app.checkUpdate();
        if (res.status === "update-available") {
          toast(t("update.available", "发现新版本 {{version}}", { version: res.latestVersion }), {
            action: {
              label: t("update.view", "查看"),
              onClick: () => void window.api.app.openExternal({ url: res.releaseUrl }),
            },
            duration: Infinity,
            closeButton: true,
          });
        } else if (res.status === "error") {
          log.warn("startup update check returned error", res.message);
        }
      } catch (err) {
        log.warn("startup update check failed", err);
      }
    })();
  }, [t]);
}
```

- [ ] **Step 2: `src/renderer/App.tsx` 顶层调用 hook**

在第 8 行 `ThemeController` import 之后加：

```ts
import { useStartupUpdateCheck } from "@renderer/update/useStartupUpdateCheck";
```

在 `App` 组件内、现有 `useEffect(() => { hydratePreferences(); }, [])` 之后加一行：

```ts
useStartupUpdateCheck();
```

- [ ] **Step 3: 类型检查 + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS（`@renderer/update/...` 别名解析正常；hook 类型正确）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/update/useStartupUpdateCheck.ts src/renderer/App.tsx
git commit -m "feat(update): startup auto update-check with toast"
```

---

### Task 5: 设置「高级」面板「关于」小节（版本 + 检查更新按钮）

**Files:**

- Modify: `src/renderer/settings/AdvancedSettings.tsx`

- [ ] **Step 1: 加 import（useEffect）**

把第 1 行改为：

```ts
import { useEffect, useState } from "react";
```

- [ ] **Step 2: 组件内加状态与版本读取 + 检查逻辑**

在 `const [pendingRestore, ...]`（约 line 29）之后加：

```ts
const [appVersion, setAppVersion] = useState<string | null>(null);
const [checking, setChecking] = useState(false);
const [latestAvailable, setLatestAvailable] = useState<string | null>(null);

useEffect(() => {
  void window.api.app.getInfo().then((info) => setAppVersion(info.version));
}, []);

const onCheckUpdate = async () => {
  setChecking(true);
  setLatestAvailable(null);
  try {
    const res = await window.api.app.checkUpdate();
    if (res.status === "update-available") {
      setLatestAvailable(res.latestVersion);
      toast(t("update.available", "发现新版本 {{version}}", { version: res.latestVersion }), {
        action: {
          label: t("update.view", "查看"),
          onClick: () => void window.api.app.openExternal({ url: res.releaseUrl }),
        },
        duration: Infinity,
        closeButton: true,
      });
    } else if (res.status === "up-to-date") {
      toast.success(t("update.upToDate", "已是最新版本"));
    } else {
      toast.error(t("update.checkFailed", "检查更新失败"));
    }
  } catch {
    toast.error(t("update.checkFailed", "检查更新失败"));
  } finally {
    setChecking(false);
  }
};
```

- [ ] **Step 3: 在「日志」行（约 line 153 的 `<div className="flex items-center justify-between gap-3">`）之前插入「关于」小节**

```tsx
<div className="flex items-center justify-between gap-3">
  <div className="min-w-0">
    <span className="block text-sm font-medium">{t("settings.advanced.about", "关于")}</span>
    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
      {t("settings.advanced.currentVersion", "当前版本")} v{appVersion ?? "…"}
      {latestAvailable
        ? ` · ${t("update.available", "发现新版本 {{version}}", { version: latestAvailable })}`
        : ""}
    </span>
  </div>
  <Button variant="outline" size="sm" disabled={checking} onClick={() => void onCheckUpdate()}>
    {t("settings.advanced.checkUpdate", "检查更新")}
  </Button>
</div>
```

- [ ] **Step 4: 类型检查 + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/settings/AdvancedSettings.tsx
git commit -m "feat(update): add About section with manual update check"
```

---

### Task 6: i18n 文案落地（zh 同步 + en 手填）

**Files:**

- Modify: `src/shared/i18n/locales/zh-CN.ts`（由 extract 自动写）
- Modify: `src/shared/i18n/locales/en.ts`（手填英文）

- [ ] **Step 1: 抽取并同步主语言**

Run: `pnpm i18n:extract`
Expected: `zh-CN.ts` 出现 7 个新 key（`settings.advanced.about` / `settings.advanced.currentVersion` / `settings.advanced.checkUpdate` / `update.available` / `update.view` / `update.upToDate` / `update.checkFailed`），值取自代码里的中文 fallback。

- [ ] **Step 2: 在 `src/shared/i18n/locales/en.ts` 补英文**

在 `"settings.advanced.stepLimitUnlimited": "Unlimited",`（约 line 250）之后加：

```ts
  "settings.advanced.about": "About",
  "settings.advanced.checkUpdate": "Check for updates",
  "settings.advanced.currentVersion": "Current version",
```

在对象末尾合适处（`as const` 之前）加 update.\* 组：

```ts
  "update.available": "New version {{version}} available",
  "update.checkFailed": "Update check failed",
  "update.upToDate": "You're on the latest version",
  "update.view": "View",
```

- [ ] **Step 3: 校验翻译不缺漏**

Run: `pnpm i18n:lint`
Expected: 无缺失 key 报告（en / zh-CN 均覆盖 7 个新 key）。若 lint 漏报，用 `rg '"update\.' src/shared/i18n/locales/en.ts` 人工确认 4 个 update.\* key 都在。

- [ ] **Step 4: 类型检查（locale 对象类型变化）**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "i18n(update): add update-check strings (zh + en)"
```

---

### Task 7: 全量验证 + changeset

**Files:**

- Create: `.changeset/<random-name>.md`

- [ ] **Step 1: 全绿验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 三者全 PASS。

- [ ] **Step 2: 写 changeset（英文用户向）**

Run: `pnpm changeset`（交互：选 patch；summary 用下文）。或直接创建 `.changeset/app-update-check.md`：

```md
---
"marginalia": patch
---

Add a lightweight update check: the app now checks GitHub Releases on startup and shows a toast when a newer version is available, plus a "Check for updates" button in Advanced settings. It only notifies and links to the release page (no auto-download/install yet).
```

- [ ] **Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: add changeset for update check"
```

---

### Task 8: 冒烟验证（人工 / 非 subagent）

> 启动 GUI 的冒烟由主持会话的人来跑（subagent 跑不了交互 GUI），作为收尾门。

- [ ] **Step 1: 启动应用**

Run: `pnpm start`

- [ ] **Step 2: 验证启动检测**

线上最新 release 高于本地 `0.13.0` 时，启动几秒后应出现「发现新版本 vX.Y.Z」toast；点「查看」浏览器打开 GitHub release 页。若线上无更高版本，可临时在 `app-handlers.ts` 把 `app.getVersion()` 换成 `"0.0.1"` 验证后还原。

- [ ] **Step 3: 验证手动检测三态**

打开 设置 → 高级 → 关于：显示 `当前版本 v0.13.0`；点「检查更新」：有新版（toast 带跳转）/ 已最新（success toast）/ 断网（error toast）。

- [ ] **Step 4: 收尾**

- kanban：#87 合并后自动挪 Done（关 issue 触发）。
- PR / commit 末尾 `closes #87`。

---

## Self-Review（已对照 spec）

- **spec §一 纯函数** → Task 2 ✓；**§二 IPC** → Task 3 ✓；**§三 启动 hook** → Task 4 ✓；**§四 关于小节** → Task 5 ✓；**§五 i18n** → Task 6 ✓；**§六 测试** → Task 2 的 9 用例覆盖三分支 + 空数组 + v 前缀 + prerelease + User-Agent 头 ✓；**§七 验证收尾** → Task 7/8 ✓。
- **类型一致性**：`UpdateCheckResult` 三 arm 字段（update-available 带 releaseUrl、up-to-date 带 latestVersion、error 带 message）在 ipc.ts 定义后，update-check.ts 返回、hook/设置面板消费（`res.status` narrowing、`res.releaseUrl`/`res.latestVersion`/`res.message`）全一致。
- **无占位**：所有 step 含完整代码/命令/期望输出。
- **YAGNI**：无开关、无轮询、无 electron-updater、无下载安装（与 spec 非目标一致）。
