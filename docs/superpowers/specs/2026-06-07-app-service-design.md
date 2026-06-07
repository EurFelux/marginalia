# AppService（Electron API 抽象层）设计

日期：2026-06-07
状态：已与用户对齐，待实现
关联：从持久化日志设计（`2026-06-07-persistent-logging-design.md`）拆出；`LoggerService` 是首个消费者

## 1. 背景与动机

第一性目的是**业务逻辑与 Electron API 解耦**：业务与基础设施模块面向 `AppService` 的抽象接口编程，对 Electron 的存在无感知——这是端口-适配器（Ports & Adapters）结构：`AppService` 是端口，`main.ts` 注入的 Electron 实现是适配器。无头可测是这个解耦的直接收益：仓库铁律「业务逻辑无头可测」之下，若某模块直接 `import { app } from "electron"`，则任何 import 了它的业务模块在 vitest（`ELECTRON_RUN_AS_NODE=1`，无 GUI API）中一加载即崩——Electron 依赖经横切关注点传染整个业务层。

直接动因：`LoggerService` 要数据根目录（日志目录的父级）与运行模式（dev 双写判断）。既有解法是各模块自开 init 钩子（`instance.ts` 的 `initDb`/`getDb` 模式），每多一个消费方就多一个钩子。`AppService` 把「生命周期注入 Electron 环境与能力」收敛为单一抽象：`main.ts` 注入一次，所有无头模块按需消费。

## 2. 决策摘要

| 决策点             | 结论                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 核心原则           | **AppService 是 Electron API 的抽象层（端口），模块自身不 import electron**——`main.ts` 注入环境值与能力实现（适配器），不是 re-export electron；业务面向抽象编程，整条「业务模块 → 基础设施 → app」依赖链保持无头可测                                                                                                                                                           |
| 演进规则           | 今后无头模块需要任何 Electron API（值或能力），**一律经 AppService 扩展抽象面**，禁止直 import electron——Electron 触点收敛于 `main.ts` 注入处与既有胶水层                                                                                                                                                                                                                       |
| 平台无关           | **字段以领域语言命名，不绑 Electron 术语**：`dataDir`（非 userDataPath）、`isDev`（非 isPackaged）、`openFolder`（非 openPath）——端口不泄露适配器词汇，换运行时只换 `main.ts` 注入实现                                                                                                                                                                                          |
| 组织形式           | 与 logger 同形：`AppService` 类 + 模块内单例，**类不导出**；barrel（`index.ts`）仅 re-export 只读单例 `appService`；`initAppService(...)` 不进 barrel，`main.ts` 深导入                                                                                                                                                                                                         |
| API 面             | **按需设计**——当前需要什么抽什么：值 `dataDir`、`isDev`（LoggerService 需要）+ 能力 `openFolder(dir)`（`app:openLogsDir` handler 需要，`main.ts` 注入 `shell.openPath` 实现）                                                                                                                                                                                                   |
| 恒可用 + fail-fast | **不允许 AppService 不可用**：公共面是单一 `env` getter，类型就是 `AppServiceEnv`（**无 null**，全字段 required）——消费侧零判空零降级。生产：`main.ts` 启动最早注入，初始化失败**直接崩**（不捕获，不带病运行）；未注入即访问 `env` 抛错（初始化顺序 bug，fail-fast 暴露）。测试：vitest 全局 setup 注入测试 env（tmp dataDir），不变量在测试中同样成立——**不指望任何下游降级** |
| 注入时机           | `main.ts` 在 `app.setName(…-dev)` 之后立即 `initAppService(...)`（注入代码见 §3），先于一切消费方                                                                                                                                                                                                                                                                               |
| 命名冲突           | 现有 `src/main/app-service.ts`（`getAppInfo` 纯函数）**改名 `app-info.ts`**（名实相符），同步 `app-handlers.ts` 与对应测试的 import，为 `src/main/app/` 让出名字                                                                                                                                                                                                                |

## 3. 接口定义

```typescript
// app-service.ts —— 公共面声明（类本身不导出）

/** main.ts 注入的运行环境实现。字段平台无关——不绑 Electron 术语 */
export interface AppServiceEnv {
  /** 应用数据根目录（Electron 适配 = app.getPath("userData")） */
  dataDir: string;
  /** 是否开发模式（Electron 适配 = !app.isPackaged） */
  isDev: boolean;
  /** 在系统文件管理器中打开目录（Electron 适配 = shell.openPath，吞掉其 string 返回值） */
  openFolder: (dir: string) => Promise<void>;
}

/** 生命周期钩子：仅 main.ts 与测试深导入调用，不进 barrel */
export function initAppService(env: AppServiceEnv): void;

/**
 * 只读单例（barrel 唯一导出）。
 * env 恒可用——类型无 null，全字段 required，注入物与消费物同为 AppServiceEnv。
 * 「恒可用」是全局不变量：生产由 main.ts 启动注入保证（失败即崩），测试由 vitest
 * 全局 setup 注入保证；未注入即访问 = 初始化顺序 bug，getter 直接 throw（fail-fast）。
 */
export const appService: {
  readonly env: AppServiceEnv;
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
main.ts ── initAppService({ dataDir, isDev, openFolder })（深导入 app/app-service）──→ 单例
消费方（LoggerService、handlers 等）── import { appService } from "../app" ──→ appService.env（恒可用，直接消费）
```

- 测试侧由 **vitest 全局 setup**（`setupFiles`）深导入 `initAppService` 注入测试 env（tmp dataDir 等），与 `main.ts` 走同一机制——「恒可用」不变量对所有测试成立，不存在测试专用后门。单测需要特定 env（如断言 openFolder 被调用）时在测试内重新注入。
- 与 `instance.ts`（DB 单例）是同族模式：「init 由生命周期所有者调用，消费 API 保持纯净」；区别是 AppService 用 barrel 把 init 从公共面隐藏。

## 5. 测试策略

- `app-service.test.ts`：未注入即访问 `env` 抛错（fail-fast；本测试文件需绕过全局 setup 或重置单例以构造未注入态）；注入后 `env` 即注入对象（全字段可用，能力注入 fake 断言被调用与参数）；重复注入以后者为准（或忽略，实现时定其一并断言）；barrel 导出面仅 `appService`（封装不泄露）。
- vitest 全局 setup（`setupFiles`）注入测试 env，保证其余所有测试中 `appService.env` 恒可用。

## 6. 工作量估计

~0.25 天（含 `app-service.ts` → `app-info.ts` 改名与 import 同步）。先于持久化日志实现——logger 依赖它。
