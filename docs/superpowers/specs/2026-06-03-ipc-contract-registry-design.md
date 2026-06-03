# IPC 契约注册表重构 · 设计文档

> 状态：已确认范围与方案（用户 2026-06-03 拍板「契约 map + 类型化 invoker」）。对应 ROADMAP backlog #8（#7 架构债）。

## 1. 背景与动机

一条 IPC 通道的信息当前**分散在四处、靠人肉同步**：

1. `src/shared/ipc.ts` 的 `IPC` 对象——通道名常量。
2. `src/shared/<domain>.ts`——input Zod schema + output DTO 类型。
3. `src/preload.ts`——手写 `window.api` 方法 `(input: X): Promise<Y> => ipcRenderer.invoke(IPC.x, input)`，类型标注是 handler 端类型的**第二份手抄**。
4. `src/main/ipc/<domain>-handlers.ts`——`handle<I, O>(IPC.x, schema, fn)`，`<I, O>` 泛型与 schema 推导的类型**重复**（如 `handle<{ bookId: string }, BookSummaryDto | null>(IPC.libraryGet, bookIdInput, …)`，`I` 本可从 `bookIdInput` 推导）。

新增/修改一个通道要改 4 个文件，且类型契约靠手工维系、易漂移。本轮把 **通道名 + input schema + 类型** 收敛到单一契约定义，让两端引用同一份契约对象——**类型漂移变编译错误、通道名漂移结构上不可能**，preload 类型由契约派生、零手写标注。

**爆炸半径勘定**：10 个 renderer 文件只消费 `window.api.*` 嵌套结构，**不碰 `IPC` 常量**。故 `window.api` 形状是 renderer 的契约，本轮**原样保留**，renderer 零改动；`IPC` 常量仅 preload + 7 个 handler + 测试引用。

## 2. 方案选型

三种「彻底」程度，已选**方案二**：

| 方案                                       | preload 怎么来                                                                       | 取舍                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 一 · 声明式契约 + 派生 preload             | 由契约树走树生成整个 `window.api`，特殊通道走 escape hatch                           | 单一源最彻底；但需较重 mapped-type 机巧保证派生出的嵌套 API 类型与 10 个 renderer 期望完全一致，类型报错难懂、维护成本高 |
| **二 · 契约 map + 类型化 invoker（选定）** | preload 仍手工嵌套（保留 JSDoc/escape hatch 就地可读），但类型全从契约流出、不可漂移 | 命中真痛点（重复泛型 + preload 手抄类型 + 四处分散），风险低、可读性好                                                   |
| 三 · 最小改动                              | preload 现状不动、手写类型仍在                                                       | 改动最小；但「四处分散」与「preload 手抄」两大痛点基本没解，#8 价值打折                                                  |

## 3. 现状关键事实

- `handle<I, O>(channel, inputSchema, fn)`（`registry.ts`）**只校验 input**，output（`O`）纯 TS 类型、运行时不校验。本轮**保持** output 不做运行时校验（见 §7 非目标）。
- 5 个**不走标准 invoke** 的通道必须保留语义：
  - `ai:send`——invoke，但 fn 需 `event.sender` 推流（现签名第二参已传 `IpcMainInvokeEvent`，无需特殊 kind）。
  - `ai:chunk`——main→renderer 推流事件（`webContents.send` + `ipcRenderer.on`），带 streamId 过滤 + 退订。
  - `preferences:get-all-sync`、`app:get-locale-sync`——同步 `ipcRenderer.sendSync` + `ipcMain.on`，preload 首帧前求值、带 try/catch 兜底（绝不让首帧/i18n init 崩）。
  - `library.pathForFile`——纯 renderer `webUtils.getPathForFile`，**根本不是 IPC**。
- 测试现状：handler 测试只测抽出的纯函数（`pumpStream`）与 `validateInput`，不测 `ipcMain.handle` 注册本身。vitest 跑在 **Electron 运行时**（`ipcMain` 可用）。
- `pingResult`、`appGetInfoResult` 是仅有的两个 output Zod schema（在 `ipc.ts`，有独立单元测试）；本轮保留其 schema 与测试不动（作为契约 `output` 的类型来源亦可）。

## 4. 设计

### 4.1 契约 map `C`（单一真相源）

`src/shared/ipc.ts` 重写：导出契约 map `C`，每通道一条。input schema **复用** domain 文件已有 schema（定义留在 domain 保持内聚，`ipc.ts` 只做绑定汇聚）。

```ts
import type { z } from "zod";

/** output 幽灵类型载体：零运行时值，仅在类型层携带 O。 */
declare const OUT: unique symbol;
export interface Out<O> {
  readonly [OUT]: O;
}
export const out = <O>(): Out<O> => ({}) as Out<O>;

export type IpcKind = "invoke" | "sync" | "event";

export interface Contract<S extends z.ZodType = z.ZodType, O = unknown> {
  channel: string;
  kind: IpcKind;
  input: S;
  output: Out<O>;
}

export type ContractMap = Record<string, Contract>;

export type InferIn<C> = C extends Contract<infer S, unknown> ? z.infer<S> : never;
export type InferOut<C> = C extends Contract<z.ZodType, infer O> ? O : never;

export const C = {
  // 例：
  appGetInfo: {
    channel: "app:get-info",
    kind: "invoke",
    input: z.void(),
    output: out<AppGetInfoResult>(),
  },
  libraryGet: {
    channel: "library:get",
    kind: "invoke",
    input: bookIdInput,
    output: out<BookSummaryDto | null>(),
  },
  aiSend: { channel: "ai:send", kind: "invoke", input: sendRequest, output: out<SendAck>() },
  aiChunk: { channel: "ai:chunk", kind: "event", input: z.void(), output: out<AiStreamEvent>() },
  preferencesGetAllSync: {
    channel: "preferences:get-all-sync",
    kind: "sync",
    input: z.void(),
    output: out<PreferencesSnapshot>(),
  },
  // …全部通道（含原 IPC 对象的每一项）
} satisfies ContractMap;
```

- **`IPC` 常量对象删除**，全改 `C.x`。`handle(C.x, fn)` / `invoker(C.x)` 不用 `.channel`；仅 5 个特殊通道的手写处用 `C.x.channel`。彻底单一源。
- **output 用 `out<T>()` 幽灵载体**（零运行时值）。理由：output 非漂移痛点；`UIMessageChunk` 等 AI SDK 复杂联合难 schema 化；保持现状不做 output 运行时校验。

### 4.2 三种 kind

| kind     | 通道                                                | 消费方式                                                             |
| -------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `invoke` | 绝大多数（含 `aiSend`，fn 第二参拿 `event.sender`） | `handle()` + `invoker()` 全自动                                      |
| `sync`   | `preferencesGetAllSync`、`appGetLocaleSync`         | 手写 `ipcMain.on` + `ipcRenderer.sendSync`（首帧前带兜底，保留现状） |
| `event`  | `aiChunk`（main→renderer 推流）                     | 手写 `sender.send` + `onChunk` 订阅/过滤/退订                        |

`library.pathForFile` **不入 `C`**——纯 renderer `webUtils`，留作 preload 手写 escape-hatch 方法。

### 4.3 四个核心原语

> **为何拆 `bind` / `register`（而非一个 `handle`）**：测试跑在 `ELECTRON_RUN_AS_NODE=1` 下，`require("electron")` 返回字符串、`ipcMain` 为 `undefined`（已实测）；任何在测试里调 `ipcMain.handle` 的路径都会崩。故把「声明绑定」与「实际注册」分离：`bind()` 产出**纯数据** `Binding`（可被 headless 测试读取做覆盖断言），`register()` 是唯一碰 `ipcMain` 的地方。这也让注册更声明式，正贴 #8「声明式注册表」目标。

**`bind(contract, fn)` + `register(bindings)`**（`registry.ts` 改写）：

```ts
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { validateInput } from "@main/ipc/validate";
import type { Contract } from "@shared/ipc";

/** 声明式绑定：契约 + 业务 fn，纯数据，不碰 Electron（供 headless 覆盖测试读取）。 */
export interface Binding {
  contract: Contract;
  fn: (input: never, event: IpcMainInvokeEvent) => unknown;
}

/** 把契约与业务 fn 绑成一条 Binding；input 类型由契约的 input schema 推导。 */
export function bind<S extends z.ZodType, O>(
  contract: Contract<S, O>,
  fn: (input: z.infer<S>, event: IpcMainInvokeEvent) => O | Promise<O>,
): Binding {
  return { contract, fn: fn as Binding["fn"] };
}

/** 唯一碰 ipcMain 的地方：为每条 Binding 注册经 Zod 校验的 invoke handler。 */
export function register(bindings: Binding[]): void {
  for (const { contract, fn } of bindings) {
    ipcMain.handle(contract.channel, async (event, raw: unknown) => {
      try {
        const input = validateInput(contract.channel, contract.input, raw);
        return await (fn as (i: unknown, e: IpcMainInvokeEvent) => unknown)(input, event);
      } catch (err) {
        console.error(`[ipc] ${contract.channel} failed:`, err);
        throw err;
      }
    });
  }
}
```

input schema 从 contract 取、不再写 `<I, O>`；`bind` 的 fn 入参类型 `z.infer<input>` 自动推导，返回值被 `output` 类型约束。每个 handler 模块导出 `<domain>Bindings: Binding[]`，`registerXHandlers()` 调 `register(<domain>Bindings)`（sync 通道仍各自手写 `ipcMain.on`）。

**`invoker(invoke, contract)`**（preload 新原语）：

```ts
export function invoker<S extends z.ZodType, O>(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  contract: Contract<S, O>,
): ((input: z.infer<S>) => Promise<O>) & { __channel: string } {
  const fn = (input: z.infer<S>) => invoke(contract.channel, input) as Promise<O>;
  return Object.assign(fn, { __channel: contract.channel });
}
```

类型从 contract 流出、**零手写标注**；`__channel` 供漂移测试走树收集。`z.void()` 入参的方法（如 `libraryList`）调用端可 `list()` 无参（`void` 形参容纳 `undefined`），handler 端 `z.void()` 校验通过。

**`createApi(deps)`**（新文件 `src/preload-api.ts`，**纯函数 + 注入依赖**，呼应本仓「纯函数 + 胶水注入」测试哲学）：接收注入的 `{ invoke, on, getPathForFile, prefsSnapshot, appLocale }`，返回与现在**形状完全一致**的嵌套 `window.api`。

```ts
export interface PreloadDeps {
  invoke: (channel: string, input: unknown) => Promise<unknown>;
  on: (channel: string, cb: (payload: unknown) => void) => () => void; // 返回退订
  getPathForFile: (file: File) => string;
  prefsSnapshot: PreferencesSnapshot;
  appLocale: string;
}

export function createApi(d: PreloadDeps) {
  const inv = <S extends z.ZodType, O>(c: Contract<S, O>) => invoker(d.invoke, c);
  return {
    app: { getInfo: inv(C.appGetInfo), locale: d.appLocale },
    ping: inv(C.ping),
    library: {
      import: inv(C.libraryImport),
      // …
      pathForFile: (f: File) => d.getPathForFile(f), // escape hatch（非 IPC）
    },
    // …content / annotations / settings / chat
    ai: {
      buildChips: inv(C.aiBuildChips),
      send: inv(C.aiSend),
      abort: inv(C.aiAbort),
      onChunk: (streamId: string, cb: (ev: AiStreamEvent) => void) =>
        d.on(C.aiChunk.channel, (payload) => {
          const ev = payload as AiStreamEvent;
          if (ev.streamId === streamId) cb(ev);
        }), // escape hatch（event 订阅/过滤/退订）
    },
    preferences: {
      getAll: () => d.prefsSnapshot, // 返回启动快照（保留现状语义）
      set: inv(C.preferencesSet),
    },
  };
}

export type RendererApi = ReturnType<typeof createApi>;
```

`preload.ts` 瘦成：取同步快照 → `createApi(真实依赖)` → `contextBridge.exposeInMainWorld`：

```ts
const prefsSnapshot = ipcRenderer.sendSync(C.preferencesGetAllSync.channel) as PreferencesSnapshot;
const appLocale = ipcRenderer.sendSync(C.appGetLocaleSync.channel) as string;

const api = createApi({
  invoke: (ch, input) => ipcRenderer.invoke(ch, input),
  on: (ch, cb) => {
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
  getPathForFile: (f) => webUtils.getPathForFile(f),
  prefsSnapshot,
  appLocale,
});
contextBridge.exposeInMainWorld("api", api);
export type { RendererApi } from "./preload-api"; // 重导出，使 renderer 的 global.d.ts（`from "../preload"`）零改动
```

> preload 顶层 `sendSync` 仍在（首帧前求值，见记忆 `preload-no-dom-at-eval`）；将其作为**值**注入 `createApi`，使 `createApi` 不触发任何 Electron 调用、可在 headless 测试里走树验证。
>
> `RendererApi` 类型来源从 `preload.ts` 内联（`typeof api`）改为 `preload-api.ts`（`ReturnType<typeof createApi>`），但 `preload.ts` **重导出**它，故 `src/renderer/global.d.ts` 的 `import type { RendererApi } from "../preload"` 与所有 renderer 端类型零改动。`preload-api.ts` 放在 `src/preload-api.ts`（与 `preload.ts` 同级），由 `vite.preload.config.ts` 经入口自动 bundle，无需改 vite/tsconfig 配置（仅用到已有的 `@shared` 别名）。

### 4.4 preload 保持手工嵌套（类型来自 contract）

```ts
library: {
  /** 取单本书；不存在返回 null */     // ← 珍贵 JSDoc 就地保留
  get: inv(C.libraryGet),              // 无手写类型, 不漂移
  pathForFile: (f: File) => d.getPathForFile(f),
},
```

## 5. 防漂移测试（纯测试为主，免翻 Electron）

1. **契约完整性**（纯，`ipc.test.ts`）：`C` 内 channel 全唯一、kind 合法；保留 ping/appInfo 既有 schema 单元测试。
2. **preload 覆盖**（纯，`preload-api.test.ts`）：`createApi` 注入 recording 依赖 → 走树收集所有方法的 `__channel` → 断言 == `C` 里 `invoke` 类通道集（`event`/`sync` 经 escape hatch，不入此断言）。亦断言无方法绑定 `C` 之外的通道。
3. **handler 覆盖**（纯，`bindings-coverage.test.ts`）：import 全部 `<domain>Bindings` 数组 → 收集 `b.contract.channel` → 断言其集合 == `C` 中 `kind === "invoke"` 的通道集。
   - 纯读 `Binding` 数组（`bind()` 只包数据、不碰 `ipcMain`），故无需 Electron API——绕开 `ELECTRON_RUN_AS_NODE` 下 `ipcMain` 为 `undefined` 的限制。
   - 捕获「加了 `invoke` 契约却忘接 handler」（契约多、binding 少）与「binding 引用了 `C` 之外的通道」（结构上 `bind(C.x,…)` 已防，但断言兜底）。
   - `sync`（2 个，手写 `ipcMain.on`）与 `event`（`aiChunk`，push-only）不入 binding，故不入此断言；二者数量固定且少，由 §4.2 表与代码审查覆盖。

## 6. 改动清单

**改：**

- `src/shared/ipc.ts`——建 `C` + `Contract`/`Out`/`ContractMap`/`IpcKind`/`InferIn`/`InferOut` 类型 + `out()`；删 `IPC` 对象（保留 `pingInput`/`pingResult`/`appGetInfoResult` schema）。
- `src/main/ipc/registry.ts`——删旧 `handle`，改为 `Binding`/`bind()`/`register()`。
- `src/preload.ts`——瘦身为依赖装配 + 暴露 + 重导出 `RendererApi`。
- 7 个 `src/main/ipc/*-handlers.ts`——导出 `<domain>Bindings: Binding[]`（`bind(C.x, fn)`），`registerXHandlers()` 调 `register(...)`；sync/event 手写处 `IPC.x` → `C.x.channel`。
- `src/main/ipc/ai-handlers.test.ts`——`IPC.aiChunk` → `C.aiChunk.channel`。

**新增：**

- `src/preload-api.ts`——`createApi` + `invoker` + `PreloadDeps` + `RendererApi`。
- `src/preload-api.test.ts`（preload 覆盖）、`src/main/ipc/bindings-coverage.test.ts`（handler 覆盖）。

**不动：** 10 个 renderer 文件（`window.api` 形状不变）、各 domain 业务纯函数与 input schema 定义、DB 层。

## 7. 成功判据 / 非目标

**成功判据：**

- 新增一个通道 = 在 `C` 加一条 + 写 handler fn + 在 `createApi` 加一行 `inv(C.x)`；通道名/校验/类型全单一源，编译期 + 测试双重防漏接。
- `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿；现有 renderer 行为零变化（`window.api` 形状与运行时语义不变）。
- `pnpm start` 手测：导入/读/选/问/标注/设置端到端正常；`ai:chunk` 流式、`sendSync` 首帧快照、`pathForFile` 拖拽导入均正常。

**非目标（本轮不做）：**

- output 运行时校验 / 给通道补 output Zod schema（output 用幽灵类型载体，保持现状不校验）。
- 改 renderer、改 IPC 契约语义本身、合并 domain input schema 定义（仍留各 domain 文件）。
- 方案一的「派生整个 preload」。

## 8. 风险与权衡

- **`C.x.channel` 比 `IPC.x` 略长**：仅 5 处特殊通道手写处受影响；换来彻底单一源，值得。
- **`createApi` 注入依赖的间接层**：非为注入而注入——它让 preload 首次成为 headless 可走树验证的纯函数（与 `app-service.ts` 同哲学），是 §5.2 漂移测试的前提。
- **`bind`/`register` 拆分**：被 `ELECTRON_RUN_AS_NODE` 下 `ipcMain` 为 `undefined` 的运行时约束逼出（已实测），但顺势让注册变纯数据可测、更声明式——是约束变红利。
- **幽灵类型 `Out<O>`**：纯类型层，无运行时足迹；`InferOut` 提取 `O` 约束 handler 返回值与 preload 返回类型。
