import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useChat } from "@ai-sdk/react";
import { MessagesSquare, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { useChatStore, useActiveConversationId } from "@renderer/store/chat-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { createIpcChatTransport } from "@renderer/ai/ipc-chat-transport";
import type { ChatUIMessage } from "@renderer/ai/types";
import { MessageList } from "@renderer/ai/MessageList";
import { Composer } from "@renderer/ai/Composer";
import { ConversationsTab } from "@renderer/ai/ConversationsTab";
import { messagesToUI } from "@renderer/ai/message-history";
import {
  conversationOpenScrollBehavior,
  isScrollAtBottom,
  messageScrollBehavior,
} from "@renderer/ai/scroll-follow";
import { conversationsQuery } from "@renderer/query/conversation-queries";
import type { Chip, MessageDto } from "@shared/chat";
import { openPanelAndFocusComposer } from "@renderer/ai/composer-focus";
import { ChatActionsContext, nextAssistantId, type ChatActions } from "@renderer/ai/chat-actions";
import { ChatPerfMonitor } from "@renderer/ai/ChatPerfMonitor";
import { createLogger } from "@renderer/logger";
import { contextKey, resolveOpenCommandTarget, type ChatContext } from "@renderer/ai/chat-context";

const log = createLogger("ai");

const PAGE_SIZE = 80;
const SCROLL_TOP_THRESHOLD = 100;

interface PaginationState {
  hasMore: boolean;
  loadingMore: boolean;
  oldestSeq: number | null;
}

export function AIPanel({ context, onClose }: { context: ChatContext; onClose: () => void }) {
  const { t } = useTranslation();
  const { messages, sendMessage, status, stop, setMessages, regenerate, error } =
    useChat<ChatUIMessage>({
      transport: createIpcChatTransport(context),
      // 流式错误此前只塞进 error 字段弹 banner、从不落日志；补一条 warn 使渲染侧失败也有痕迹可查。
      onError: (err) => log.warn("chat stream error", err),
    });
  const agentName = usePrefsStore((s) => s.soul.name);
  const openCommand = useChatStore((s) => s.openCommand);
  const activeConversationId = useActiveConversationId(context);
  const bookId = context.kind === "book" ? context.bookId : null;
  // 会话列表内嵌于面板（仅 library 上下文；阅读器的列表在 Sidebar）：header 切换 chat ↔ 列表。
  const isLibrary = context.kind === "library";
  const [showList, setShowList] = useState(false);
  const convosQuery = useQuery(conversationsQuery(context));
  const activeTitle = activeConversationId
    ? convosQuery.data?.find((c) => c.id === activeConversationId)?.title?.trim() ||
      t("reader.conversation.untitled", "未命名会话")
    : null;
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followBottomRef = useRef(true);
  const prevStatus = useRef(status);
  const [pagination, setPagination] = useState<PaginationState>({
    hasMore: false,
    loadingMore: false,
    oldestSeq: null,
  });
  const seqMapRef = useRef<Map<string, number>>(new Map());
  const isOpeningRef = useRef(false);

  const resetPagination = () => {
    setPagination({ hasMore: false, loadingMore: false, oldestSeq: null });
    seqMapRef.current = new Map();
  };

  const updateSeqMap = (dtos: MessageDto[]) => {
    for (const dto of dtos) {
      seqMapRef.current.set(dto.id, dto.seq);
    }
  };

  const prevMessagesRef = useRef<ChatUIMessage[]>([]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const prev = prevMessagesRef.current;
    prevMessagesRef.current = messages;
    const prependedHistory =
      prev.length > 0 && messages.length > prev.length && messages[0]?.id !== prev[0]?.id;
    const lastMessageChanged = messages.at(-1)?.id !== prev.at(-1)?.id;
    const streamingAssistant = status === "streaming" && messages.at(-1)?.role === "assistant";

    const scrollBehavior = messageScrollBehavior({
      following: followBottomRef.current,
      openingConversation: isOpeningRef.current,
      previousLength: prev.length,
      prependedHistory,
      lastMessageChanged,
      streamingAssistant,
    });
    if (scrollBehavior) {
      el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior });
    }
  }, [messages, status]);

  // 用户离开底部后暂停 streaming 跟随；只有真正回到底部才恢复。
  // showList 切换会卸载/重建 viewport，依赖它以确保监听器挂到新元素。
  useEffect(() => {
    if (showList) return;
    const el = scrollRef.current;
    if (!el) return;
    const updateFollowState = () => {
      followBottomRef.current = isScrollAtBottom(el);
    };
    updateFollowState();
    el.addEventListener("scroll", updateFollowState, { passive: true });
    return () => el.removeEventListener("scroll", updateFollowState);
  }, [showList]);

  // 重开会话：openCommand.nonce 变 → 先中止在跑的流（避免增量灌入将被替换的历史、streamId 串台）→ 载历史 → setMessages。
  // 只认 openCommand（一次性命令信号），不认 activeConversationId——后者也被发消息 ack 写入，监听它会在发完消息后误重载。
  // 经 resolveOpenCommandTarget 守卫：跨 context 的残留命令（如读书时的 book 会话）不属于本面板 ⇒ 不载入。
  // 依赖稳定的 contextKey 字符串而非 context 对象：ReaderView 每 render 新建 { kind, bookId }，
  // 入依赖会致每渲染重载（甚至 stop() 杀流）；不能靠 React Compiler 记忆化保正确性。
  const ctxKey = contextKey(context);
  useEffect(() => {
    const conversationId = resolveOpenCommandTarget(openCommand, ctxKey);
    if (!conversationId) return;
    let cancelled = false;
    followBottomRef.current = true;
    setShowList(false); // 从列表选中一条会话 → 回到聊天视图
    resetPagination();
    isOpeningRef.current = true;
    void stop();
    void window.api.chat.messages
      .listByConversation({ conversationId, limit: PAGE_SIZE })
      .then(({ messages: dtos, hasMore }) => {
        if (cancelled) return;
        updateSeqMap(dtos);
        setMessages(messagesToUI(dtos));
        setPagination({ hasMore, loadingMore: false, oldestSeq: dtos[0]?.seq ?? null });
        // 等 React 渲染 + Streamdown/markdown 高度基本稳定后再单次 smooth 滚底；
        // 该路径已停止当前流，不会与 chunk 跟随竞争。
        setTimeout(() => {
          if (cancelled) return;
          const el = scrollRef.current;
          if (el) {
            followBottomRef.current = true;
            el.scrollTo({ top: el.scrollHeight, behavior: conversationOpenScrollBehavior() });
          }
          isOpeningRef.current = false;
        }, 100);
      })
      .catch((err: unknown) => log.warn("load conversation history failed", err));
    return () => {
      cancelled = true;
      isOpeningRef.current = false;
    };
  }, [openCommand, ctxKey, stop, setMessages]);

  // 一轮发送结束（曾 streaming/submitted → 回 ready/error）→ 刷新会话列表（新会话 / 标题 / updatedAt）。
  // 同时从 DB 重载最新一页消息以同步 UI message ids 到持久化 ids（resend 截断后 id 会变）。
  // 用前缀 ["conversations"] 失效（不需 bookId），匹配 qk.conversations(bookId)=["conversations",bookId]。
  useEffect(() => {
    if (prevStatus.current !== "ready" && (status === "ready" || status === "error")) {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      if (activeConversationId) {
        void window.api.chat.messages
          .listByConversation({ conversationId: activeConversationId, limit: PAGE_SIZE })
          .then(({ messages: dtos, hasMore }) => {
            updateSeqMap(dtos);
            const newUis = messagesToUI(dtos);
            const oldestNewSeq = dtos[0]?.seq ?? null;
            setMessages((prev) => {
              if (oldestNewSeq == null) return newUis;
              const kept = prev.filter(
                (m) => (seqMapRef.current.get(m.id) ?? Infinity) < oldestNewSeq,
              );
              return [...kept, ...newUis];
            });
            setPagination((p) => ({
              ...p,
              // 若此前已加载全部历史，resync 只取最新一页不应把 hasMore 重新打开
              hasMore: p.hasMore ? hasMore : false,
              oldestSeq: dtos[0]?.seq ?? p.oldestSeq,
            }));
          })
          .catch((err: unknown) => log.warn("reload conversation after turn failed", err));
      }
    }
    prevStatus.current = status;
  }, [status, qc, activeConversationId, setMessages]);

  // active 置空（开书无会话 / 切书）→ 清面板；初始即空时为 no-op。
  useEffect(() => {
    if (activeConversationId === null) {
      setMessages([]);
      resetPagination();
    }
  }, [activeConversationId, setMessages]);

  const newConversation = async () => {
    try {
      // 显式创建空会话（spec §2/§7）；防堆积由主进程兜底（复用既有空会话）
      const convo = await window.api.chat.conversations.create({
        bookId: context.kind === "book" ? context.bookId : null,
      });
      setMessages([]);
      setShowList(false); // 新建后回到聊天视图
      useChatStore.getState().setActiveConversation(context, convo.id);
      useChatStore.getState().setSummaryChipsPreset();
      openPanelAndFocusComposer();
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      log.warn("create conversation failed", err);
    }
  };

  const loadMore = () => {
    const conversationId = activeConversationId;
    const beforeSeq = pagination.oldestSeq;
    if (
      isOpeningRef.current ||
      !conversationId ||
      beforeSeq == null ||
      pagination.loadingMore ||
      !pagination.hasMore
    ) {
      return;
    }

    // 加载前记录锚点：第一条可见消息到 viewport 顶部的距离，
    // 加载完成后恢复该距离，避免跳动和连续误触发 loadMore。
    const el = scrollRef.current;
    const anchorId = messages[0]?.id;
    const anchorEl = anchorId
      ? (el?.querySelector(`[data-message-id="${anchorId}"]`) as HTMLElement | null)
      : null;
    const anchorOffset = anchorEl && el ? anchorEl.offsetTop - el.scrollTop : null;

    setPagination((p) => ({ ...p, loadingMore: true }));
    void window.api.chat.messages
      .listByConversation({ conversationId, beforeSeq, limit: PAGE_SIZE })
      .then(({ messages: dtos, hasMore }) => {
        if (dtos.length === 0) {
          setPagination((p) => ({ ...p, hasMore: false, loadingMore: false }));
          return;
        }
        updateSeqMap(dtos);
        const newUis = messagesToUI(dtos);
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const uniqueNew = newUis.filter((m) => !existingIds.has(m.id));
          return [...uniqueNew, ...prev];
        });
        setPagination({
          hasMore,
          loadingMore: false,
          oldestSeq: dtos[0]?.seq ?? beforeSeq,
        });
        // 恢复锚定位置：让原来在 viewport 顶部的消息仍保持在原位。
        requestAnimationFrame(() => {
          const newEl = scrollRef.current;
          if (anchorOffset == null || !anchorId || !newEl) return;
          const newAnchorEl = newEl.querySelector(
            `[data-message-id="${anchorId}"]`,
          ) as HTMLElement | null;
          if (!newAnchorEl) return;
          newEl.scrollTop = newAnchorEl.offsetTop - anchorOffset;
        });
      })
      .catch((err: unknown) => {
        setPagination((p) => ({ ...p, loadingMore: false }));
        log.warn("load older messages failed", err);
      });
  };

  // 滚动到顶部附近时加载更早一页。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pagination.hasMore || pagination.loadingMore) return;
    const onScroll = () => {
      if (el.scrollTop < SCROLL_TOP_THRESHOLD) {
        loadMore();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [pagination.hasMore, pagination.loadingMore, pagination.oldestSeq, activeConversationId]);

  const actions: ChatActions = {
    regenerate: (a) => {
      followBottomRef.current = true;
      void regenerate({ messageId: a.id });
    },
    resend: (u) => {
      followBottomRef.current = true;
      const aId = nextAssistantId(messages, u.id);
      void regenerate(aId ? { messageId: aId } : undefined);
    },
    editAndResend: (u, newText) => {
      followBottomRef.current = true;
      flushSync(() =>
        setMessages((ms) =>
          ms.map((m) => (m.id === u.id ? { ...m, parts: [{ type: "text", text: newText }] } : m)),
        ),
      );
      const aId = nextAssistantId(messages, u.id);
      void regenerate(aId ? { messageId: aId } : undefined);
    },
    busy: status === "streaming" || status === "submitted",
  };

  const handleSend = (text: string, chips: Chip[]) => {
    followBottomRef.current = true;
    void sendMessage({ text, metadata: { contextChips: chips } });
  };

  return (
    <div className="flex h-full flex-col bg-muted/30 font-sans">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-semibold">
            {t("ai.panelTitle", "{{name}}", { name: agentName })}
          </span>
          {activeTitle && (
            <span className="truncate text-[11px] text-muted-foreground">{activeTitle}</span>
          )}
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          {isLibrary && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowList((v) => !v)}
              aria-label={t("ai.conversationList", "会话列表")}
              aria-pressed={showList}
              className={showList ? "text-foreground" : "text-muted-foreground"}
            >
              <MessagesSquare />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void newConversation()}
            aria-label={t("ai.newConversation", "新对话")}
            className="text-muted-foreground"
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("ai.closePanel", "关闭面板")}
            className="text-muted-foreground"
          >
            <X />
          </Button>
        </div>
      </header>

      {showList ? (
        <div className="min-h-0 flex-1">
          <ConversationsTab context={context} />
        </div>
      ) : (
        <>
          <ScrollArea
            className="min-h-0 flex-1"
            viewportRef={scrollRef}
            viewportClassName="ai-messages-viewport"
          >
            <div className="p-4">
              <ChatActionsContext.Provider value={actions}>
                <MessageList
                  messages={messages}
                  status={status}
                  bookId={bookId}
                  hasMore={pagination.hasMore}
                  loadingMore={pagination.loadingMore}
                />
              </ChatActionsContext.Provider>
            </div>
          </ScrollArea>

          {error && (
            <div className="shrink-0 border-t border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {t("ai.sendFailed", "发送失败：{{message}}", { message: error.message })}
              <span className="text-muted-foreground">
                {t("ai.sendFailedHint", "（请确认已在「设置」配置 API Key 与模型）")}
              </span>
            </div>
          )}

          <Composer status={status} onStop={stop} onSend={handleSend} context={context} />
        </>
      )}
      {import.meta.env.DEV && <ChatPerfMonitor messages={messages} />}
    </div>
  );
}
