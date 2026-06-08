# 聊天消息「编辑重发 / 直接重发·再生成」设计

日期：2026-06-09
状态：自审通过（2026-06-09 brainstorming；用户授权 spec+plan 均自审、不呈审，做完验收）
关联：GitHub issue #60（enhancement / area:ai）。**栈式叠在 #67（feat/copy-ai-chat-messages，已 PR #71）之上**——本特性扩展 #67 新增的 `MessageToolbar`，故分支基于 #67 tip，PR base 取 `feat/copy-ai-chat-messages`；#67 合并 main 后将 #60 rebase 到 main。

## 1. 背景与动机

用户有时问得不好、遇到失败/中止的回复、或单纯想要另一个答案。现状 AI 面板无任何消息级操作，唯一办法是开新会话重打。issue 要两件事：

- **编辑重发**：编辑此前发出的某条 user 消息，截断其后全部消息，从编辑后的消息重新生成 assistant 回复。
- **直接重发 / 再生成**：不改文本、从某条 user 消息重跑生成（重试失败/中止的回复，或换个答案）。

约束（issue 自陈）：历史是线性链（`messages.seq` 单调、无分支），所以是「截断后重发」而非 fork；`runSend` 已能 append user + 流式 assistant，截断尾部后应可复用。

## 2. 现状关键事实（已读代码确认）

- **主进程 `runSend`（`src/main/ai/send.ts`）** 把两件事捆在一起：① append user 消息（chips 快照入 metadata）；② streamText+tools 跑 agent 循环、终止时落 assistant（出生即终态 complete|error|aborted）+ 首轮自动命名 + 轮后压缩。
- **prompt 组装（`src/main/ai/prompt.ts`）**：`assemblePrompt({systemPrompt, priorSummary, history, current})`。历史 user 轮经 `renderHistoryMessage`→`renderUserTurn(metadata.contextChips, text)`——**只用快照的 `id`+`content`**（`chipContent`），不碰 labelKey/state。`current` 轮额外注入 readingContext（**不持久化**，只进当前轮）。
- **messages 层（`src/main/chat/messages.ts`）**：`appendMessage`（事务取下一 seq）、`listMessages`、`listMessagesAfterSeq(afterSeq)`（取 seq>afterSeq 尾窗）。**无 delete/truncate**。
- **会话滚动摘要**：`conversations.summarizedThroughSeq` + `contextSummary`。`runSend` 取历史 = `listMessagesAfterSeq(summarizedThroughSeq)`，priorSummary=contextSummary。`maybeCompactConversation` 轮后把超预算旧轮折叠进摘要、推进 summarizedThroughSeq。
- **流式 IPC（`src/main/ipc/ai-handlers.ts`）**：`ai:send`(invoke) → `runSend` → `pumpStream` 把 UIMessageChunk 经 `ai:chunk`(event) 推回；`activeStreams` 注册表（streamId→{controller, conversationId}）；`ai:abort`。
- **渲染层 transport（`src/renderer/ai/ipc-chat-transport.ts`）**：自定义 `ChatTransport.sendMessages({messages, abortSignal, trigger})`，取 `messages.at(-1)` 的 text+chips 发 `ai:send`，**历史不上送**。
- **`useChat`（`src/renderer/ai/AIPanel.tsx`）**：`@ai-sdk/react` v6。已解构 `{messages, sendMessage, status, stop, setMessages, error}`。开会话经 `messages.listByConversation`→`messagesToUI`→`setMessages` 载历史。
- **id 同步关键约束**：`messageDtoToUIMessage` 用 `id: dto.id`——**从 DB 载入的 UI 消息 id == DB id**；但**现场流式产生的消息是 AI SDK 客户端 id ≠ DB id**。

### 2.1 AI SDK v6 API 事实（context7 核对）

- `sendMessage({text})`（无 messageId）→ 追加新 user 消息 → transport `trigger='submit-user-message'`。
- `sendMessage({text, messageId})` → **替换**该消息（官方：useful for editing）→ trigger 仍 `'submit-user-message'`（**故 messageId 有无不能作新/旧判别**）。
- `regenerate({messageId})` → 再生成（默认末条 assistant，或指定）→ transport `trigger='regenerate-assistant-message'`（**可靠的「重发」信号**）。
- 自定义 transport `sendMessages` 收到 `trigger`；`body`/metadata 是否转发未确认——**不依赖**。

## 3. 设计目标与决策

| 决策点             | 结论                                                                                                             | 理由                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 新发 vs 重发的判别 | transport 按 **`trigger`**：`'submit-user-message'`→`ai:send`；`'regenerate-assistant-message'`→新 `ai:resend`   | trigger 是唯一可靠信号；所有重发/编辑/再生成都走 `regenerate()`         |
| 主进程重发操作     | **统一一个** `ai:resend`：按 messageId 设 user 文本 → 截断其后 → 从持久化消息重组 prompt → 流式                  | 编辑=改文本后重发；直接重发=文本不变（幂等设置）。一个操作覆盖两者      |
| chips 处理         | 重发**不传 chips**，主进程用该 user 消息 metadata 里的**持久化快照**组 prompt                                    | 快照含 id+content，足够 `assemblePrompt`；编辑只改文本不动上下文        |
| readingContext     | 重发**不带**（与「不持久化、仅当前轮注入」既有语义一致）                                                         | 快照 chips 已承载选区/段落上下文                                        |
| id 同步            | **每轮结束（status→ready/error）从 DB 重载消息**                                                                 | 让 UI 消息 id == DB id，重发才能按 messageId 命中 DB 行                 |
| 截断与摘要         | 截断到 seq S 时，若 `summarizedThroughSeq >= S` 则**重置摘要**（contextSummary=null, summarizedThroughSeq=null） | 否则摘要引用已删消息（silent-failure 防范）；S 在摘要边界之后则保留摘要 |
| 并发               | 有流在跑（status streaming/submitted）时**禁用**所有消息操作按钮                                                 | 与 Composer 发送禁用一致，避免串流                                      |

### 3.1 UI 操作（三入口，共享同一主进程操作）

扩展 #67 的 `MessageToolbar`，按 `message.role` 渲染：

- **user 气泡**：`Copy`（#67）+ **Edit** + **Resend**。
  - Edit：就地编辑（textarea 替换气泡正文 + 保存/取消）；保存→编辑重发。
  - Resend：原文重跑该 user 轮的回复（即便其 assistant 回复因报错渲染为空也可重试——见 §3.2）。
- **assistant 气泡**：`Copy`（#67）+ **Regenerate**。
  - Regenerate：重跑「本回复所应答的那条 user 轮」，得到新回复（重试/换答案的常规位置）。

Resend(user) 与 Regenerate(assistant) 底层同一操作（重跑某 user 轮的回复），仅锚点不同；Edit 额外先改 user 文本。三者共享机制（DRY）。

### 3.2 为何 Resend 放 user 气泡（鲁棒性）

模型错误（如 key 错）时 `runSend` 落的 assistant 消息可能 `parts` 为空 + status=error；而 `AssistantBubble` 现有 `if (segs.length===0 && !streaming) return null` 会**不渲染**空 assistant 气泡 → 该 assistant 无 toolbar、无法点 Regenerate。把 Resend 放 user 气泡确保**重试始终可达**。（不在本特性扩大到「渲染 error 气泡」——那是独立的错误展示议题，留作后续。）

## 4. 架构与数据流

```
[user 气泡 Edit] flushSync(setMessages 改该 user 文本) → regenerate({messageId: 该 user 轮的下一条 assistant id ?? undefined})
[user 气泡 Resend]                                       → regenerate({messageId: 同上})
[assistant 气泡 Regenerate]                              → regenerate({messageId: 本 assistant id})
        │ trigger='regenerate-assistant-message'
        ▼
transport.sendMessages：取 messages.at(-1)（= 目标 user 轮）→ ai:resend({streamId, conversationId, userMessageId: last.id, userText: lastUserText})
        ▼
主进程 runResend：校验模型/会话/消息(user 且属本会话) → 事务{设文本 + 截断其后 + 按需重置摘要} → 从持久化消息组 prompt → streamAssistantReply（复用 runSend 尾段）
        ▼
ai:chunk 流式回灌 useChat（同 ai:send 路径）→ status→ready → 从 DB 重载消息（id 同步）
```

**「目标 user 轮」恒为 `messages.at(-1)`**：regenerate 移除被再生成的 assistant 及其后，故末条即其前序 user 轮；Edit 先改该 user 文本，regenerate 移除其后 assistant 后末条即编辑后的 user 轮。userText 取 `messages.at(-1)` 文本，编辑场景自然为新文本。

## 5. 主进程实现

### 5.1 messages 层（`src/main/chat/messages.ts`）新增

```ts
/** 取单条消息（resend 解析 messageId → role/seq/conversationId 校验用）；无则 null。 */
export function getMessage(db: DB, messageId: string): MessageDto | null {
  /* select where id, .get() → toDto | null */
}

/**
 * 重置 user 轮以重发：事务内① 设该 user 消息 parts=[{type:text,text}]（保留 metadata 快照）；
 * ② 删 seq > 该消息 seq 的全部消息（assistant + 后续轮）；③ 若会话 summarizedThroughSeq >= 该 seq，
 * 重置 contextSummary=null, summarizedThroughSeq=null（截断进摘要边界则摘要失效）；④ 推进 updatedAt。
 * 返回该 user 消息 seq。调用方已校验 messageId 为本会话 user 消息。
 */
export function resetUserTurnForResend(
  db: DB,
  conversationId: string,
  messageId: string,
  text: string,
): number {
  return db.transaction((tx) => {
    const row = tx
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
      .get();
    if (!row) throw new Error("message not found"); // 防御：调用方已校验
    const seq = row.seq;
    tx.update(messages)
      .set({ parts: [{ type: "text", text }] })
      .where(eq(messages.id, messageId))
      .run();
    tx.delete(messages)
      .where(and(eq(messages.conversationId, conversationId), gt(messages.seq, seq)))
      .run();
    const convo = tx
      .select({ s: conversations.summarizedThroughSeq })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    const resetSummary = convo?.s != null && convo.s >= seq;
    tx.update(conversations)
      .set({
        updatedAt: Date.now(),
        ...(resetSummary ? { contextSummary: null, summarizedThroughSeq: null } : {}),
      })
      .where(eq(conversations.id, conversationId))
      .run();
    return seq;
  });
}
```

### 5.2 抽出共享流式尾段（新文件 `src/main/ai/stream-assistant.ts`）

把 `runSend` 的「streamText + tools + toUIMessageStream(onError/onFinish 落 assistant + 命名 + 压缩) + tee + drain」整段（现 send.ts §6–§7）抽为：

```ts
export interface StreamCtx {
  conversationId: string;
  bookId: string;
  resolved: ResolvedModel;
}
/** 共享：跑 streamText agent 循环、终止落终态 assistant、首轮命名、轮后压缩。runSend / runResend 共用。 */
export function streamAssistantReply(
  deps: SendDeps,
  ctx: StreamCtx,
  messages: ModelMessage[],
  systemPrompt: string | undefined,
  opts?: { abortSignal?: AbortSignal },
): Extract<SendResult, { ok: true }> {
  /* 现 send.ts 125–251 行原样迁入，参数化 db/resolved/bookId/conversationId */
}
```

`runSend` 改为：解析模型/校验会话/append user/组 prompt（live chips + readingContext）后调 `streamAssistantReply`。行为不变。

### 5.3 `runResend`（`src/main/ai/send.ts` 或新 `resend.ts`）

```ts
export interface ResendInput { conversationId: string; userMessageId: string; userText: string; }

export function runResend(deps: SendDeps, input: ResendInput, opts?: { abortSignal?: AbortSignal }): SendResult {
  const resolved = deps.resolveModel();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  // 校验会话 + 取 bookId（不由 renderer 传，主进程派生，少一处可伪造）
  const convo = db.select({bookId, ...}).from(conversations).where(eq(id, input.conversationId)).get();
  if (!convo) return { ok:false, reason: t("errors.conversationNotFound", ...) };
  // 校验消息：存在、属本会话、role=user
  const msg = getMessage(db, input.userMessageId);
  if (!msg || msg.conversationId !== input.conversationId || msg.role !== "user")
    return { ok:false, reason: t("errors.messageNotResendable", "消息不存在或不可重发") };
  // 事务：设文本 + 截断其后 + 按需重置摘要
  resetUserTurnForResend(db, input.conversationId, input.userMessageId, input.userText);
  // 重读会话摘要态（可能刚被重置）+ 取窗口历史（含刚改的 user 轮）
  const c2 = db.select({contextSummary, summarizedThroughSeq, ...}).from(conversations).where(...).get();
  const window = listMessagesAfterSeq(db, input.conversationId, c2.summarizedThroughSeq); // 末条 = 目标 user 轮
  const current = window.at(-1); // user 轮
  const history = window.slice(0, -1);
  // 组 prompt：current 由持久化快照构造（chips 仅需 id+content；readingContext=null）
  const allMessages = assemblePrompt({
    systemPrompt: <同 runSend：assistant.systemPrompt (+pdfNote)>,
    priorSummary: c2.contextSummary,
    history,
    current: { chips: current.metadata?.contextChips ?? [], userText: textOfParts(current.parts), readingContext: null },
  });
  // 提取 system → streamAssistantReply（与 runSend 同尾段）
  return streamAssistantReply(deps, { conversationId, bookId: convo.bookId, resolved }, messages, systemPrompt, opts);
}
```

**`assemblePrompt` 类型微调**：`current.chips` 由 `Chip[]` 放宽为 `ReadonlyArray<{id; content; ...}>`（`renderUserTurn` 本就只用 id+content，接受 ChipLike）。这样 runResend 直接传持久化快照（`{id,content,tokenCount}`），runSend 传 live `Chip[]`（满足），均无需重建/占位 labelKey。

### 5.4 IPC（`src/shared/chat.ts` + `src/shared/ipc.ts` + `ai-handlers.ts` + preload）

- `chat.ts`：
  ```ts
  export const resendInputSchema = z.object({
    conversationId: z.string().min(1),
    userMessageId: z.string().min(1),
    userText: z.string().min(1),
  });
  export type ResendInput = z.infer<typeof resendInputSchema>;
  export const resendRequest = resendInputSchema.extend({ streamId: z.string().min(1) });
  export type ResendRequest = z.infer<typeof resendRequest>;
  ```
  复用 `sendAck`（同 `{ok,conversationId}|{ok:false,reason}`）。
- `ipc.ts`：`aiResend: def("ai:resend", "invoke", resendRequest, out<SendAck>())`。
- `ai-handlers.ts`：新增 `bind(C.aiResend, …)`——与 `aiSend` 同构（铸 controller 注册 activeStreams、调 `runResend`、ok 则 `pumpStream`、finally 清理）。复用 `pumpStream`。
- `preload-api.ts`：`ai.resend: inv(C.aiResend)`。

## 6. 渲染层实现

### 6.1 id 同步：轮结束从 DB 重载（`AIPanel.tsx`）

现有 status→ready/error effect 仅失效会话列表查询。新增：轮结束时若有 activeConversationId，`messages.listByConversation`→`messagesToUI`→`setMessages`，使消息携 DB id（重发命中 DB 行的前提）。仅在 `prev!==ready && (ready||error)` 触发；流式中不重载。内容相同，仅新轮 2 条消息 id 由客户端 id 换 DB id（局部 remount，可接受）。

### 6.2 transport 分支（`ipc-chat-transport.ts`）

`sendMessages({messages, abortSignal, trigger})`：

- 公共：解析 book（resend 也需校验有书）、conversationId（resend 必已存在，不懒建）。
- `trigger === "regenerate-assistant-message"`：取 `last=messages.at(-1)`、`userText=lastUserText(messages)`，调 `window.api.ai.resend({streamId, conversationId, userMessageId: last.id, userText})`。
- 否则（submit）：现有 `ai:send` 路径不变。
- 订阅/ack/错误处理两分支共用既有写法。

### 6.3 chat 操作上下文（新 `src/renderer/ai/chat-actions.ts`）

避免 4 层 prop 钻取，用 React context 提供操作（`AIPanel` 持 useChat 句柄处构造）：

```ts
export interface ChatActions {
  /** 重跑某 user 轮的回复（直接重发）。 */
  resend(userMessage: ChatUIMessage): void;
  /** 改 user 文本后重跑回复（编辑重发）。 */
  editAndResend(userMessage: ChatUIMessage, newText: string): void;
  /** 再生成某 assistant 回复。 */
  regenerate(assistantMessage: ChatUIMessage): void;
  /** 是否有流在跑（禁用按钮）。 */
  busy: boolean;
}
export const ChatActionsContext = createContext<ChatActions | null>(null);
export function useChatActions(): ChatActions {
  /* useContext + null 守卫抛错 */
}
/** 纯函数：messages 中 userMessageId 之后紧邻的 assistant 消息（无则 undefined）——单测。 */
export function nextAssistantId(
  messages: ChatUIMessage[],
  userMessageId: string,
): string | undefined {
  /* 找 index 后第一个 role==='assistant' */
}
```

`AIPanel` 构造 actions：

```ts
const actions: ChatActions = {
  regenerate: (a) => void regenerate({ messageId: a.id }),
  resend: (u) => {
    const aId = nextAssistantId(messages, u.id);
    void regenerate(aId ? { messageId: aId } : undefined);
  },
  editAndResend: (u, newText) => {
    flushSync(() =>
      setMessages((ms) =>
        ms.map((m) => (m.id === u.id ? { ...m, parts: [{ type: "text", text: newText }] } : m)),
      ),
    );
    const aId = nextAssistantId(useChatMessagesRef.current, u.id); // flushSync 后读最新
    void regenerate(aId ? { messageId: aId } : undefined);
  },
  busy: status === "streaming" || status === "submitted",
};
```

（`flushSync` 强制改文本先 commit，再 `regenerate` 读到编辑后 messages——同 `composer-focus` 既有用法。`nextAssistantId` 在 flushSync 后用最新 messages 计算；用 ref 或直接闭包 `messages`——编辑只删尾、nextAssistant 仍为同一条，闭包 `messages` 即可。）用 `<ChatActionsContext.Provider value={actions}>` 包住 MessageList。

### 6.4 MessageToolbar 扩展（`MessageToolbar.tsx`）

按 `message.role` + `useChatActions()` 渲染（Copy 恒在）：

- user：Copy + Edit(`onEdit` prop，UserBubble 传，切本地编辑态) + Resend(`actions.resend(message)`)。
- assistant：Copy + Regenerate(`actions.regenerate(message)`)。
- 所有重发类按钮 `disabled={actions.busy}`。
- 图标：Edit=`Pencil`、Resend/Regenerate=`RefreshCw`（lucide）。

### 6.5 UserBubble 就地编辑（`MessageList.tsx`）

UserBubble 加本地 `isEditing`：

- 非编辑态：原气泡 + `<MessageToolbar message={m} onEdit={() => setIsEditing(true)} />`。
- 编辑态：textarea（预填 `textOf(m)`）+ 保存/取消。保存→`actions.editAndResend(m, draft); setIsEditing(false)`；取消→`setIsEditing(false)`。空文本禁用保存。textarea 挂载自动聚焦（命令式，ref）。
- MessageList 把 `status` 传下（已有），或操作禁用走 `actions.busy`。AssistantBubble 的 toolbar 仍 `!streaming` 时挂（#67），并加 Regenerate。

### 6.6 i18n

新增：`ai.edit`(编辑)、`ai.resend`(重新发送)、`ai.regenerate`(重新生成)、`ai.editSave`(发送/保存)、`ai.editCancel`(取消)、`ai.editPlaceholder`（可选）。组件内中文 inline default + `pnpm i18n:extract` + 填 en.ts。

## 7. 测试策略

- **主进程单测**（headless `:memory:`）：
  - `resetUserTurnForResend`：设文本生效；删 seq>S 的消息；S 在摘要边界内(`summarizedThroughSeq>=S`)→重置摘要、之后(`<S`)→保留；返回 seq。
  - `runResend`（复用 send.test 既有 deps 工厂）：未配置模型→error 不动库；会话不存在/消息非本会话/非 user→对应 error；正常→截断+流式+落新 assistant；`getMessage` 校验。
  - `runSend` 重构后既有 `send.test.ts` 全绿（行为不变回归）。
- **渲染层单测**（headless）：`nextAssistantId`（命中紧邻 assistant、无则 undefined、user 在末尾）；`createEventStream`/transport 既有测试不破；transport 新增 resend 分支可注入假 `window.api.ai.resend` 测「trigger=regenerate→调 resend 带 last.id+userText」。
- **不**单测 React 组件交互（无 RTL，#67 同惯例）。
- **dev CDP 冒烟**目视：① user 气泡 hover→Edit/Resend 现；② Edit→textarea→改字→保存→其后消息消失、流式出新回复、内容反映新问；③ Resend→原问重跑、新回复替换；④ assistant 气泡 Regenerate→换答案；⑤ 流式中操作按钮禁用；⑥ 编辑重发后刷新/重开会话→持久内容为编辑后（DB 已改）；⑦ 截断跨摘要边界的旧消息重发→不报错、回复正常。

## 8. 影响面

- **主进程**：messages 层 +2 helper；send.ts 抽 `stream-assistant.ts` + 加 `runResend`；assemblePrompt current.chips 类型放宽；IPC +1 通道（chat.ts schema + ipc.ts + ai-handlers + preload）。
- **渲染层**：transport +resend 分支；AIPanel +重载同步 + actions context provider；新 `chat-actions.ts`；MessageToolbar 扩展；UserBubble 编辑态；i18n +~5 键。
- **DB**：无 schema/迁移改动（仅 update/delete 既有表）。
- **changeset**：英文一条，「Edit-and-resend and regenerate for AI chat messages」。
- **栈式**：基于 #67；PR base=feat/copy-ai-chat-messages；#67 合 main 后 rebase。

## 9. 自审记录（spec self-review）

- **占位符**：无 TBD/TODO。
- **一致性**：transport trigger 判别 ↔ §2.1 确认；id 同步(§6.1) 支撑 resend 按 messageId 命中(§5.3)；摘要重置(§5.1) 与截断语义自洽；Resend 放 user 气泡理由(§3.2) 与「error 气泡可能不渲染」现状一致。
- **歧义**：`messages.at(-1)` 恒为目标 user 轮——已在 §4 论证 regenerate 移除 assistant 后的末条语义。
- **范围**：聚焦三入口 + 一主进程操作，不扩到 error 气泡渲染/分支会话（YAGNI，§3.2 标注后续）。单一计划可执行。
- **YAGNI**：复用 #67 MessageToolbar 与 runSend 尾段；不造分支/fork、不造通用动作注册表。
