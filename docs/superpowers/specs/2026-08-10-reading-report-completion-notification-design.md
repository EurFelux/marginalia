# 阅读报告生成完成通知 · 设计文档

> 状态：设计已评审通过，**暂不实现**（放 backlog）。
> 日期：2026-08-10
> 关联：`2026-08-10-reading-report-evidence-investigation-design.md`（该轮让报告读全量证据，生成耗时显著变长，本需求由此而来）。

## 背景与目标

报告 agent 现在会读完一次阅读的全部会话证据（长会话经 subagent 分页消化），生成一份报告可能耗时数分钟。用户在等待期间通常已经切走——切到别的 App，或切到 Marginalia 里的另一本书继续读。生成结束时没有任何提示，用户只能自己回去看。

**目标**：报告生成有结果时（成功或失败）主动告知用户，并让他一步回到那份报告。

**成功判据**：

1. 用户切到别的 App 时，生成结束能收到**系统通知**。
2. 用户正看着 Marginalia 时，收到的是**应用内 toast**，不被系统通知打扰。
3. 点击通知（或 toast 的「查看」）直接落到那本书的报告页，不需要自己找回去。
4. 失败与成功一样通知——「等了很久」的终点都需要知道。
5. 用户主动取消不通知。

**验证方式**：路由决策与文案走 vitest 纯函数单测（注入布尔与 spy，不碰真 Electron）；系统通知的真实弹出与点击跳转走手测。

## 范围

**在范围内**：报告生成结束时的通知投递与点击跳转。

**不在范围内**：

- **通知偏好开关**（「关闭报告完成通知」）。现在没有通知设置面板，为一个 kind 单开一项设置不划算；真需要时再加。
- **其他后台任务的通知**（章节摘要、全书摘要、记忆整理）。记忆整理已有自己的 toast；其余耗时短，不构成等待。
- **通知内容里带报告摘要**。通知只说「好了/失败了」，内容留给报告页。

## 架构

```
service.ts 生成结束
  └─ deps.notifyReportOutcome({ bookId, bookTitle, outcome: "ready" | "failed" })
        │
        ├─ 窗口存在且已聚焦 ──→ notifyRenderer({ kind: "readingReportReady", … })
        │                          └─ renderer: sonner toast +「查看」按钮 → openBook(bookId)
        │
        └─ 窗口不存在/未聚焦 ──→ new Notification({ title, body })   ← Electron 系统通知
                                   └─ click: ensureWindow() → show/restore/focus → 发导航事件
                                              └─ renderer: openBook(bookId) → 落到报告页
```

### 前台/后台的判断放在 main

`src/main/notify.ts` 已是「main→renderer 通知的唯一 Electron 触点」。让它同时成为系统通知的唯一触点，Electron 依赖不外扩；渲染层只管收到 toast 就显示，不关心自己是不是前台。

### service 保持纯函数注入型

`ReadingReportServiceDeps` 加一个 `notifyReportOutcome` 端口，测试注入 spy，生产实现在 `send-deps.ts` 绑定——与现有 `runAgent` / `createInvestigator` 同一模式。

触发点在 `runtime.succeed` / `runtime.fail` 之后，且只在 `isCurrent` 通过时：被新一轮生成取代的旧 claim 不该发通知。

### 导航是独立的一条 IPC 通路

不塞进 `AppNotification`。后者语义是「告知」，导航是「命令跳转」；混在一起会让渲染层的通知处理器长出副作用。

### 落点靠现有导航自然解析

`openBook(bookId)` 之后 `resolveBookDestination(readingState, mode)` 会因该书已读完而落到 `ReadingReportView`（`BookRoute.tsx`）。不引入新的路由概念。

### 文案本地化的分工

系统通知的标题/正文由 main 生成——`@shared/i18n` 的 `t()` 在主进程可用（`assistant-model.ts` 已在用）。前台 toast 仍由渲染层本地化，与既有的 `memoryConsolidated` 一致。

## 文件落点

| 文件                                              | 变化                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/main/notify.ts`                              | 新增 `notifyReadingReport()`；纯函数 `reportNotificationText(outcome, bookTitle, t)` 抽出可测 |
| `src/main.ts`                                     | 向 notify 模块注入 `ensureWindow()`（复用 `createWindow`），解决「无窗口时点击通知」          |
| `src/shared/chat.ts`                              | `AppNotification` 加 `kind: "readingReportReady"`，带 `bookId` / `bookTitle` / `outcome`      |
| `src/shared/ipc.ts`                               | 新增导航通道常量                                                                              |
| `src/preload-api.ts`                              | 暴露导航事件订阅                                                                              |
| `src/main/reading-report/service.ts`              | deps 加 `notifyReportOutcome`，在 `succeed` / `fail` 后调用                                   |
| `src/main/ai/send-deps.ts`                        | 绑定生产实现                                                                                  |
| `src/renderer/notifications/app-notifications.ts` | 新 kind → 带「查看」按钮的 toast                                                              |
| `src/renderer/App.tsx`                            | 订阅导航事件 → `openBook(bookId)`                                                             |
| `src/shared/i18n/locales`                         | toast 与系统通知的文案 key                                                                    |

## 边界情况

- **无窗口时点击通知**：macOS 上关掉窗口后 app 仍在（`main.ts` 的 `window-all-closed` 分支），报告可能正好此时生成完。`ensureWindow()` 重建窗口；若 `webContents` 仍在加载，导航事件挂 `did-finish-load` 后再发——否则新窗口会错过这条事件。
- **`Notification.isSupported()` 为 false**（某些 Linux 环境无通知服务）：静默降级为 `notifyRenderer`，留一条 `log.debug`。这不是失败，不用 warn。
- **窗口存在但最小化**：算「不在前台」，走系统通知；点击时 `restore()` + `focus()`。
- **进程退出**：生成中断、无通知。runtime 是内存态，本就如此，不额外处理。
- **陈旧 claim**：`isCurrent` 不通过则不发。
- **用户主动取消**：不发。

## 测试

- `notify.test.ts`（新增）— 纯函数文案；路由决策（前台 → renderer / 后台 → 系统通知 / 不支持 → 降级），注入布尔与 spy。
- `service.test.ts` — 成功发一次、失败发一次、取消不发、陈旧 claim 不发。
- `app-notifications.test.ts` — 新 kind 的 toast 文案与按钮。
- 系统通知的真实弹出与点击跳转走手测。
