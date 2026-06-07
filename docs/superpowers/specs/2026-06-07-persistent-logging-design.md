# 持久化日志系统设计

日期：2026-06-07
状态：草案——未完全审查（依赖项 AppService 先行实现，本 spec 实现前需再过一轮审查）
关联：GitHub issue #32（P0）；实现前勘察见 issue 评论（17 个主进程 console 调用点盘点）；**依赖 `2026-06-07-app-service-design.md`（AppService 先行实现）**

## 1. 背景与动机

主进程的 `console.warn/error`（`[send]` 流错误、PDF 封面渲染失败、字体替换警告等）只进 stdout——打包后的 app 没有终端，生产问题无迹可查。渲染层更裸：没有 ErrorBoundary、没有 `window.onerror`/`unhandledrejection`，白屏与组件崩溃同样零记录。需要一套覆盖主进程 + 渲染层的文件日志，并给用户一个「打开日志文件夹」的入口，让排障与用户反馈（贴日志）成为可能。

## 2. 决策摘要

| 决策点            | 结论                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 技术选型          | **轻量自研**（~200 行）而非 electron-log：需求面窄（append + 轮转 + 级别 + 模块前缀），零依赖不碰打包 ignore 白名单（#9/P4 教训）                                                                                                                                                                                                                                                                             |
| 接入架构          | **公共 API 收口到 `createLogger` 工厂**：各模块 `const logger = createLogger("library")` 自建实例。**实例是薄封装**——只持有 module 状态与日志方法，实际 fs/IPC 操作委托模块内单例 `LoggerService`；**类与单例均不导出**，业务代码无法绕过 `createLogger` 直取 service。生命周期内 service 恒为一个实例、logger 实例任意多（薄，零逻辑冗余）。不用 console monkey-patch（隐式魔法）也不用 DI（横切关注点过重） |
| 本期范围          | 主进程替换 + 渲染层 funnel（ErrorBoundary + 全局钩子 → IPC）**一次交付**；渲染层目前零错误捕获，顺手接上成本低                                                                                                                                                                                                                                                                                                |
| 日志格式          | 人类可读文本行（非 JSON lines）：消费者是开发者本人与贴日志的用户，无日志聚合系统                                                                                                                                                                                                                                                                                                                             |
| 写入策略          | 同步 `appendFileSync`：日志量小（错误/警告为主），崩溃前必落盘，免异步队列 flush 复杂度                                                                                                                                                                                                                                                                                                                       |
| Electron 环境依赖 | **`LoggerService` 依赖 `AppService`**（独立 spec：`2026-06-07-app-service-design.md`，先行实现）经 `appService.getPath("logs")` 取专有日志目录、`appService.isDev` 判 dev 双写（均**恒可用**，fail-fast 保证，见该 spec v2）——logger 模块不 import electron，零判空零降级，整条依赖链无头可测                                                                                                                 |
| 轮转              | 按日期：每天一个文件 `main-YYYY-MM-DD.log`，日期翻转自然切新文件；保留最近 30 天，过期文件在启动与翻转时清理                                                                                                                                                                                                                                                                                                  |
| 测试环境行为      | **与生产同构，无降级分支**：vitest 全局 setup 注入测试 env（tmp dataDir），`appService` 在测试中同样恒可用——logger 正常写 tmp 文件，测试直接断言文件内容                                                                                                                                                                                                                                                      |
| 入口位置          | 设置页新增**「高级」（advanced）分类**，首条目「打开日志文件夹」；不引入应用 Menu（超范围）。#19 代理、#28 备份将来同归此分类                                                                                                                                                                                                                                                                                 |
| 日志自身故障      | 写文件失败（磁盘满等）静默降级回 console，绝不抛出——日志系统不能搞崩业务                                                                                                                                                                                                                                                                                                                                      |

## 3. 总体架构

```
src/main/logger/
  index.ts           # barrel：仅 re-export createLogger——业务代码唯一入口
  logger-service.ts  # LoggerService 类 + 模块内单例（级别过滤、格式化、console 着色）——类与实例不导出
  file-sink.ts       # 内部模块：文件写入 + 按日期轮转/过期清理
src/renderer/logger/
  index.ts           # barrel：仅 re-export createLogger
  logger-service.ts  # 同形组织：LoggerService 类 + 单例（不导出），实现 = 经 log:write IPC 转发

数据流：
AppService（外部依赖，见独立 spec v2；getPath("logs") / isDev / openFolder 恒可用——fail-fast 保证）
                                                                      ↓
主进程模块 ─ createLogger("send")（薄实例）─┐
process.on(uncaughtException/…) ────────────┤→ LoggerService → file-sink → userData/logs/main-YYYY-MM-DD.log
渲染层 createLogger("boundary") ─ log:write IPC ─┘      （dev 双写 console）
```

**封装规则**：两侧 `logger-service.ts` 组织形式完全相同——`LoggerService` 类在模块内实现并单例化，**类与实例均不导出**。**barrel（`index.ts`）仅 re-export `createLogger`**，业务代码一律 import barrel，公共面收口为单一入口。`createLogger` 实例只持有 module 与四个级别方法，所有格式化、级别过滤、文件写入、console 输出都收敛在 service——多实例零逻辑冗余。两侧唯一差异是 service 实现：主进程写 fs（经 file-sink），渲染层经 `api.log.write` IPC 转发主进程。**Electron 环境依赖**：主进程 `LoggerService` 经 `appService`（`import { appService } from "../app"`，见独立 spec）每次写入时调 `appService.getPath("logs")` 与 `appService.isDev`（恒可用，fail-fast 保证，不缓存）——logger 模块不 import electron、不知道根目录在哪（目录布局知识在 AppService），零判空零降级，barrel 零例外（仅 `createLogger`）。渲染层无需任何 init（`api.log.write` 常在）。

主进程与渲染层汇入**同一个日志文件**（当天的），排障时单条时间线，不用跨文件对时序。dev/prod 数据目录隔离（`marginalia-dev` vs `marginalia`）由 `userData` 路径自然继承，日志互不污染。

## 4. 日志核心行为

- **级别**：`error / warn / info / debug`。文件写 info 及以上；debug 仅 dev 写。
- **格式**：

  ```
  [2026-06-07T14:23:45.123Z] [main] [error] [send] stream/model error: rate limit exceeded
    Error: ... 多行堆栈缩进两格 ...
  [2026-06-07T14:23:46.001Z] [renderer] [error] [boundary] component tree crashed: ...
  ```

  **四段式 `[timestamp] [source] [level] [module]`** + 消息：时间戳 ISO 8601（UTC）、来源（`main` / `renderer`）、级别、模块（`createLogger` 的参数）；Error 对象展开 message + stack，后续行缩进两格。来源段显式区分进程：主进程 `createLogger` 产出的实例固定 `[main]`，渲染层经 `log:write` 汇入的固定 `[renderer]`——单文件时间线上一眼分清来源，每段独立可 grep（按来源、按级别、按模块均可过滤）。

- **轮转**：按日期——写入时以当前日期决定目标文件 `main-YYYY-MM-DD.log`（文件名缓存，日期翻转自动切新文件）；首次写入与日期翻转时扫描 `logs/` 目录，删除文件名日期早于 30 天的日志。无大小上限（错误/警告量级小，单日文件天然有界）。
- **dev 双写**：`appService.isDev` 时同时输出 console，保留现有 stdout 体验；**按 level 着色**便于扫读——error 红、warn 黄、info 青、debug 灰暗。零依赖手写 ANSI 码（~10 行常量，不引入 chalk/picocolors），仅 `process.stdout.isTTY` 时启用（管道重定向时不输出转义码）。文件落盘永远是纯文本，不含 ANSI 码。
- **写入故障降级**：`appService` 恒可用（fail-fast 保证），LoggerService 无「未注入」分支；唯一的降级是**运行中文件写入失败**（磁盘满、目录不可写等）——静默退 console、绝不抛错（日志系统不能搞崩业务，与决策摘要一致）。

## 5. 主进程集成

- **前提**：`AppService` 已按其 spec 完成实现与 `main.ts` 注入接线（`initAppService` 先于一切日志消费）。
- `main.ts`：挂 `process.on("uncaughtException")` 与 `process.on("unhandledRejection")` → `createLogger("process").error`。日志目录 = `appService.getPath("logs")`（路径由 AppService 发放，目录 lazy 创建仍由 LoggerService 做）。
- 替换勘察盘点的 17 个 console 调用点（`ai/send.ts`、`ai/summary.ts`、`ipc/registry.ts` 的 catch-all、`library/repository.ts` 等）→ 各模块 `createLogger("send" | "summary" | "ipc" | "library" | …)`。
- 工具执行错误维持 `{error}` 回流给模型自纠（`tools.ts` runTool 契约不变），只记日志不改行为。

## 6. IPC 与渲染层 funnel

新增通道（Zod schema 进 `src/shared/ipc.ts`，走 `registry.handle` + `validateInput` 既有模式）：

| 通道              | 方向            | 契约                                                                                                                              |
| ----------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `log:write`       | renderer → main | `{ level, module, message }` → void；落盘时来源段由主进程侧强制写 `[renderer]`（渲染层不可伪装为 `[main]`）                       |
| `app:openLogsDir` | renderer → main | void → void；handler 经 `appService.openFolder(appService.getPath("logs"))` 调用（恒可用；不直 import shell，见 AppService spec） |

preload 暴露 `api.log.write` 与 `api.app.openLogsDir`。

渲染层三件套（入口 `renderer.tsx` 挂载，统一经渲染层 `createLogger` 上报，不裸调 `api.log.write`）：

1. **ErrorBoundary**：包裹 App 根，组件树崩溃 → fallback UI + `createLogger("boundary").error(…)`；
2. `window.onerror` → `createLogger("window").error(…)`；
3. `window.addEventListener("unhandledrejection", …)` → 同上。

## 7. 设置页入口

`SettingsShell` 新增第 4 个分类 `advanced`（高级），首条目「打开日志文件夹」按钮 → `api.app.openLogsDir()`。i18n 补 en + zh-CN key。

## 8. 测试策略

- `logger-service.test.ts`：全局 setup 已注入 tmp env，直接断言写入内容；级别过滤（debug 不落盘）；写入故障（目标不可写）静默退 console、不抛错；Error 格式化（含 stack 缩进）；文件内容不含 ANSI 转义码；barrel 导出面断言（`logger` 仅 `createLogger`，封装不泄露；`app` 侧断言归 AppService spec）。
- `file-sink.test.ts`：按日期写对目标文件；日期翻转切新文件；30 天前的过期文件被清理、30 天内的保留；非日志文件（命名不匹配）不误删。
- IPC handler：`log:write` 入参校验走现有 validateInput 测试模式。
- 交付前打包验证：`pnpm package` 产物以 `--user-data-dir=/tmp/<x>` 冒烟启动，确认 `logs/main-<当日>.log` 生成且含启动日志。

## 9. 工作量估计

~1.5 天：核心 logger + sink（0.5）＋ 主进程集成替换（0.5）＋ 渲染层 funnel 与设置入口（0.5）。前置依赖 AppService（~0.25 天，见其 spec）。
