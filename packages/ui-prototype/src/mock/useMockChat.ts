// 假流式对话引擎（原型一次性件）：逐段揭示助手正文，可选先冒一张折叠工具步骤卡，可中断。

import { useCallback, useRef, useState } from "react";
import type { ChatMessage, Chip, ToolStep } from "#/mock/types";
import { SEED_MESSAGES } from "#/mock/fixtures";

let counter = 0;
const uid = (p: string) => `${p}-${++counter}`;

interface Reply {
  steps: ToolStep[];
  text: string;
  error: boolean;
}

function truncate(s: string): string {
  const chars = Array.from(s);
  return chars.length > 18 ? chars.slice(0, 18).join("") + "…" : s;
}

function readStep(): ToolStep {
  return {
    id: uid("step"),
    label: "读取《岸与灯》",
    detail: "readChapterText(ch1, offset 0)",
    status: "running",
  };
}

/** 据用户文本/chips 生成一段“可信”的假回复（确定性，便于演示各形态）。 */
function mockReply(userText: string, chips: Chip[]): Reply {
  const selection = chips.find((c) => c.id === "selection")?.content ?? "";
  if (userText.includes("/error") || userText.includes("报错")) {
    return { steps: [], text: "（演示用错误态：与模型的连接被中断，本条未完成。）", error: true };
  }
  if (userText.includes("翻译")) {
    return {
      steps: [],
      text: `A rough rendering of the passage you picked:\n\n“${truncate(selection)}” — the tide pulls back, and the salt keeps a tally of the days.`,
      error: false,
    };
  }
  if (userText.includes("概括")) {
    return {
      steps: [readStep()],
      text: `要点：作者借“${truncate(selection)}”把具体的海岸经验抽象成关于方向与等待的体悟，落点在“被反复确认的方向”。`,
      error: false,
    };
  }
  return {
    steps: [readStep()],
    text: `你选中的“${truncate(selection)}”在这里是一处隐喻。叙述者把灯塔的光读解为“确认岸的位置”，于是“归途”不再是路线，而是一种被一再确认的方向感——这也呼应了后文潮汐表的意象。`,
    error: false,
  };
}

/** 把文本切成 ~2 码位的小块，模拟逐字吐出（CJK 无空格）。 */
function chunkText(text: string): string[] {
  const arr = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < arr.length; i += 2) out.push(arr.slice(i, i + 2).join(""));
  return out;
}

export function useMockChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(SEED_MESSAGES);
  const [isStreaming, setIsStreaming] = useState(false);
  const cancelled = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const patch = useCallback(
    (id: string, fn: (m: Extract<ChatMessage, { role: "assistant" }>) => ChatMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === id && m.role === "assistant" ? fn(m) : m))),
    [],
  );

  const stop = useCallback(() => {
    cancelled.current = true;
    clearTimers();
    setIsStreaming(false);
    setMessages((prev) =>
      prev.map((m) =>
        m.role === "assistant" && m.status === "streaming" ? { ...m, status: "done" } : m,
      ),
    );
  }, [clearTimers]);

  const send = useCallback(
    (userText: string, chips: Chip[]) => {
      cancelled.current = false;
      const reply = mockReply(userText, chips);
      const userMsg: ChatMessage = { id: uid("u"), role: "user", text: userText, chips };
      const aId = uid("a");
      const assistant: ChatMessage = {
        id: aId,
        role: "assistant",
        steps: reply.steps.map((s) => ({ ...s })),
        text: "",
        status: "streaming",
      };
      setMessages((prev) => [...prev, userMsg, assistant]);
      setIsStreaming(true);

      const schedule = (delay: number, fn: () => void) => {
        const t = setTimeout(() => {
          if (cancelled.current) return;
          fn();
        }, delay);
        timers.current.push(t);
      };

      let clock = 0;
      if (reply.steps.length) {
        clock += 550;
        schedule(clock, () =>
          patch(aId, (m) => ({ ...m, steps: m.steps.map((s) => ({ ...s, status: "done" })) })),
        );
      }

      const chunks = chunkText(reply.text);
      clock += 320;
      let acc = "";
      for (const ch of chunks) {
        clock += 45;
        schedule(clock, () => {
          acc += ch;
          const text = acc;
          patch(aId, (m) => ({ ...m, text }));
        });
      }

      clock += 140;
      schedule(clock, () => {
        patch(aId, (m) => ({ ...m, status: reply.error ? "error" : "done" }));
        setIsStreaming(false);
      });
    },
    [patch],
  );

  const reset = useCallback(() => {
    cancelled.current = true;
    clearTimers();
    setIsStreaming(false);
    setMessages([]);
  }, [clearTimers]);

  return { messages, isStreaming, send, stop, reset };
}
