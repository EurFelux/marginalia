# 应用更新检测（检测 + 跳转 Release 页）— 设计

- 日期：2026-06-15
- Issue：[#87](https://github.com/EurFelux/marginalia/issues/87) Add in-app auto-update mechanism
- 类型：enhancement · area:build · area:settings

## 目标

给 app 加一个**轻量更新检测**：

- **启动时自动**后台静默查一次 GitHub Releases；发现新版本 → sonner toast 提示，点「查看」用现成 `openExternal` 跳转 release 页手动下载。
- **设置「高级」面板**新增「关于」小节：显示当前版本 + 「检查更新」按钮，可随时手动查（三态反馈：有新版 / 已最新 / 失败）。

**只检测、只跳转，不下载不安装。** 这是 issue #87 在「短期无代码签名」约束下的近期形态——Squirrel.Mac 静默自动安装需有效 Developer ID，ad-hoc 签名（#35）做不了；全自动下载安装推迟到签名/公证就位（见 #87 的分期方案）。

## 关键事实（实测，决定实现）

- **发布是 `draft:true + prerelease:true`**（`forge.config.ts:86-90` 的 `PublisherGithub`）。GitHub 的 `GET /releases/latest` **不返回 prerelease**——我们 0.x 阶段全发 prerelease，故 `/latest` 会 404/失配。**必须走 `GET /releases` 列表**（匿名 API 自动过滤 draft，返回含 prerelease 的已发布项，按 `created_at` 降序），取首个。
- **GitHub API 强制要求 `User-Agent` 请求头**，缺失直接 403。这是最易踩的坑，务必带上。
- **tag 格式 = `v${version}`**（Forge `PublisherGithub` 默认打的 git tag），如 `v0.13.0`；解析须 strip 前导 `v`。
- 匿名 GitHub API 限速 60 次/小时/IP；启动一次 + 偶尔手动远低于上限，**无需 token**。
- 主进程出站请求走注入的 `net.fetch`（系统代理，`main.ts:145` 已为 AI 注入同款），更新检测沿用，规避区域直连问题。

## 非目标（YAGNI）

- **不**做自动下载 / 安装 / 重启（受签名约束，见 #87；签名就位后另起 electron-updater 工作）。
- **不**引入 `electron-updater`：项目是 Electron Forge + Squirrel，`electron-updater` 依赖 electron-builder 产出的 `latest.yml`，Forge 不生成，接入成本高且超出「检测+跳转」。
- **不**做「跳过此版本 / 不再提醒」。
- **不**给启动自动检查加开关（默认开；失败静默无感，无打扰）。
- **不**做定时轮询：仅「启动一次 + 手动」。
- **不**带 GitHub token：匿名足够。

## 一、主进程纯函数（新 `src/main/app/update-check.ts`，无头可测）

```ts
const REPO = { owner: "EurFelux", name: "marginalia" } as const; // 与 forge.config.ts PublisherGithub 一致

// UpdateCheckResult 在 shared 单一源定义（见 §二），此处 `import type` 复用，不重复定义
export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch,
  repo: { owner: string; name: string } = REPO,
): Promise<UpdateCheckResult>;
```

- 调 `GET https://api.github.com/repos/{owner}/{name}/releases?per_page=10`，headers：
  `{ "User-Agent": "marginalia", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }`。
- 非 200 / fetch reject / JSON 解析失败 → `{ status: "error", message }`（message 取 HTTP 语义或异常文本，遵循「不编造原因」）。
- 响应空数组（从没发过 release）→ `up-to-date`，`latestVersion = currentVersion`。
- 取 `releases[0]`（降序首个，匿名 API 已无 draft）；`latest = tag_name` strip `^v`。
- 用 `semver.gt(latest, currentVersion)` 判：true → `update-available`（带 `releaseUrl = html_url`）；否则 `up-to-date`。
- **纯函数**：注入 `fetchImpl` + 可选 `repo`，不碰任何 Electron API → vitest 直接喂假 fetch 测三分支。
- 模块级 `const log = createLogger("update")`；catch 分支 `log.warn("update check failed", err)`。

**版本比较依赖**：引入 `semver`（成熟、纯 JS，正确处理 `0.14.0-beta < 0.14.0` 这类 prerelease 语义；自写 split 易错）。`pnpm add semver` + `pnpm add -D @types/semver`；装后 `pnpm db:rebuild:electron` 兜底（postinstall 一般自动）。

## 二、IPC channel（`app:check-update`）

- **`src/shared/ipc.ts`**：`UpdateCheckResult` 的**单一数据源**——用 zod 判别联合（discriminator `status`）定义并 `z.infer` 导出类型，三 arm：
  - `{ status: "update-available", currentVersion, latestVersion, releaseUrl }`
  - `{ status: "up-to-date", currentVersion, latestVersion }`
  - `{ status: "error", currentVersion, message }`

  主进程 `update-check.ts` 与渲染层均 `import type` 复用。channel 仿无输入 channel（同 `appGetInfo`）定义 `appCheckUpdate: def("app:check-update", "invoke", <无输入>, out<UpdateCheckResult>())`。

- **`src/main/ipc/app-handlers.ts`**：
  ```ts
  bind(C.appCheckUpdate, () => checkForUpdate(app.getVersion(), net.fetch as typeof fetch)),
  ```
  （`net` 从 `electron` import；`net.fetch` 与 `fetch` 签名微差，cast。）
- **`src/preload-api.ts`**：invoker 由 `inv()` 工厂自动生成，渲染层 `window.api.app.checkUpdate()`（归入 `app` 命名空间，同 `getInfo`/`openExternal`）。

## 三、渲染层 — 启动自动检查

- 新 hook `useStartupUpdateCheck`（renderer，在 `App.tsx` 顶层调一次）：
  - `useEffect` + `useRef` 守卫防重入（StrictMode/re-mount 只发一次）。
  - 调 `window.api.app.checkUpdate()`：
    - `update-available` → `toast(t("update.available", { version }), { action: { label: t("update.view"), onClick: () => window.api.app.openExternal({ url: releaseUrl }) }, duration: Infinity, closeButton: true })`。
    - `up-to-date` / `error` → **静默**（error 仅 `log.warn`）；启动检查不打扰用户。
  - 模块级 `const log = createLogger("update")`（renderer logger）。

## 四、渲染层 — 手动检查（设置「高级」面板「关于」小节）

- **`src/renderer/settings/AdvancedSettings.tsx`** 新增「关于」小节（放日志/备份附近）：
  - 显示当前版本：来源用现成 `window.api.app.getInfo()`（已暴露 `version`）渲染 `v{version}`。
  - 「检查更新」按钮：点击 → 本地 loading 态 → `window.api.app.checkUpdate()`：
    - `update-available` → `toast` 同启动版（带「查看」跳转）+ 按钮旁内联「发现新版本 v{latest}」。
    - `up-to-date` → `toast.success(t("update.upToDate"))`。
    - `error` → `toast.error(t("update.checkFailed"))`（手动触发须明确告知，区别于启动静默）。
  - 文案全走 `t()`；样式用 Tailwind 工具类（禁内联 CSS），按钮复用现有 UI 组件。

## 五、i18n（新 key，跑 `pnpm i18n:extract`）

| key                                | 草拟中文               |
| ---------------------------------- | ---------------------- |
| `settings.advanced.about`          | 关于                   |
| `settings.advanced.currentVersion` | 当前版本               |
| `settings.advanced.checkUpdate`    | 检查更新               |
| `update.available`                 | 发现新版本 {{version}} |
| `update.view`                      | 查看                   |
| `update.upToDate`                  | 已是最新版本           |
| `update.checkFailed`               | 检查更新失败           |

`pnpm i18n:extract` 后 `pnpm i18n:lint` 校验不缺漏。

## 六、测试策略（无头 vitest）

- **新 `src/main/app/update-check.test.ts`**（纯函数，注入假 fetch）：
  - `update-available`：latest tag `v0.14.0` > current `0.13.0`。
  - `up-to-date`：latest == current；latest < current（防回退误报）。
  - `error`：fetch reject / 非 200 / body 非 JSON。
  - 空数组 releases → `up-to-date`。
  - tag `v` 前缀正确 strip。
  - prerelease 语义：`v0.14.0-beta.1` vs `0.13.0` → available；current 为 prerelease 时的边界。
  - 断言请求带 `User-Agent` 头（防回归丢头 → 403）。
- 渲染层手动/启动 UI 逻辑较薄，核心断言压在纯函数；UI 接线靠收尾冒烟覆盖。

## 七、验证与收尾

- `pnpm typecheck && pnpm lint && pnpm test`（全绿）。
- `pnpm i18n:extract` 后 `pnpm i18n:lint`。
- **冒烟**（`pnpm start`）：① 临时把比较基准调低（或构造 current 低于线上 release）验证启动 toast + 点「查看」跳转浏览器到 release 页；② 设置「关于」小节按钮三态（有新版带跳转 / 已最新 / 断网失败 toast）；③ 版本号正确显示。
- 写一条 `pnpm changeset`（英文用户向 changelog）。
- commit 末尾 `closes #87`；kanban 卡 In progress → 合并/关 issue 后自动挪 Done。
