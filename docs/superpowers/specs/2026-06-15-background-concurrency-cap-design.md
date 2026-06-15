# 后台模型调用全局并发上限 — 设计

- 日期：2026-06-15
- Issue：[#18](https://github.com/EurFelux/marginalia/issues/18) Global concurrency cap for background model calls
- 类型：enhancement · area:ai · area:settings

## 目标

给所有**后台模型调用**加一个全局并发上限，缓解 provider 额度/速率压力。后台调用＝四处 fire-and-forget、共用 `resolveSummaryModel` 的调用：

1. `ensureChapterSummary`（章节摘要，`generateText`）— 开章自动 / pill 手动触发
2. `ensureBookSummary`（全书摘要，`streamText`）— 书卡按钮触发
3. `nameConversation`（会话自动命名，`generateText`）— 首轮完成后
4. `maybeCompactConversation`（上下文压缩，`generateText`）— 每轮完成后

并发数由一个新的可持久化 preference 控制（默认 3），并在 Settings「高级」面板暴露数字输入控件。达上限时超出的调用**排队等待（FIFO）**，有空位再放行。

## 不可破契约：前台对话永不入限流器

用户面向的聊天流式回复 `streamAssistantReply`（`stream-assistant.ts`）**完全不接 `runBackground`、永不进限流器队列**。这是结构性保证而非配置：用户发消息时前台调用立即发起，绝不排在后台摘要之后等槽。对话对摘要拥有绝对最高优先级。

唯一残留为 provider 侧速率竞争（cap=3 时 3 后台 + 1 前台瞬时 4 并发打到 provider），对绝大多数 provider 无影响，且 cap 本身已大幅缓解；不再额外做「前台活跃时暂停后台」（用户决策，YAGNI）。

## 非目标（YAGNI）

- **不**做「不限制」档（0）：`backgroundConcurrency` 必为正整数；0 = 摘要永不跑＝坑。
- **不**做「前台活跃时暂停后台」的硬优先级（见上，纯豁免已满足要求）。
- **不**为前台聊天回复设上限或让其入队。
- **不**做队列上限丢弃 / 优先级队列：FIFO 即可（同项去重已防同一章/书/会话重复排队）。
- **不**引入 `p-limit` 等第三方并发库：手写 ~30 行纯 `Limiter`，可单测、支持运行时改并发数。
- **不**为限流单独做可视化/进度展示。

## 一、Preference（`src/shared/preferences.ts`）

```ts
/** 后台模型调用（章节/全书摘要 + 会话命名 + 上下文压缩）的全局并发上限。正整数；无「不限制」档（0=摘要永不跑＝坑）。 */
export const backgroundConcurrencySchema = z.number().int().positive();

/** backgroundConcurrency 缺省值：主进程兜底与渲染层初值共用单一源。 */
export const DEFAULT_BACKGROUND_CONCURRENCY = 3;
```

- 注册进 `PREFERENCE_SCHEMAS`：`backgroundConcurrency: backgroundConcurrencySchema`
- 补 `setPreferenceInput` 判别联合 arm：`z.object({ key: z.literal("backgroundConcurrency"), value: backgroundConcurrencySchema })`
- schema 仅约束「正整数」（不设上界），UI 侧 clamp 到 `[1, 10]`（>10 并发模型调用收益低且易撞 rate limit），与 `stepLimit`「schema 宽松、UI 收敛」一致
- `preferences:set` handler（`preferences-handlers.ts`）补 `case "backgroundConcurrency": return setPreference(...)`（穷尽性守卫会强制此 case）

## 二、Limiter（新 `src/main/ai/background-limiter.ts`，纯类）

```ts
export type RunBackground = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * 全局并发限流器：同时放行的任务数不超过 getLimit() 返回值，超出的排队（FIFO），有空位再放行。
 * 纯类，无 Electron/DB 依赖，可独立单测。getLimit 每次放行时实时读取——调小立即对「新启动」生效，
 * 调大在下一次 run/settle 触发 pump 时生效（绝不杀正在跑的任务）。
 */
export class Limiter {
  constructor(private readonly getLimit: () => number) {}
  private active = 0;
  private readonly queue: Array<() => void> = [];

  run: RunBackground = (fn) =>
    new Promise((resolve, reject) => {
      const attempt = () => {
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.pump();
          });
      };
      if (this.active < this.getLimit()) attempt();
      else this.queue.push(attempt);
    });

  private pump(): void {
    while (this.queue.length > 0 && this.active < this.getLimit()) this.queue.shift()!();
  }
}
```

**进程单例**在 `send-deps.ts` 装配，`getLimit` 惰性实时读 preference（模块加载期不碰 `getDb`）：

```ts
const backgroundLimiter = new Limiter(
  () => getPreference(getDb(), "backgroundConcurrency") ?? DEFAULT_BACKGROUND_CONCURRENCY,
);
```

## 三、注入与包裹边界（四个调用点）

`runBackground: RunBackground` 作为**必填**字段加入三个 deps 接口（漏注入＝TS 编译报错，不会静默不限流）：

- `SummaryDeps`（`summary.ts`）— 供 `ensureChapterSummary` / `ensureBookSummary`
- `NamingDeps`（`conversation-title.ts`）— 供 `nameConversation`
- `CompactionDeps`（`context-compaction.ts`）— 供 `maybeCompactConversation`
- `SendDeps`（`send.ts`）也加 `runBackground`：`makeSendDeps()` 注入 `backgroundLimiter.run`，`stream-assistant.ts` 把 `deps.runBackground` 透传给内联构造的 `NamingDeps` / `CompactionDeps`
- `makeSummaryDeps()` 注入 `backgroundLimiter.run`

**包裹原则**：同步「claim `inFlight`」前缀**留在槽外**（保证排队期间状态即时派生为 `generating`——队列中的项 UI 显示「生成中」是诚实的）；只有「喂模型所需的加载 + 模型调用」进槽：

| 调用点                     | 槽外（前缀）                                       | 槽内（`runBackground`）                                                        | 槽外（后续）                         |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| `ensureChapterSummary`     | dedup 检查 + DB 读 + resolveModel + claim inFlight | `loadBytes` + `readChapterText` + `generateText` → 返回 text                   | 空判 + 落库                          |
| `ensureBookSummary`        | dedup + claim inFlight                             | `loadBytes` + `readBookText` + `streamText` 全程累积 partial（整段流期间持槽） | 空判/错误判 + 落库                   |
| `nameConversation`         | dedup + resolveModel + claim inFlight              | `generateText` → 返回 text                                                     | sanitize + 复查 title 仍 null + 落库 |
| `maybeCompactConversation` | dedup + DB 读 + `planFold`（本地廉价）             | `generateText` → 返回 text                                                     | 空判 + 复查会话仍在 + 落库           |

- 章节/全书摘要把 `loadBytes`+解析放进槽内，避免快速翻几十章时几十个 epub 同时解析；命名/压缩的本地 DB 读/规划留槽外、不占槽。
- 各函数现有 try/catch/finally 不变：`await runBackground(fn)` 中 fn reject 时 runBackground reject、被原 catch 兜住；finally 仍清 inFlight。

## 四、渲染层 UI（数字设置，仿 `stepLimit`）

- **`prefs-store.ts`**：`PrefsState` 加 `backgroundConcurrency: number`；`PREFS_INITIAL` 设 `DEFAULT_BACKGROUND_CONCURRENCY`；加 `setBackgroundConcurrency` action（`persistPreference({ key: "backgroundConcurrency", value }) + set`）
- **`hydrate-preferences.ts`**：`if (snap.backgroundConcurrency !== undefined) usePrefsStore.setState({ backgroundConcurrency: snap.backgroundConcurrency })`
- **`settings-logic.ts`**：`clampBackgroundConcurrency(raw)` → `[1, 10]` 整数，非有限值（空输入/NaN）回退 `DEFAULT_BACKGROUND_CONCURRENCY`（带单测）
- **`AdvancedSettings.tsx`**：在「单次回复最多步数」附近加一行数字 `Input`（`type="number" min={1} max={10}`，**无**「不限制」复选框），label + desc 走 `t()`
- **i18n**：加 `settings.advanced.backgroundConcurrency` + `settings.advanced.backgroundConcurrencyDesc` 两个 key，跑 `pnpm i18n:extract`
  - desc 草拟：「同时进行的后台 AI 任务（章节/全书摘要、会话命名、长对话压缩）数量上限。调低可缓解额度/速率压力；不影响你正在进行的对话回复。」

## 五、测试策略（全部无头 vitest）

- **新 `background-limiter.test.ts`**（纯 Limiter）：
  - 并发数不超 `getLimit()`（用可控 deferred promise，断言 active 峰值）
  - FIFO 放行顺序
  - `fn` reject 透传，且不卡死后续队列（reject 后空位仍放行下一个）
  - 运行时调小/调大 limit 的行为（调小后新启动受新值约束；调大后下次 settle/run 放行更多）
- **新增一条 wiring 断言**（择一调用点，如 chapter summary）：注入 `new Limiter(() => 1)` + 两个并发请求 + 受控 model，断言第二个被推迟到第一个完成后才启动——证明 cap 真生效
- **更新现有调用点测试**（`summary.test.ts` / `conversation-title.test.ts` / `context-compaction.test.ts` / `send.test.ts` / `send-deps.test.ts`）：deps 注入 pass-through `runBackground: (fn) => fn()`（必填字段，机械补齐），不改其断言语义
- **preferences 测试**（shared schema + `repository.test.ts`）：补 `backgroundConcurrency` key 的校验 round-trip + 穷尽性
- **`prefs-store.test.ts` / `settings-logic.test.ts`**：新 action 落盘、`clampBackgroundConcurrency` 边界

## 六、验证与收尾

- `pnpm typecheck && pnpm lint && pnpm test`（全绿）
- `pnpm i18n:extract` 后 `pnpm i18n:lint`（key 不缺漏）
- 写一条 `pnpm changeset`（英文用户向 changelog）
- commit 末尾 `closes #18`；kanban 卡 In progress → 合并/关 issue 后自动挪 Done
