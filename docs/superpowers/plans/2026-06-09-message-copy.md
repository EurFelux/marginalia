# AI 聊天消息复制到剪贴板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI 聊天面板的每条消息（AI 回复 + 用户消息）加一个 hover/focus 揭示的工具栏，当前含一个「复制 markdown 源」按钮。

**Architecture:** 纯渲染层。抽 `textOf` 成独立可单测模块作为「复制取文 = 渲染正文」的单一真相；`CopyButton` 封装 `navigator.clipboard.writeText` + 反馈态；`MessageToolbar` 作 hover 揭示容器（当前仅一个按钮，不预造动作抽象）；接入 `MessageList` 两气泡。无主进程 / IPC / DB 改动。

**Tech Stack:** React 19（启用 React Compiler，不手写 useCallback/useMemo）、TypeScript 6 strict、Tailwind、lucide-react、i18next（primaryLanguage zh-CN，inline 中文 default + `pnpm i18n:extract`）、vitest 4。

设计文档：`docs/superpowers/specs/2026-06-09-message-copy-design.md`

---

## 关键约定（执行前必读）

- **i18n 顺序**：新增 `t("key", "中文")` 后**先跑 `pnpm i18n:extract` 再 `pnpm typecheck`**——`i18next.d.ts` 的 key 类型从 `zh-CN.ts` 推导，没 extract 进去的 key 过不了类型检查。extract 会从中文 inline default 灌进 `zh-CN.ts`、给 `en.ts` 留空串，需手填英文。
- **extract diff 自查**：跑完 extract 只该看到「新 key 进 zh-CN.ts」+「同名空串进 en.ts」；若有别的既有 key 被删（`removeUnusedKeys` 误伤），停下排查，勿提交。
- **pre-commit**：`git commit` 会触发 `lint:fix` + `format`，可能改暂存文件并以 "files were modified by this hook" 中止；遇到就 `git add` 被改文件后**重跑同一条 commit**（第二次过）。
- **不手写 `useCallback`/`useMemo`**（React Compiler 自动记忆化）；命令式 effect 清理仍手写。
- 提交信息用 Conventional Commits；每条 commit 末尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## 文件结构

| 文件                                   | 职责                                                    | 动作 |
| -------------------------------------- | ------------------------------------------------------- | ---- |
| `src/renderer/ai/message-text.ts`      | 纯函数 `textOf(m)`：拼接 text part = 消息 markdown 源   | 新建 |
| `src/renderer/ai/message-text.test.ts` | `textOf` 单测                                           | 新建 |
| `src/renderer/ai/CopyButton.tsx`       | 复制按钮：clipboard 写入 + 反馈态 + a11y                | 新建 |
| `src/renderer/ai/MessageToolbar.tsx`   | hover/focus 揭示的动作行容器（当前仅 CopyButton）       | 新建 |
| `src/renderer/ai/MessageList.tsx`      | 删局部 `textOf`、两气泡加 `group` + 挂 `MessageToolbar` | 修改 |
| `src/shared/i18n/locales/zh-CN.ts`     | extract 自动灌入中文（勿手编）                          | 生成 |
| `src/shared/i18n/locales/en.ts`        | 手填英文译文                                            | 修改 |
| `.changeset/message-copy.md`           | 用户向英文 changelog                                    | 新建 |

---

## Task 1: 抽取 `textOf` 为可单测模块

**Files:**

- Create: `src/renderer/ai/message-text.ts`
- Test: `src/renderer/ai/message-text.test.ts`
- Modify: `src/renderer/ai/MessageList.tsx`（删 `:16-18` 局部 `textOf`、加 import）

- [ ] **Step 1: 写失败测试**

`src/renderer/ai/message-text.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { textOf } from "@renderer/ai/message-text";
import type { ChatUIMessage } from "@renderer/ai/types";

type Part = ChatUIMessage["parts"][number];

const text = (t: string): Part => ({ type: "text", text: t });
const toolPart: Part = {
  type: "tool-readPage",
  toolCallId: "c1",
  state: "output-available",
  input: { page: 1 },
  output: { kind: "text", page: 1, text: "x" },
} as Part;
const msg = (parts: Part[]): ChatUIMessage => ({ id: "m1", role: "assistant", parts });

describe("textOf", () => {
  it("concatenates multiple text parts (markdown source preserved)", () => {
    expect(textOf(msg([text("# Title"), text("\n\nbody")]))).toBe("# Title\n\nbody");
  });

  it("skips non-text parts such as tool steps", () => {
    expect(textOf(msg([text("before"), toolPart, text("after")]))).toBe("beforeafter");
  });

  it("returns empty string when there are no parts", () => {
    expect(textOf(msg([]))).toBe("");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test src/renderer/ai/message-text.test.ts`
Expected: FAIL —「Failed to resolve import "@renderer/ai/message-text"」（模块尚不存在）。

- [ ] **Step 3: 实现模块**

`src/renderer/ai/message-text.ts`：

```ts
import type { ChatUIMessage } from "@renderer/ai/types";

/** 拼接消息所有 text part（跳过 tool/step 等非文本 part）——即消息的 markdown 源。 */
export function textOf(m: ChatUIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm test src/renderer/ai/message-text.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: 改 `MessageList.tsx` 复用模块**

删除现有局部函数（`:16-18`）：

```tsx
function textOf(m: ChatUIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}
```

在文件顶部 `@renderer/ai/*` import 区加一行（保持既有 import 排序风格）：

```tsx
import { textOf } from "@renderer/ai/message-text";
```

（`ChatUIMessage` 仍被两气泡 props 使用，import 保留；`UserBubble` 内 `{textOf(m)}` 调用不变，现解析到新模块。）

- [ ] **Step 6: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test src/renderer/ai`
Expected: typecheck 无错；该目录测试全 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/ai/message-text.ts src/renderer/ai/message-text.test.ts src/renderer/ai/MessageList.tsx
git commit -m "$(cat <<'EOF'
refactor(ai): extract textOf into a testable module

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

（若 pre-commit 钩子改了文件并中止：`git add` 被改文件后重跑同一 commit。）

---

## Task 2: `CopyButton` 组件

**Files:**

- Create: `src/renderer/ai/CopyButton.tsx`
- Modify: `src/shared/i18n/locales/en.ts`（手填 `ai.copy` / `ai.copied` 英文）

> 本组件无 React 组件渲染测试基建（仅 `happy-dom` 用于 DOM helper），按本仓惯例不写组件单测，交互走最终 CDP 冒烟（Task 4）。

- [ ] **Step 1: 创建组件**

`src/renderer/ai/CopyButton.tsx`：

```tsx
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";
import { createLogger } from "@renderer/logger";

const log = createLogger("ai");
const COPIED_RESET_MS = 1500;

export function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 命令式 effect 清理仍手写（React Compiler 不接管）：卸载时清未触发的复位定时器。
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      log.warn("copy to clipboard failed", err); // 优雅吞错处留 warn
      return; // 失败不进「已复制」态
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? t("ai.copied", "已复制") : t("ai.copy", "复制")}
      onClick={onCopy}
      className="text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
```

- [ ] **Step 2: 同步 i18n key**

Run: `pnpm i18n:extract`
Expected: `zh-CN.ts` 新增 `"ai.copied": "已复制"`、`"ai.copy": "复制"`（按字母序，`copied` 在 `copy` 前）；`en.ts` 新增同名空串 `""`。

自查 diff：`git diff src/shared/i18n/locales` 应只见这两 key 的增加，无既有 key 被删。

- [ ] **Step 3: 手填英文译文**

编辑 `src/shared/i18n/locales/en.ts`，把空串改为：

```ts
  "ai.copied": "Copied",
  "ai.copy": "Copy",
```

- [ ] **Step 4: typecheck + lint + i18n:lint**

Run: `pnpm i18n:lint && pnpm typecheck && pnpm lint`
Expected: i18n 无缺漏；typecheck 无错；lint 无错。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/ai/CopyButton.tsx src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "$(cat <<'EOF'
feat(ai): add CopyButton for chat messages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `MessageToolbar` 组件 + 接入两气泡

**Files:**

- Create: `src/renderer/ai/MessageToolbar.tsx`
- Modify: `src/renderer/ai/MessageList.tsx`（两气泡加 `group` + 挂工具栏、加 import）
- Modify: `src/shared/i18n/locales/en.ts`（手填 `ai.messageActions` 英文）

- [ ] **Step 1: 创建 `MessageToolbar.tsx`**

```tsx
import { useTranslation } from "react-i18next";
import { CopyButton } from "@renderer/ai/CopyButton";
import { textOf } from "@renderer/ai/message-text";
import type { ChatUIMessage } from "@renderer/ai/types";

/** 气泡下方 hover/focus 揭示的动作行。当前仅复制；后续动作直接内联加入，不预造抽象。 */
export function MessageToolbar({ m }: { m: ChatUIMessage }) {
  const { t } = useTranslation();
  return (
    <div
      role="toolbar"
      aria-label={t("ai.messageActions", "消息操作")}
      className="mt-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
    >
      <CopyButton text={textOf(m)} />
    </div>
  );
}
```

- [ ] **Step 2: 接入 `MessageList.tsx` — 加 import**

在 `@renderer/ai/*` import 区加：

```tsx
import { MessageToolbar } from "@renderer/ai/MessageToolbar";
```

- [ ] **Step 3: 接入 `UserBubble`**

把 `UserBubble` 的 `return` 外层（`:69-91`）由：

```tsx
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[88%] rounded-2xl rounded-br-sm bg-primary px-3 py-2.5 text-primary-foreground">
```

改为外层加 `group`，并在内层气泡 `</div>` 之后、外层 `</div>` 之前挂工具栏：

```tsx
return (
  <div className="group flex flex-col items-end">
    <div className="max-w-[88%] rounded-2xl rounded-br-sm bg-primary px-3 py-2.5 text-primary-foreground">
      {/* …chips 区与正文不变… */}
    </div>
    <MessageToolbar m={m} />
  </div>
);
```

（即：仅在外层 `div` 的 className 前缀加 `group `，并在气泡 `div` 闭合后新增 `<MessageToolbar m={m} />`。气泡内部 chips 区与 `{textOf(m)}` 正文保持原样。）

- [ ] **Step 4: 接入 `AssistantBubble`（含流式态门控）**

把 `AssistantBubble` 的 `return`（`:107-123`）由：

```tsx
return (
  <div className="flex flex-col items-start">
    <div className="max-w-[88%] space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
      {segs.map((s, i) =>
        s.kind === "text" ? (
          <LocalizedStreamdown key={i}>{s.text}</LocalizedStreamdown>
        ) : (
          <ToolStepRow key={i} part={s.part} chapters={chapters} />
        ),
      )}
      {streaming && !hasText && <span className="inline-block animate-pulse text-primary">▍</span>}
    </div>
  </div>
);
```

改为外层加 `group`，并在气泡 `div` 闭合后挂工具栏——**仅非流式时渲染**（避免复制半截内容）：

```tsx
return (
  <div className="group flex flex-col items-start">
    <div className="max-w-[88%] space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
      {segs.map((s, i) =>
        s.kind === "text" ? (
          <LocalizedStreamdown key={i}>{s.text}</LocalizedStreamdown>
        ) : (
          <ToolStepRow key={i} part={s.part} chapters={chapters} />
        ),
      )}
      {streaming && !hasText && <span className="inline-block animate-pulse text-primary">▍</span>}
    </div>
    {!streaming && <MessageToolbar m={m} />}
  </div>
);
```

（`if (segs.length === 0 && !streaming) return null` 提前返回保持不变——空消息既不渲染气泡也不挂工具栏。）

- [ ] **Step 5: 同步 i18n key**

Run: `pnpm i18n:extract`
Expected: `zh-CN.ts` 新增 `"ai.messageActions": "消息操作"`；`en.ts` 新增同名空串。自查 diff 仅此一 key 增加。

- [ ] **Step 6: 手填英文译文**

编辑 `src/shared/i18n/locales/en.ts`：

```ts
  "ai.messageActions": "Message actions",
```

- [ ] **Step 7: typecheck + lint + i18n:lint + 测试**

Run: `pnpm i18n:lint && pnpm typecheck && pnpm lint && pnpm test src/renderer/ai`
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/ai/MessageToolbar.tsx src/renderer/ai/MessageList.tsx src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "$(cat <<'EOF'
feat(ai): reveal a copy toolbar under chat messages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: changeset + 终验

**Files:**

- Create: `.changeset/message-copy.md`

- [ ] **Step 1: 写 changeset**

`.changeset/message-copy.md`：

```md
---
"marginalia": patch
---

Add a copy button to AI chat messages. Hovering (or keyboard-focusing) any message in the AI panel reveals a small toolbar; the copy action places the message's markdown source on the clipboard, so you can paste a reply into notes or feed it back into another prompt. Works for both AI replies and your own messages.
```

- [ ] **Step 2: 全量自动门**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm i18n:lint && pnpm test src/renderer/ai`
Expected: 全部通过。

- [ ] **Step 3: 提交 changeset**

```bash
git add .changeset/message-copy.md
git commit -m "$(cat <<'EOF'
chore: changeset for AI message copy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: dev CDP 冒烟（目视断言）**

按本仓惯例启动 dev（`pnpm start`，用 `--user-data-dir` 隔离）并经 CDP 目视核对：

1. hover 一条 AI 回复气泡 → 下方工具栏淡入；移开 → 淡出。
2. 点 copy → 图标由 `Copy` 切为 `Check`、≈1.5s 自动复位。
3. 粘贴到外部编辑器 → 内容为 **markdown 源**（含 `#` / `-` / 代码围栏等原始标记，而非渲染后纯文本）。
4. hover 一条用户消息 → 同样出现工具栏，复制内容为**正文文本**（不含 context chips）。
5. 键盘 `Tab` 聚焦到工具栏按钮 → 工具栏因 `group-focus-within` 揭示。
6. 在 AI 回复**流式进行中** → 工具栏不出现；流式结束后出现。

冒烟通过后，本计划完成；交付收尾（changeset 已在、close #67、挪 Done）走 `finishing-a-development-branch` 流程。

---

## Self-Review（计划自查记录）

- **Spec coverage**：§2 决策（markdown 源 / 两类消息 / 整条 / 不含 chips / 方案 A）→ Task 1（textOf 取 markdown 源）+ Task 2（clipboard 方案 A）+ Task 3（两气泡接入、用户消息走 `textOf` 仅正文）；§2.1 toolbar 无抽象 → Task 3 MessageToolbar 仅含一按钮；§4.4 流式门控 → Task 3 Step 4；§5 i18n 三 key → Task 2/3 extract+填英文；§6 测试 → Task 1 单测 + Task 4 冒烟；§7 影响面（纯渲染层）→ 无主进程/IPC/DB 任务，吻合。无遗漏。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码。
- **Type consistency**：`textOf(m: ChatUIMessage): string` 在 Task 1 定义，Task 3 `MessageToolbar` 与 `MessageList`/`UserBubble` 一致调用 `textOf(m)`；`CopyButton` props `{ text: string }` 与 `MessageToolbar` 传入 `textOf(m)`（string）一致；i18n key `ai.copy`/`ai.copied`/`ai.messageActions` 三处定义与使用一致。
