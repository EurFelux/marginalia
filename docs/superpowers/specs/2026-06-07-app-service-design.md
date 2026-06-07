# AppService（Electron API 抽象层）设计

日期：2026-06-07（v2 修订：废除 `env` getter——`dataDir` 完全私有，公共面改为 `getPath(scope)` + `isDev` + `openFolder`）
状态：v2 已与用户对齐；v1 代码已落地，待按 v2 同步
关联：从持久化日志设计（`2026-06-07-persistent-logging-design.md`）拆出；`LoggerService` 是首个消费者

## 1. 背景与动机

第一性目的是**业务逻辑与 Electron API 解耦**：业务与基础设施模块面向 `AppService` 的抽象接口编程，对 Electron 的存在无感知——这是端口-适配器（Ports & Adapters）结构：`AppService` 是端口，`main.ts` 注入的 Electron 实现是适配器。无头可测是这个解耦的直接收益：仓库铁律「业务逻辑无头可测」之下，若某模块直接 `import { app } from "electron"`，则任何 import 了它的业务模块在 vitest（`ELECTRON_RUN_AS_NODE=1`，无 GUI API）中一加载即崩——Electron 依赖经横切关注点传染整个业务层。

直接动因：`LoggerService` 要专有数据目录（日志目录）与运行模式（dev 双写判断）。既有解法是各模块自开 init 钩子（`instance.ts` 的 `initDb`/`getDb` 模式），每多一个消费方就多一个钩子。`AppService` 把「生命周期注入 Electron 环境与能力」收敛为单一抽象：`main.ts` 注入一次，所有无头模块按需消费。

数据目录的暴露方式（v2）：**不暴露原始 `dataDir`**——若消费方各自拿根目录拼路径，目录布局的知识就散落在所有消费方里（拼错、漂移无从约束）。改为 `getPath(scope)` 以**类型化 key** 按 module 发放专有子目录（如 `logs`、`books` 各一个目录），布局知识收归 AppService 一处。

## 2. 决策摘要

| 决策点             | 结论                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 核心原则           | **AppService 是 Electron API 的抽象层（端口），模块自身不 import electron**——`main.ts` 注入环境值与能力实现（适配器），不是 re-export electron；业务面向抽象编程，整条「业务模块 → 基础设施 → app」依赖链保持无头可测                                                                                                                                                                                                              |
| 演进规则           | 今后无头模块需要任何 Electron API（值或能力），**一律经 AppService 扩展抽象面**，禁止直 import electron——Electron 触点收敛于 `main.ts` 注入处与既有胶水层                                                                                                                                                                                                                                                                          |
| 平台无关           | **字段以领域语言命名，不绑 Electron 术语**：`dataDir`（非 userDataPath）、`isDev`（非 isPackaged）、`openFolder`（非 openPath）——端口不泄露适配器词汇，换运行时只换 `main.ts` 注入实现                                                                                                                                                                                                                                             |
| 组织形式           | 与 logger 同形：`AppService` 类 + 模块内单例，**类不导出**；barrel（`index.ts`）仅 re-export 只读单例 `appService`；`initAppService(...)` 不进 barrel，`main.ts` 深导入                                                                                                                                                                                                                                                            |
| API 面             | **按需设计**——公共面三项：`getPath(scope)`（LoggerService 等需要专有目录）、`isDev`（dev 双写判断）、`openFolder(dir)`（`app:openLogsDir` handler 需要，`main.ts` 注入 `shell.openPath` 实现）。注入物仍含 `dataDir`，但它是 `#env` 私有字段，**永不暴露**                                                                                                                                                                         |
| 目录 scope 化      | `getPath(scope: DataScope): string` 返回 `<dataDir>/<scope>`；`DataScope = "logs" \| "books"`（类型化 key，按需扩展）——`"logs"` 给 LoggerService；`"books"` 与现状 `userData/books` 布局完全一致（零数据迁移）。**books 迁移在本 spec 范围**：删除 `instance.ts` 的 `getBooksDir`，其消费方（`ai/send-deps.ts` ×2、`ipc/library-handlers.ts` ×4）改用 `appService.getPath("books")`。getPath 纯计算不碰 fs（目录创建是消费方的事） |     |
| 恒可用 + fail-fast | **不允许 AppService 不可用**：公共面方法/getter（`getPath`/`isDev`/`openFolder`）返回类型均**无 null/undefined**——消费侧零判空零降级。生产：`main.ts` 启动最早注入，初始化失败**直接崩**（不捕获，不带病运行）；未注入即调用任一公共成员抛错（初始化顺序 bug，fail-fast 暴露）。测试：vitest 全局 setup 注入测试 env（tmp dataDir），不变量在测试中同样成立——**不指望任何下游降级**                                                |
| 注入时机           | `main.ts` 在 `app.setName(…-dev)` 之后立即 `initAppService(...)`（注入代码见 §3），先于一切消费方                                                                                                                                                                                                                                                                                                                                  |
| 命名冲突           | 现有 `src/main/app-service.ts`（`getAppInfo` 纯函数）**改名 `app-info.ts`**（名实相符），同步 `app-handlers.ts` 与对应测试的 import，为 `src/main/app/` 让出名字                                                                                                                                                                                                                                                                   |

## 3. 接口定义

```typescript
// app-service.ts —— 公共面声明（类本身不导出）

/** main.ts 注入的运行环境实现。字段平台无关——不绑 Electron 术语 */
export interface AppServiceEnv {
  /** 应用数据根目录（Electron 适配 = app.getPath("userData")）——注入后存于 #env 私有字段，永不对外暴露 */
  dataDir: string;
  /** 是否开发模式（Electron 适配 = !app.isPackaged） */
  isDev: boolean;
  /** 在系统文件管理器中打开目录（Electron 适配 = shell.openPath，吞掉其 string 返回值） */
  openFolder: (dir: string) => Promise<void>;
}

/** 各 module 的专有数据目录 scope（类型化 key，按需扩展）。
 * "logs" → LoggerService；"books" → 书籍副本（替代 instance.ts 的 getBooksDir，布局不变） */
export type DataScope = "logs" | "books";

/** 生命周期钩子：仅 main.ts 与测试深导入调用，不进 barrel */
export function initAppService(env: AppServiceEnv): void;

/**
 * 只读单例（barrel 唯一导出）。原始 dataDir 不暴露——目录布局知识收归此处。
 * 「恒可用」是全局不变量：生产由 main.ts 启动注入保证（失败即崩），测试由 vitest
 * 全局 setup 注入保证；未注入即调用任一成员 = 初始化顺序 bug，直接 throw（fail-fast）。
 */
export const appService: {
  /** module 专有数据目录：返回 <dataDir>/<scope>。纯计算不碰 fs——目录创建是消费方的事 */
  getPath(scope: DataScope): string;
  readonly isDev: boolean;
  openFolder(dir: string): Promise<void>;
};
```

`main.ts` 注入处（Electron 术语止步于此；**不包 try/catch**——`app.getPath` 等若抛错即未捕获崩溃，正是 fail-fast 要的行为）：

```typescript
initAppService({
  dataDir: app.getPath("userData"),
  isDev: !app.isPackaged,
  openFolder: async (dir) => {
    await shell.openPath(dir); // 返回的错误信息字符串在适配器层吞掉——openLogsDir 场景失败不致命
  },
});
```

## 4. 模块结构

```
src/main/app/
  index.ts         # barrel：仅 re-export appService——消费方唯一入口
  app-service.ts   # AppService 类 + 模块内单例（类不导出）；initAppService 导出但不进 barrel

注入与消费：
main.ts ── initAppService({ dataDir, isDev, openFolder })（深导入 app/app-service）──→ 单例（dataDir 入 #env 私有）
消费方（LoggerService、handlers 等）── import { appService } from "../app" ──→ getPath(scope) / isDev / openFolder（恒可用）
```

- 测试侧由 **vitest 全局 setup**（`setupFiles`）深导入 `initAppService` 注入测试 env（tmp dataDir 等），与 `main.ts` 走同一机制——「恒可用」不变量对所有测试成立，不存在测试专用后门。单测需要特定 env（如断言 openFolder 被调用）时在测试内重新注入。
- 与 `instance.ts`（DB 单例）是同族模式：「init 由生命周期所有者调用，消费 API 保持纯净」；区别是 AppService 用 barrel 把 init 从公共面隐藏。

## 5. 测试策略

- `app-service.test.ts`：未注入即调用 `getPath`/`isDev`/`openFolder` 任一成员抛错（fail-fast；本测试文件用 resetModules+动态 import 构造未注入态）；注入后 `getPath("logs")` = `<dataDir>/logs`、`getPath("books")` = `<dataDir>/books`、`isDev` 即注入值；`openFolder` fake 断言被调用与参数；重复注入 last-wins；**原始 dataDir 不可达**（公共面无任何成员返回根目录本身）；barrel 导出面仅 `appService`（封装不泄露）；`grep -rn "getBooksDir" src/` 零命中（迁移完成的回归断言，手动验证即可）。
- vitest 全局 setup（`setupFiles`）注入测试 env，保证其余所有测试中 `appService` 恒可用。

## 6. 工作量估计

~0.25 天（含 `app-service.ts` → `app-info.ts` 改名与 import 同步）。先于持久化日志实现——logger 依赖它。
v2 同步增量：重构 `app-service.ts` 公共面（env getter → getPath/isDev/openFolder）+ 测试更新 + getBooksDir 删除与 6 处消费点迁移，~0.15 天。
