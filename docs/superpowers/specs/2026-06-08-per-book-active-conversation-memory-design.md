# 每本书记忆上次 active 会话 + 修复切书会话残留 + activeConversationId 派生化设计

日期：2026-06-08
状态：待与用户对齐（2026-06-08 brainstorming；含 activeConversationId 派生化修订），待实现
关联：用户报告 bug「切换书籍后，上本书的会话仍残留在 AIPanel 中」+ 需求「应用记住每本书上次 active 的是哪个会话」+ 架构观察「activeConversationId 是 reader 局部状态，不该全局」。三者同根，本设计一并处理。另有更大的「chat-store / store 层设计审查」议题（reader 瞬态作用域、draft 跨书/持久策略等），**单列、不在本设计内**（§9）。

## 1. 背景与动机

### 1.1 Bug：切书后上本书会话残留

`chat-store.openCommand` 是「一次性命令信号」（`{ conversationId, nonce }`，nonce 递增触发 `AIPanel` 载入该会话历史），与「当前 active 会话」解耦——好处是发消息路径只设 active、不发命令，避免发完消息误重载历史。

但 `openCommand` 在整个 codebase 中**只有写入、从无清空**：仅 `openConversation` / `restoreConversation` 设新值，没有任何地方设回 `null`。它是全局 zustand 单例，不随组件卸载重置。`navigation-store.openBook` 的跨 store 协调只清了 `activeConversationId`（`setActiveConversation(null)`），**漏清 `openCommand`**。

残留时序（书 A → 书库 → 书 B，且书 B 无会话）：

1. 读书 A 时 `convA` 经 `openCommand={convA, nonce:N}` 载入；
2. 回书库 → `view=library` → `ReaderView`/`AIPanel` 卸载，但 `chat-store` 全局存活，`openCommand` 仍指 `convA`；
3. 开书 B → `openBook` 清 active（`openCommand` 不动）→ `view=reader` → `AIPanel` 全新挂载；
4. `AIPanel` 挂载，`openCommand` effect 立即用残留值异步 `listByConversation(convA)` → `setMessages(convA 历史)`；
5. `active===null` effect 同步 `setMessages([])`，但第 4 步异步 resolve 晚于它 → `convA` 历史覆盖空数组；
6. `useRestoreConversation(bookB)` 异步返回空（书 B 无会话）→ 仅置空 active，**无新 openCommand 覆盖** → **书 A 会话残留**。

（书 B 有会话时，`restoreConversation` 发新 `openCommand` 覆盖，但仍有「先闪书 A 再被书 B 替换」的竞态闪烁。）

**根因**：`openCommand` 这一 reader 瞬态命令信号，在切书边界缺少清理点。修复＝切书时清它（§4.3）。

### 1.2 需求：记住每本书上次 active 的会话

现状 `useRestoreConversation` 开书时取该书 `listByBook` 的 **`updatedAt` 最新**会话装入——用「最近**更新**的会话」近似「上次看的」。缺口：用户在某书翻看的是**较旧**会话 conv2（未发消息、`updatedAt` 没动），切走再回来会被恢复成「最新的 conv3」而非「上次正看的 conv2」。

### 1.3 关键定性：这是视图状态，不是领域数据

「每本书上次看哪个会话」本质是 UI/视图记忆（类比「上次打开哪个标签页」），**不属于用户领域数据**。结论：

- 不进 `conversations`/`books` 领域表，不加迁移、不加 IPC；
- 放渲染层 `chat-store`，用 **zustand `persist` middleware** 落 localStorage 跨重启持久（主进程完全无感）。

### 1.4 顺带纠正：`activeConversationId` 的作用域

`activeConversationId` 现为 `chat-store` 全局字段，但它本质是 **reader 作用域**状态——`LibraryView` 根本不关心「当前看哪个会话」。有了 `activeByBook` 后，「当前 active」可直接**派生**：

```
当前 active = activeByBook[currentBookId] ?? null
```

故本设计**删除独立的 `activeConversationId` 字段**，改为派生：

- **`LibraryView` 态**（`currentBookId === null`）→ 派生天然为 `null`，library 自动「不持有」active；
- `setActiveConversation(id)` 退化为「写当前书的记忆槽」，与记忆写入**合一**，消除「两字段同步」隐患；
- 原先为规避「切书把新书记忆抹成 null」而设计的**顺序陷阱直接消失**（切书不再写 active）。

> **作用域的边界（重要）**：`openCommand` / `draftText` / `draftChips` / `summaryChips` 同为 reader 域，但 store 的本职正是承载「跨组件卸载/重挂仍存活」的 UI 状态——`draftText` 即是（切 tab、面板卸载重挂草稿不应丢失，是**有意设计**）。因此本次**不擅动** draft/chips 的作用域与生命周期，切书仅清修 bug 必需的 `openCommand`。「reader 瞬态是否该 reader-scoped、draft 切书是否清、是否持久」等属 **store 整体设计议题，单独审查**（§9）。

## 2. 决策摘要

| 决策点                 | 结论                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 记忆归属               | **渲染层 `chat-store`**，非主进程 DB——视图状态非领域数据                                                                        |
| 持久化机制             | **zustand `persist` middleware**（localStorage），`partialize` 仅持久化 `activeByBook`                                          |
| 数据结构               | **`activeByBook: Record<string, string \| null>`**；`null`=上次停在「将开新会话」空态，**缺键**=该书从无记忆                    |
| `activeConversationId` | **派生，不独立存储**：`= activeByBook[currentBookId] ?? null`；删 `chat-store` 字段；`library` 态派生 `null`                    |
| 派生访问               | `useActiveConversationId()` hook（组件）+ `getActiveConversationId()` getter（action/transport 非响应式语境）                   |
| 记忆写入时机           | **实时**——`setActiveConversation`/`openConversation`/`restoreConversation` 即写当前书槽（含同书内换会话）                       |
| 当前书定位             | `rememberSlot`/getter 惰性读 `useNavigationStore.getState().currentBookId`（双向 import，zustand 惰性 getState 安全）           |
| 失效校验               | 恢复时用 `listByBook` 校验记忆 id 仍存在（持久 id 可能已删）；失效则回落                                                        |
| `null` 空态语义        | **忠实还原**：上次停在新会话空态 → 切回还原 `active=null` + 预亮摘要 chips（用户拍板）                                          |
| 恢复优先级             | 命中记忆 > `null` 空态还原 > 回落 `listByBook` 最新 > 该书无会话（空态）                                                        |
| 切书重置范围           | `resetForBookSwitch()` **仅清 `openCommand`**（修 bug 必需）；`draftText`/`draftChips`/`summaryChips` **不动**（留 store 审查） |
| 顺序陷阱               | **消失**——派生后切书不写 active，无「抹掉新书记忆」之虞                                                                         |
| headless 测试兼容      | persist storage getter 对 `localStorage` 未定义降级为 `noopStorage`（vitest 跑 Electron node 运行时无 DOM）                     |
| 草稿持久化 / 作用域    | **本次不动**——draft 是「跨卸载存活」的有意设计，其切书/持久策略归 store 设计审查（§9）                                          |
| 主进程改动             | **零**——`listByBook` 复用，无新通道、无 schema/迁移                                                                             |

## 3. 数据模型（`chat-store`）

### 3.1 状态：`activeByBook` 取代 `activeConversationId`

```ts
interface ChatState {
  // 删除：activeConversationId（改为派生，见 §3.2）
  draftText: string;
  draftChips: Chip[];
  openCommand: { conversationId: string; nonce: number } | null;
  summaryChips: { chapter: boolean; book: boolean };
  /**
   * 每本书上次 active 的会话（视图记忆，唯一真相 + persist 持久化的唯一字段）。
   * 值 = 会话 id；null = 上次停在「将开新会话」空态；缺键 = 该书从无记忆（回落最新）。
   */
  activeByBook: Record<string, string | null>;
}
```

`CHAT_INITIAL.activeByBook = {}`（删 `activeConversationId`）。

### 3.2 派生访问（取代字段读取）

```ts
import { useNavigationStore } from "@renderer/store/navigation-store";

/** 组件用：当前 active 会话 = activeByBook[currentBookId]（派生）。 */
export function useActiveConversationId(): string | null {
  const bookId = useNavigationStore((s) => s.currentBookId);
  return useChatStore((s) => (bookId != null ? (s.activeByBook[bookId] ?? null) : null));
}

/** action / transport 等非响应式语境用。 */
export function getActiveConversationId(): string | null {
  const bookId = useNavigationStore.getState().currentBookId;
  return bookId != null ? (useChatStore.getState().activeByBook[bookId] ?? null) : null;
}
```

> `useActiveConversationId` 同时订阅两个 store：`currentBookId` 变 → 组件重渲染 → `useChatStore` selector 闭包用新 `bookId` 重算。React Compiler 已启用，勿手写 memo。

### 3.3 persist 包裹

```ts
import { persist, createJSONStorage } from "zustand/middleware";

// headless 测试（vitest 跑 Electron node 运行时）无 DOM，localStorage 未定义 → 降级 noop，
// persist 仅内存、不抛错；renderer 真实环境用 window.localStorage。
// 返回合法 Storage-like 对象（而非 undefined），不依赖 createJSONStorage 对 undefined 的内部处理。
const noopStorage: Storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};
const safeStorage = createJSONStorage(() =>
  typeof localStorage !== "undefined" ? localStorage : noopStorage,
);

export const useChatStore = create<ChatState & ChatActions>()(
  persist(
    (set) => ({
      /* …state/actions（§3.1 + §4）… */
    }),
    {
      name: "marginalia-chat",
      storage: safeStorage,
      partialize: (s) => ({ activeByBook: s.activeByBook }),
    },
  ),
);
```

> `partialize` 排除其余全部字段——尤其 **`openCommand` 绝不持久化**（一次性命令，持久化＝重启重放）。`localStorage` 不可用时 getter 返回 `noopStorage`，读写均 no-op（仅内存），不抛错。
>
> rehydrate：localStorage 同步 API，store 创建即同步灌入 `activeByBook`，`useRestoreConversation` 首跑时记忆已就绪，**无需** `hydratePreferences` 式手动 IPC 灌入。

## 4. 写入路径

### 4.1 remember helper

```ts
/** 写当前书的记忆槽；无当前书（library 态）则原样返回。 */
function rememberSlot(
  map: Record<string, string | null>,
  id: string | null,
): Record<string, string | null> {
  const bookId = useNavigationStore.getState().currentBookId;
  return bookId ? { ...map, [bookId]: id } : map;
}
```

> **循环 import 说明**：`navigation-store.ts` 顶层 import `useChatStore`，`chat-store.ts` 顶层 import `useNavigationStore`，构成双向 import。两个 store 的 `create(...)` 在模块顶层执行但**不解引用对方**（actions/getter 是惰性闭包，仅运行时 `getState()`），ESM live binding 保证运行期已就绪——zustand 标准用法，安全。

### 4.2 三个 action 写记忆槽（不再设独立 active 字段）

```ts
setActiveConversation: (id) =>
  set((s) => ({
    activeByBook: rememberSlot(s.activeByBook, id),
    // 置 null（删当前会话 / 无会话语境）：其载入命令也失效，顺带清
    ...(id === null ? { openCommand: null } : {}),
  })),

openConversation: (id) => {
  usePrefsStore.getState().updateLayout({ panelOpen: true });
  return set((s) => ({
    openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
    summaryChips: { chapter: false, book: false },
    activeByBook: rememberSlot(s.activeByBook, id),
  }));
},

restoreConversation: (id) =>
  set((s) => ({
    openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
    summaryChips: { chapter: false, book: false },
    activeByBook: rememberSlot(s.activeByBook, id),
  })),
```

既有调用点行为（写槽语义不变，无需各自改动）：

- `ipc-chat-transport.ts` 发消息懒建会话 `setActiveConversation(convo.id)` → 记新会话；
- `AIPanel.newConversation` 新建 `setActiveConversation(convo.id)` → 记新会话；
- `ConversationsTab` 删当前会话 `setActiveConversation(null)` → 槽置 null + 清 openCommand；
- `ConversationsTab` 点会话 `openConversation(id)` / `useRestoreConversation` 的 `restoreConversation(id)` → 记该会话。

### 4.3 切书重置：仅清残留命令信号

```ts
/** 切书重置：仅清残留的 openCommand（一次性命令信号），避免 AIPanel 重挂重放上本书会话。
 *  draftText/draftChips/summaryChips 等 reader 瞬态本次不动——其作用域属 store 设计审查议题（§9）。 */
resetForBookSwitch: () => set({ openCommand: null }),
```

`navigation-store.openBook` 把 `useChatStore.getState().setActiveConversation(null)` 改为 `useChatStore.getState().resetForBookSwitch()`：

- **清 `openCommand`** → 切书后 `AIPanel` 重挂不再重放上本书会话（修 bug 主因）；
- **不动 `activeByBook`** → 各书记忆保留；新书 active 由派生 + `useRestoreConversation` 决定；
- **不动 draft/chips** → 尊重其「跨卸载存活」设计；切书是否清留待 store 审查。

### 4.4 读取点改造（字段读 → 派生）

| 位置                           | 改前                                           | 改后                                                                        |
| ------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------- |
| `AIPanel`（active/标题/清空）  | `useChatStore((s) => s.activeConversationId)`  | `useActiveConversationId()`                                                 |
| `ConversationsTab`（高亮）     | `useChatStore((s) => s.activeConversationId)`  | `useChatStore((s) => s.activeByBook[bookId] ?? null)`（已有 `bookId` prop） |
| `ConversationsTab`（删除判定） | `s.activeConversationId === c.id`              | `getActiveConversationId() === c.id`                                        |
| `ipc-chat-transport`（懒建）   | `useChatStore.getState().activeConversationId` | `getActiveConversationId()`                                                 |

## 5. 读取/恢复路径（`useRestoreConversation`）

选择逻辑从「无脑取 `listByBook` 最新」改为「优先记忆、失效回落」。仍复用现有 `listByBook` IPC，**零主进程改动**。派生后不再读 `s.activeConversationId`，直接读真相 `s.activeByBook[bookId]`：

```ts
export function useRestoreConversation(bookId: string | null) {
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    void window.api.chat.conversations
      .listByBook({ bookId })
      .then((list) => {
        if (cancelled) return;
        const s = useChatStore.getState();
        const remembered = s.activeByBook[bookId]; // string | null | undefined
        const has = (id: string) => list.some((c) => c.id === id);

        if (typeof remembered === "string" && has(remembered)) {
          s.restoreConversation(remembered); // 命中：精确恢复上次正看的 + 载历史
        } else if (remembered === null) {
          // 忠实还原「上次停在新会话空态」
          s.setActiveConversation(null);
          s.setSummaryChipsPreset();
        } else if (list[0]) {
          s.restoreConversation(list[0].id); // 缺键/失效 → 回落最新（现状行为），并自愈记忆槽
        } else {
          s.setActiveConversation(null); // 该书从无会话
          s.setSummaryChipsPreset();
        }
      })
      .catch((err: unknown) => log.warn("restore conversation failed", err));
    return () => {
      cancelled = true;
    };
  }, [bookId]);
}
```

> 失效分支调 `restoreConversation(list[0].id)`，其 `rememberSlot` 会把失效槽自愈为 `list[0].id`。空态分支 `setActiveConversation(null)` 写槽 `null` + 清 `openCommand`，与 `resetForBookSwitch` 双保险。

边界：`activeByBook` 随书增长，删书后残留失效条目——**无害**（恢复时校验存在性会落到回落分支），不主动清理（YAGNI）。

## 6. 不碰主进程

- 复用 `window.api.chat.conversations.listByBook`（现有）；
- 无新 IPC 通道、无 `src/shared` schema 改动；
- `conversations`/`books` 表零改动、无 drizzle 迁移；
- 记忆完全落渲染层 localStorage，主进程不感知。

符合「主进程厚 / 渲染层薄」规则——这里持久化的是**渲染层自有的视图状态**，不是主进程领域数据。

## 7. 错误处理 / 边界

| 场景                                   | 行为                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| 记忆 id 指向已删会话                   | `listByBook` 校验落空 → 回落最新（或空态）；持久 map 里失效条目留存无害，下次恢复自愈 |
| `localStorage` 不可用（headless 测试） | persist storage getter 降级 `noopStorage`，仅内存、不抛错                             |
| persist JSON 损坏 / 旧形状             | zustand persist parse 失败回退到 store 默认（`activeByBook={}`）；无 `migrate` 需求   |
| `listByBook` IPC 失败                  | `log.warn` 吞错（保持现状），面板维持当前态                                           |
| 切书瞬间（恢复异步未回）               | `resetForBookSwitch` 已清残留 `openCommand`；active 派生为新书记忆值；历史随 IPC 填充 |
| `library` 态读取 active                | 派生为 `null`（`currentBookId === null`），library 不持有任何 active                  |

## 8. 测试（vitest，纯渲染层）

`chat-store.test.ts`（需在 `beforeEach` 设 `useNavigationStore` 的 `currentBookId` 以驱动 `rememberSlot`/派生）：

- `setActiveConversation(id)` / `openConversation(id)` / `restoreConversation(id)` 在有 `currentBookId` 时写对 `activeByBook[当前书]`；无当前书时不写槽；
- `setActiveConversation(null)` 清 `openCommand` 且槽置 null；
- `getActiveConversationId()` 派生：命中 `activeByBook[currentBook]`；`currentBookId=null` 时为 `null`；
- `resetForBookSwitch()` 清 `openCommand`，**保留** `activeByBook` 与 `draftText`/`draftChips`（断言草稿不被清）；
- `partialize` 仅含 `activeByBook`（持久化形状断言）；
- persist 往返：`vi.stubGlobal("localStorage", <mock>)`，写入后重建 store 断言 `activeByBook` rehydrate（验证 `name`/`partialize` 接线）。

`use-restore-conversation` 新测试（mock `listByBook` + 设 `currentBookId`）四分支：

1. 记忆命中 → `restoreConversation(remembered)`；
2. 记忆失效（id 不在 list）→ 回落 `list[0]` 且自愈槽；
3. 记忆为 `null` → `setActiveConversation(null)` + preset，不 restore；
4. 该书无会话（缺键 + 空 list）→ `setActiveConversation(null)` + preset。

既有 `chat-store.test.ts` 中断言 `activeConversationId` 字段的用例改写为断言 `activeByBook`/派生 getter（字段已删）。

## 9. 范围外（明确不做）

- **chat-store / store 层设计审查（单独议题）**：reader 瞬态（`openCommand`/`draftText`/`draftChips`/`summaryChips`）是否该收进随 `ReaderView` 生命周期销毁的 reader-scoped store、draft 切书是否清、哪些该 persist——成体系地审一遍 store 的「作用域 × 生命周期 × 持久化」三维归类。本设计只做 `activeConversationId` 派生化这一最小、必要的纠正，不夹带；
- **草稿持久化**（`draftText`/`draftChips` 跨重启）——属上述审查范畴；
- 删书时主动清理 `activeByBook` 残留条目——无害，YAGNI；
- 跨设备 / 主进程同步记忆——明确是本机视图状态；
- 重启后自动跳回上次阅读的书——`view` 仍从 `library` 起，记忆仅在用户主动开书时生效。
