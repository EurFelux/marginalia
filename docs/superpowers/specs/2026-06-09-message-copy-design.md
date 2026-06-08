# AI 聊天消息复制到剪贴板设计

日期：2026-06-09
状态：待与用户对齐（2026-06-09 brainstorming），待实现
关联：GitHub issue #67（polish / area:ai）。需求「为 AI 聊天消息加一键复制」。

## 1. 背景与动机

阅读时用户常想复用 AI 的回复——粘进笔记、分享、或喂回另一个 prompt。现状没有任何复制入口：消息以流式 markdown 渲染（`AssistantBubble` 经 `LocalizedStreamdown`），手动框选很别扭（选区与面板 UI 打架，且渲染后会丢掉 markdown 结构）。本设计加一个**整条消息一键复制 markdown 源**的入口。

## 2. 设计决策（issue 留待 spec 的开放问题）

2026-06-09 brainstorming 与用户对齐：

| 问题             | 决策                                                 | 理由                                                                                                    |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 复制成什么格式   | **Markdown 源码**                                    | 无损保留标题/列表/代码块结构，最适合喂回 prompt 或粘进 markdown 笔记；源码已在 `m.parts`，零提取成本    |
| 哪些消息有此入口 | **AI 回复 + 用户消息**                               | 用户消息亦可复制用于重问/微调                                                                           |
| 复制粒度         | **整条消息**                                         | 代码块/表格的细粒度复制已由 Streamdown 内建；选区复制实现复杂、收益有限（issue 自陈选区与 UI 打架）     |
| 用户消息复制范围 | **仅正文，不含 context chips**                       | chips 是引用的阅读上下文元数据、非消息正文，掺入会让粘贴结果混乱                                        |
| 剪贴板写入机制   | **渲染层 `navigator.clipboard.writeText`（方案 A）** | 复制是纯 UI presentation 副作用（与「聚焦/选区命令在渲染层处理」同类），文本本就在渲染层、无需 IPC 搬运 |

### 2.1 容器：toolbar 而非裸按钮

用户要求气泡下方放一个 **toolbar 容器**承载操作，当前仅 copy，但未来会增加更多操作（如 regenerate / 朗读 等）。

**纪律（YAGNI）**：toolbar 只做成「一个 flex 行容器 + 当前一个 `CopyButton`」。**不**预先引入任何「动作注册表 / 插件化 / 配置驱动渲染」抽象——等真有第二、第三个动作落地时再按需抽象。本设计严格只交付 copy 这一个动作。

## 3. 现状与缺口

`src/renderer/ai/MessageList.tsx`：

- `textOf(m)`（`:16-18`）：把 `m.parts` 里的 text part 拼接、非 text part 取空串——**正好就是消息的 markdown 源**（跳过 tool 步骤这些临时 UI）。现为模块内局部函数，`UserBubble` 渲染正文用它。
- `UserBubble`（`:66-93`）：外层 `<div className="flex flex-col items-end">`，气泡 `bg-primary`，含 context chips 区 + `textOf(m)` 正文。
- `AssistantBubble`（`:95-124`）：外层 `<div className="flex flex-col items-start">`，气泡 `bg-muted`，正文经 `LocalizedStreamdown` 渲染 markdown，夹杂 `ToolStepRow`。
- 两气泡均**无任何操作入口**。

hover 揭示按钮的成熟范式见 `src/renderer/reader/AnnotationsList.tsx:127-135`：`Button variant="ghost" size="icon-xs"` + `opacity-0 transition-opacity group-hover:opacity-100`，父容器加 `group`。本设计复用此范式并补一手 `group-focus-within` 的键盘可达性。

## 4. 方案

仅渲染层改动，新增三个聚焦单元 + 改 `MessageList`。

### 4.1 `textOf` 提取为独立模块（`src/renderer/ai/message-text.ts`）

把 `MessageList.tsx` 的局部 `textOf` 提为导出函数，使**渲染正文**与**复制取文**同源（单一真相），且可 headless 单测（独立模块、不引入 React/Streamdown）：

```ts
import type { ChatUIMessage } from "@renderer/ai/types";

/** 拼接消息所有 text part（跳过 tool/step 等非文本 part）——即消息的 markdown 源。 */
export function textOf(m: ChatUIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}
```

`MessageList.tsx` 删除本地 `textOf`、改 import。

### 4.2 `CopyButton`（`src/renderer/ai/CopyButton.tsx`，可复用）

封装：clipboard 写入 + 「已复制」反馈态 + 图标切换（`Copy` → `Check`）+ 动态 aria-label + 失败 warn 日志。

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

要点：

- `navigator.clipboard.writeText` 在 Electron 渲染层 + 用户点击手势（secure context）下可用。
- 失败仅 `log.warn` 优雅降级，不抛、不进反馈态。
- 反馈靠图标切换 + aria-label 切换（屏幕阅读器可感知），1.5s 自动复位。
- 不写 `useCallback`/`useMemo`（React Compiler 自动记忆化）；仅卸载清理这一处命令式 effect 手写。

### 4.3 `MessageToolbar`（`src/renderer/ai/MessageToolbar.tsx`）

气泡下方的 hover 揭示动作行，当前只渲染 `CopyButton`：

```tsx
import { useTranslation } from "react-i18next";
import { CopyButton } from "@renderer/ai/CopyButton";
import { textOf } from "@renderer/ai/message-text";
import type { ChatUIMessage } from "@renderer/ai/types";

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

- `group-focus-within:opacity-100`：键盘 Tab 聚焦到工具栏内按钮时也揭示（hover 范式之外补的 a11y）。
- 接收整条 `m` 是自然的领域对象（toolbar 操作一条消息），非 speculative：当前只用 `textOf(m)`。

### 4.4 接入 `MessageList.tsx`

两气泡外层 flex-col 加 `group`，气泡 div **之后**挂 `<MessageToolbar m={m} />`：

```tsx
// UserBubble：
<div className="group flex flex-col items-end">
  <div className="max-w-[88%] rounded-2xl ...">{/* 气泡原样 */}</div>
  <MessageToolbar m={m} />
</div>

// AssistantBubble：
<div className="group flex flex-col items-start">
  <div className="max-w-[88%] space-y-2 ...">{/* 气泡原样 */}</div>
  <MessageToolbar m={m} />
</div>
```

- 工具栏在 flex-col 内自动随 `items-end`/`items-start` 左右对齐（用户右、AI 左）。
- **AssistantBubble 流式态**：`streaming === true` 时**不**渲染工具栏，流式结束（`streaming` 转 false，气泡重渲染）后才出现——避免复制到不完整内容。`UserBubble` 永不流式，无条件渲染工具栏。沿用既有 `if (segs.length === 0 && !streaming) return null` 提前返回，空消息不挂工具栏。

## 5. i18n

新增三个 key（组件内中文 inline default，`pnpm i18n:extract` 同步 `zh-CN.ts`，再补 `en.ts`）：

| key                 | zh-CN    | en              |
| ------------------- | -------- | --------------- |
| `ai.copy`           | 复制     | Copy            |
| `ai.copied`         | 已复制   | Copied          |
| `ai.messageActions` | 消息操作 | Message actions |

## 6. 测试策略

- **单测**（headless，`src/renderer/ai/message-text.test.ts`）：`textOf` 对「多 text part 拼接」「夹杂 tool part 被跳过」「空 parts → 空串」的行为。守住「复制取文 = 渲染正文 = markdown 源」契约。
- **不**单测 `CopyButton`/`MessageToolbar` 组件交互：渲染层无 `@testing-library/react`（仅 `happy-dom` 用于 DOM helper），React 组件渲染测试未铺；按本仓惯例走冒烟。
- **dev CDP 冒烟**目视断言：① hover AI 回复气泡 → 下方工具栏淡入；② 点 copy → 图标变 `Check`、≈1.5s 复位；③ 粘贴到外部 → 内容为 markdown 源（含 `#`/`-`/` ``` `等标记）；④ 用户消息同样可复制、内容为正文（不含 chips）；⑤ 键盘 Tab 聚焦能揭示工具栏；⑥ 流式进行中工具栏不出现、结束后出现。

## 7. 影响面

- **仅渲染层**；无主进程、IPC、DB、迁移改动。
- 新增：`message-text.ts`（+ `.test.ts`）、`CopyButton.tsx`、`MessageToolbar.tsx`。
- 修改：`MessageList.tsx`（删局部 `textOf`、两气泡加 `group` + 挂 `MessageToolbar`）。
- i18n：新增 3 个 key。
- 用户向 changelog（changeset）：英文一条，「Add a copy button to AI chat messages」。
