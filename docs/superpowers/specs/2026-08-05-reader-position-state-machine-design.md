# ePub 阅读位置状态机 · 设计文档

> 状态：设计已评审通过，待 `writing-plans` 出实现计划。
> 日期：2026-08-05
> 关联：`2026-06-03-reader-precision-memory-pass-design.md`（本文要收口的隐式状态即由该轮及其后续修复逐层叠加而来）。

## 背景与目标

阅读时偶发「位置跳动」。排查过程中发现真正的障碍不是某个具体缺陷，而是**位置控制逻辑没有单一真相源**：状态散落在 `EpubReader` 与 `VirtualDocs` 的 6 个 ref / 4 个 useState 中，分布在 15 处以上的赋值点，且副作用（清标志、发滚动、存进度）与状态变化交织在各个调用点内部。任何一次跳动都难以回答「此刻处在哪个阶段、是谁把位置改掉的」。

本设计把这些隐式状态收口成**两台显式状态机**，为后续排查建立可观测、可单测的基础。

**成功判据**（四项，全部为用户确认的验收标准）：

1. **状态迁移可 headless 单测**：迁移逻辑是纯函数，vitest 直接断言，不依赖 DOM 或 React。
2. **迁移可观测**：每次迁移经 logger 落盘（事件名、新旧状态、产生的效果）。
3. **非法迁移不可表达**：用判别联合让「恢复目标」只存在于恢复状态内部，杜绝当前真实存在的「已跟随但恢复目标非空」组合。
4. **单一权威写入点**：状态只能经 `dispatch(event)` 改变，组件内不再有直接赋值。

**验证方式**：迁移规则走 vitest 纯函数单测；手感（开书恢复不跳、跳章跟手、进度确实在存）走真书手测，与 `2026-06-03` 那轮的验证约定一致。

## 范围

**在范围内**：ePub 的位置控制状态 —— `EpubReader` 的恢复门（L2）与 `VirtualDocs` 的导航/收敛状态（L3）。

**不在范围内**：

- **L4 高度测量机**（`SectionFrame` 的测量生命周期与 `heightCache`）。已知两条与跳动相关的缺陷留在此处：`measure()` 只写 DOM 不回写 `heightCache`（`reportStable` 之后的真实高度变化会在下次重渲被旧缓存值覆写回去）；`styleCss` 变化清空全表估高（跟随系统的明暗切换会在用户无操作时触发全局估高突变）。二者留待本次重构落地后单独排查 —— 届时有了迁移日志，可直接区分跳动来自定位机还是测高机。
- **PDF 侧**。`PdfReader` 的定位模型（页码 + 滚动比）与 ePub（CFI + section）差异过大，抽象成本不划算。
- 滚动手感参数（`OVERSCAN_PX`、`KEEP_DISTANCE`、收敛窗口时长等）一律沿用现值。

**行为变更口径**：等价重构 + 修明确缺陷。不主动调整手感参数；但重构后「一看就是错的」的缺陷（收敛超时后恢复门永不释放、`advanceRestoreGate` 的死形参）随结构改动一并消失。

## 现状与根因

### 当前的四层隐式状态

| 层              | 位置                  | 状态载体                                                                                                                                                                   |
| --------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 会话生命周期 | `EpubSessionProvider` | `book` / `parseError` / `bytesMissing`                                                                                                                                     |
| L2 位置恢复门   | `EpubReader`          | `restoredRef` / `restoreTargetIndexRef` / `topChapterIdRef`                                                                                                                |
| L3 定位收敛     | `VirtualDocs`         | `cancelScrollRef` / `loadedFromIndex` / `rangeLoadingEnabledRef` / `userNavigationStarted`，加 `scroll-convergence.ts` 闭包内的 `attempts` / `successStreak` / `cancelled` |
| L4 高度测量     | `SectionFrame`        | 每 section 一套 `settled` / `ro` / `roTimer` / `readyTimeout`                                                                                                              |

L1 已经足够清晰，不动。L4 不在本次范围。本设计处理 L2 与 L3。

### 与本次重构直接相关的结构性缺陷

**恢复门存在吸收态。** `advanceRestoreGate`（`src/renderer/reader/epub-progress-restore.ts`）只要 `target != null` 就恒返回 `shouldPersist: false`，形参 `_visibleIndex` 从未被使用。清空 `restoreTargetIndexRef` 的路径只有两条：收敛成功回调，或用户导航。而 `startScrollConvergence` 的超时分支（`VirtualDocs.tsx:169`）只打一条裸 `console.warn`，**不调用 `onSettled`**。于是冷启大书收敛超时（30 秒）后，若用户此后只用侧栏或 TTS 跳转而不手动滚动，恢复门永不释放，全程不保存进度 —— 下次开书回到旧位置，用户感知为「位置跳回去了」。

**副作用与状态变化解耦不足。** `restoreTargetIndexRef` 有 6 处赋值点，`loadedFromIndex` 有 2 处，分散在跳章 effect、内链处理、TTS 回调、标注跳转、`onUserNavigation`、`onTopSectionChange` 中。漏清或重复清没有任何机制能发现。

**调用来源靠隐式约定反推。** `scrollToSectionElement` 内用 `if (!onSettled)` 判断「这次是恢复还是用户跳转」，据此决定是否设置 `userNavigationStarted`。约定不在类型里，读代码时需要回溯全部调用点才能理解。

## 方案总览

**双状态机 + 显式结果契约**（用户已选定）。实现载体为**手写纯 reducer + 效果描述**，零新依赖，与仓库主进程既有的「纯业务函数 + 胶水层注入」模式同构。

### 两台机的职责边界

|                | 视口所有权机（L3）                                                                                                               | 阅读位置机（L2）                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 所在包         | `packages/virtual-docs`                                                                                                          | `src/renderer/reader`                                                          |
| 回答           | 此刻谁拥有视口，定位收敛到哪一步                                                                                                 | 这本书的阅读位置处在生命周期哪个阶段                                           |
| 认识的概念     | index、像素、DOM 几何                                                                                                            | CFI、章节、进度百分比                                                          |
| 吸收的现有状态 | `cancelScrollRef`、`loadedFromIndex`、`rangeLoadingEnabledRef`、`userNavigationStarted`，及 `scroll-convergence.ts` 全部内部状态 | `restoredRef`、`restoreTargetIndexRef`，及 `epub-progress-restore.ts` 整个模块 |

`virtual-docs` 依然不认识 CFI 与进度，包边界不变。

### 统一的 reducer 签名

```ts
(state: S, event: E) => { next: S; effects: Effect[] }
```

reducer 内不碰 DOM、不起计时器、不调 store。所有副作用以数据形式返回，由执行器统一施行。这是四项成功判据能同时成立的机制：跳动 bug 的本质是副作用散落在状态变化的各调用点内部，把副作用变成 reducer 的**输出**而非**内部动作**，漏做与重复做就成了单测可见的事实。

### 接缝契约：三态结果

```ts
// 现状
scrollToSectionElement(index, resolveEl, onSettled?: () => void): void
//                                        ↑ 超时时永不调用，仅 console.warn

// 目标
scrollToSectionElement(
  index: number,
  resolveEl: (doc: Document) => Element | null,
  opts: { owner: "restore" | "user" },
): Promise<"settled" | "timeout" | "cancelled">
```

三种终态都 resolve（`cancelled` 也是正常 resolve，不 reject）。renderer 一律 `dispatch({ type: "RESTORE_FINISHED", result })`，三种 result 在 reducer 中都迁移到 `following`。

这是「恢复门永不释放」的结构性修复：`restoring` 的每条出边都通向 `following`，模型中没有吸收态。`opts.owner` 取代 `if (!onSettled)` 的隐式反推 —— 恢复不计作用户导航（保持顶部 overscan 为 0），用户跳转计。

这是 `VirtualDocs` 公开 API 的破坏性变更；当前唯一消费方是 `EpubReader`，影响可控。

## 详细设计

### L3 视口所有权机

落点 `packages/virtual-docs/src/viewport-machine.ts`。有限状态 + 上下文（context 存跨状态记忆的累积值）：

```ts
type Phase =
  | { kind: "systemOwned" }
  | {
      kind: "aligning";
      runId: number;
      target: number;
      owner: "restore" | "user";
      attempts: number;
      streak: number;
    }
  | { kind: "userOwned" };

interface Ctx {
  loadedFromIndex: number;
  everUserNavigated: boolean;
}
```

状态语义：

- `systemOwned` —— 视口由系统控制且当前无收敛任务：首次挂载等 `initialIndex` 落位、命令式跳转（`scrollToIndex`）已发出、或收敛已结束而用户尚未接管，三种情形行为完全一致（`rangeLoadingEnabled` 为假，`VISIBLE_TOP_CHANGED` 不推进 `loadedFromIndex`），故合为一态。
- `aligning` —— `scrollToSectionElement` 的收敛进行中。
- `userOwned` —— 用户已产生滚动意图，拥有视口。

初始状态为 `systemOwned`。

两个衍生值不再单独存储，改为从状态算出：

- `rangeLoadingEnabled` ≡ `phase.kind === "userOwned"`
- `overscanTop` ≡ `initialIndex > 0 && !ctx.everUserNavigated ? 0 : OVERSCAN_PX.top`

`everUserNavigated` 是只进不退的锁存位，等价于现状中一旦置真便不再回落的 `userNavigationStarted`；故把 `overscanTop` 从存储值改成派生值不改变行为。

迁移表：

| 事件                               | 迁移                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALIGN_REQUESTED { index, owner }` | \* → `aligning`（分配新 `runId`）；`loadedFromIndex = min(cur, index)`；`owner === "user"` 时置 `everUserNavigated`                                                                                                   |
| `JUMP_REQUESTED { index }`         | \* → `systemOwned`；同样累积 `loadedFromIndex` 与 `everUserNavigated`                                                                                                                                                 |
| `ALIGN_TICK { runId, aligned }`    | `runId` 不匹配则丢弃；否则 `aligning` 内累加 `attempts` / `streak`；`attempts ≥ 60 && streak ≥ 5` → `systemOwned` + `reportAlignResult("settled")`；`attempts ≥ 300` → `systemOwned` + `reportAlignResult("timeout")` |
| `USER_INPUT { scrollIntent }`      | \* → `userOwned`；若原状态为 `aligning` 则发 `reportAlignResult("cancelled")`；`scrollIntent` 为真时置 `everUserNavigated`                                                                                            |
| `VISIBLE_TOP_CHANGED { index }`    | 仅 `userOwned` 下 `loadedFromIndex = min(cur, index)`                                                                                                                                                                 |

效果集合：`scrollToIndex(index, offset?)`、`startTicker(runId)`、`stopTicker`、`reportAlignResult(result)`、`recomputeTop`。

`scroll-convergence.ts` 整个删除：`minimumAttempts: 60` / `successesRequired: 5` / `maxAttempts: 300` 从计时器闭包里的可变变量，变成 reducer 中三行可直接单测的判断。计时器只剩「每 100ms 派一个 `ALIGN_TICK`」这一件事。收敛的窗口时长与判定阈值均沿用现值。

### L2 阅读位置机

落点 `src/renderer/reader/reading-position-machine.ts`：

```ts
type State =
  | { kind: "loading" }
  | { kind: "restoring"; targetIndex: number; locator: string }
  | { kind: "following" };
```

`targetIndex` / `locator` 只存在于 `restoring` 分支 —— 当前真实存在的「已跟随但恢复目标非空」组合在类型上不可表达（成功判据 3）。

迁移表：

| 事件                                   | 迁移                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SESSION_READY { locator, index }`     | `loading` 下：有 locator → `restoring` + `restoreToCfi`；无 → `following`。**非 `loading` 时忽略**（取代 `restoredRef`，天然免疫 progress 缓存回写触发的二次恢复） |
| `RESTORE_FINISHED { result }`          | `restoring` → `following`（`settled` / `timeout` / `cancelled` 同迁移）                                                                                            |
| `USER_NAVIGATED`                       | `restoring` / `following` → `following`                                                                                                                            |
| `CHAPTER_REQUESTED { chapterId }`      | `loading` 忽略；否则 → `following` + `scrollToChapter` + `notifyTtsUserNavigation`                                                                                 |
| `ANNOTATION_SCROLL { locator }`        | `loading` 忽略；否则 → `following` + `restoreToCfi` + `notifyTtsUserNavigation`                                                                                    |
| `TOP_SECTION_CHANGED { index, ratio }` | 恒发 `reportPosition`；**仅 `following` 追加 `persistProgress`**                                                                                                   |
| `BOOK_CHANGED`                         | \* → `loading`                                                                                                                                                     |

「是否允许持久化进度」由 `state.kind === "following"` 派生，`advanceRestoreGate` 与 `epub-progress-restore.ts` 一并删除。

不设独立的 `navigating` 状态：命令式跳转期间进度照常持久化（与现行为一致），跳转的定位重试由 L3 负责，L2 无需重复建模。

`topChapterIdRef`（防跳章回环）不属于位置状态机 —— 它是「最近一次由滚动得出的顶部章」这一观测值的缓存，保留为 `EpubReader` 内的 ref，但其唯一读取点（跳章判断）改为在派发 `CHAPTER_REQUESTED` 前过滤，不进入 reducer。

### 效果执行与竞态

两侧各一个薄执行器 hook，唯一职责是执行 effects 并把结果回喂成事件：

```ts
// packages/virtual-docs/src/use-machine.ts
const [state, raise] = useMachine(machine, init, runEffect, onTransition);
```

`useMachine` 约 20 行：`useReducer` 取 `{ next, effects }`，在 `useEffect` 中顺序执行 effects，并把每次迁移交给 `onTransition` 打点。计时器、`vRef.current.scrollToIndex()`、`window.api.progress.save()`、`setReadingContext()` 等全部只出现在 `runEffect` 里。组件内不再有任何状态赋值语句（成功判据 4）。

两台机共用这一个 hook，故 `useMachine` 经 `packages/virtual-docs/src/index.ts` 导出，renderer 从 `@marginalia/virtual-docs` 导入。它只依赖 React，不含任何 DOM 或领域知识。

**几何计算归属**：reducer 不接触 DOM，故「本次尝试是否已对齐」由 L3 执行器计算 —— 每 100ms 读 iframe 与 scroller 的 `getBoundingClientRect()`，得出 `aligned`（`|delta| ≤ 4`）与下一次的 `offset`，连同 `runId` 一起 `raise({ type: "ALIGN_TICK", runId, aligned })`。当前 `attempt()` 里「目标 iframe 未挂载时重发 section 级定位」的分支同样留在执行器：元素不可解析时上报 `aligned: false`，reducer 照常产出 `scrollToIndex` 效果。

**Promise 的兑现**：`scrollToSectionElement` 返回的 Promise 由 L3 执行器持有其 `resolve`，在处理 `reportAlignResult(result)` 效果时兑现并清空。因 `restoring` 的每条出边都产出该效果，Promise 不存在悬挂路径。

**runId 竞态**：`ALIGN_TICK` 携带 `runId`，reducer 首行丢弃不匹配者，旧收敛的在途计时器无法污染新一轮定位。这是纯逻辑，可直接单测。

**持久化竞态**：`persistProgress` 的 1 秒 debounce 留在执行器中，但到期后重新读当前 state，非 `following` 则丢弃 —— 消除「排队中的保存落在恢复期」的窗口。

**进度缓存回写**：`qc.setQueryData(qk.progress(bookId), …)` 现只写 `locator`、抹掉 `percent`。执行器改为合并写入（保留原对象其余字段）。

### 日志

`virtual-docs` 是独立包，不能 import `@renderer/logger`。加一个可选 prop 注入诊断出口：

```ts
onTransition?: (r: {
  event: string;
  from: string;
  to: string;
  effects: string[];
}) => void;
```

`EpubReader` 传 `(r) => log.debug("viewport transition", r)`（`createLogger("epub")`，符合仓库日志规范：无 `[xxx]` 前缀、无尾冒号）。L2 侧直接在 `useMachine` 内打点。包不引依赖，诊断照样落盘。

现有的 `console.warn("[virtual-docs] … did not converge")` 换成经 `onTransition` 上报的 `timeout` 迁移记录 —— 超时不再是只在 DevTools 里一闪而过的裸 console。

日志级别取 `debug`（仅 dev 落盘）：跳动为本地可复现问题，无需在生产常驻这类高频记录。

### `document.querySelector(".no-scrollbar")` 的耦合

`EpubReader.tsx:256` 与 `tts/tts-controller.ts:35` 都靠全局类选择器取滚动容器。当前 DOM 顺序下 `NoteModal` / `NoteHoverCard`（同样带该类）排在 reader 之后，结果正确；但只要浮层改用 portal 挂到 body 前部，或 reader 上方新增滚动容器，`targetInDoc` 就会算错并写入错误 CFI。

本次顺带收口：`VirtualDocs` 通过 `getScrollerElement(): HTMLElement | null` 暴露真实 scroller，`EpubReader` 与 `ttsController` 改从此处取，删除两处全局查询。这属于「重构中改进所工作的代码」，与位置状态机同一处逻辑，不算范围外重构。

## 测试策略

新增两个 headless 测试文件。以下用例直接钉住已知缺陷或关键不变量：

`reading-position-machine.test.ts`

- `restoring` + `RESTORE_FINISHED{ timeout }` → `following`，且此后 `TOP_SECTION_CHANGED` 产出 `persistProgress`（钉住「恢复门永不释放」）。
- `restoring` + `USER_NAVIGATED` → `following`。
- `loading` 下 `CHAPTER_REQUESTED` 不产生任何 effect（旧章节跳转不抢在 `initialIndex` 之前）。
- 非 `loading` 状态下 `SESSION_READY` 不产生任何 effect（progress 缓存回写不触发二次恢复）。
- `restoring` 下 `TOP_SECTION_CHANGED` 只产出 `reportPosition`，不产出 `persistProgress`。

`viewport-machine.test.ts`

- 从 `aligning` 迁回 `systemOwned` 需要 `attempts ≥ 60` 且 `streak ≥ 5`；中途一次未对齐会清零 streak。
- `attempts` 达 300 产出 `reportAlignResult("timeout")`。
- `aligning` 中收到 `USER_INPUT` → `userOwned` 且产出 `reportAlignResult("cancelled")`。
- 旧 `runId` 的 `ALIGN_TICK` 不推进 `attempts`。
- `loadedFromIndex` 单调不增；`everUserNavigated` 只进不退。
- `VISIBLE_TOP_CHANGED` 在非 `userOwned` 状态下不改 `loadedFromIndex`。

`precision.ts` 的既有纯函数（`topVisibleIndex` / `sectionsToUnload` / `calibratedEstimate`）及其测试完全不动。`scroll-convergence.test.ts` 的用例迁移进 `viewport-machine.test.ts`。

手测清单（真书）：冷启深处恢复不跳、侧栏跳章跟手、标注跳转精确、TTS 跳转正常、关书重开位置正确、切换明暗主题后位置不变（后者若仍跳，即坐实根因在 L4，可据日志确认）。

## 文件落点

| 动作 | 文件                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| 新增 | `packages/virtual-docs/src/viewport-machine.ts` + `viewport-machine.test.ts`                                              |
| 新增 | `packages/virtual-docs/src/use-machine.ts`（两台机共用，经包入口导出）                                                    |
| 改写 | `packages/virtual-docs/src/index.ts`（导出 `useMachine` 及其类型）                                                        |
| 新增 | `src/renderer/reader/reading-position-machine.ts` + `reading-position-machine.test.ts`                                    |
| 新增 | `src/renderer/reader/use-reading-position.ts`                                                                             |
| 删除 | `packages/virtual-docs/src/scroll-convergence.ts` + `scroll-convergence.test.ts`                                          |
| 删除 | `src/renderer/reader/epub-progress-restore.ts` + `epub-progress-restore.test.ts`                                          |
| 改写 | `packages/virtual-docs/src/VirtualDocs.tsx`（去掉 4 个 state/ref，改用机器；新增 `getScrollerElement` 与 `onTransition`） |
| 改写 | `src/renderer/reader/EpubReader.tsx`（位置逻辑外迁，预计 449 行降至 300 行出头）                                          |
| 改写 | `src/renderer/reader/tts/tts-controller.ts`（scroller 改由注入获取）                                                      |

## 决策记录

- **双状态机而非单一状态机**：保持 `virtual-docs` 的 store-agnostic 边界（它不该认识 CFI 与进度），且两台机各自都能纯函数单测。备选「单机下沉到 renderer」弃用：renderer 将直接操作 scroller / iframe 几何，`virtual-docs` 失去自足性。备选「单机上提到 virtual-docs」弃用：进度持久化、章节高亮等业务语义会渗进通用包。
- **手写 reducer 而非 XState**：两台机各 3–4 个状态，引入约 40KB 依赖与一套 DSL 不划算；仓库无状态机库先例，且与 React Compiler 的交互未经验证。
- **effects 作为 reducer 返回值**：这是四项成功判据同时成立的机制，也是对当前「副作用散落各调用点」这一根因的直接回应。
- **渐进开放状态并入 L3 而非独立成机**：`loadedFromIndex` / `rangeLoadingEnabled` / `userNavigationStarted` 本质是「视口所有权归谁」的投影，与收敛机总是同时迁移，独立成机只会多一层协调。
- **L4 高度测量机不在本次范围**：先建立可观测性，再据日志区分跳动来源。若与本次重构合并，回归面覆盖 `virtual-docs` 核心渲染路径，风险不匹配收益。
