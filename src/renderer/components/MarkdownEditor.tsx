import { useEffect, useRef } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { cn } from "@renderer/lib/utils";

/**
 * Markdown 语法高亮样式（Obsidian 源码模式观感，CM 阶段一）：标题分级放大、粗斜体
 * 真实呈现、引用/标记符弱化。颜色引用 app 的 shadcn CSS 变量，自动跟随明暗主题。
 * 阶段二（live preview：隐藏非活动行标记、内联渲染）在此内核上叠 decoration 演进。
 */
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.35em", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "1.2em", fontWeight: "700" },
  { tag: tags.heading3, fontSize: "1.1em", fontWeight: "700" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: tags.monospace,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.9em",
    backgroundColor: "color-mix(in oklch, var(--muted) 70%, transparent)",
    borderRadius: "3px",
  },
  { tag: tags.quote, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "var(--primary)", textDecoration: "underline" },
  // 标记符（# ** > - 等）与 meta 弱化，正文内容浮出
  {
    tag: [tags.processingInstruction, tags.meta, tags.punctuation],
    color: "var(--muted-foreground)",
  },
]);

/** 编辑器底盘样式：透明底融入容器、继承容器字体（盖掉 CM 默认 monospace）。 */
const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "0.875rem", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 10px" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
});

interface MarkdownEditorProps {
  /** 初始文本（非受控：挂载时灌入，此后由编辑器持有；变更经 onChange 上报）。 */
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Cmd/Ctrl+Enter；携带当前全文（从编辑器即时读取，无 state 滞后竞态）。 */
  onSubmit?: (value: string) => void;
  /** Escape。 */
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

/**
 * CodeMirror 6 Markdown 编辑器（语法高亮源码模式）。非受控 + 回调 ref：视图只创建一次，
 * 回调经 ref 转发最新闭包，避免每次渲染重建 EditorView（光标/撤销历史得以保留）。
 */
export function MarkdownEditor({
  defaultValue = "",
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  autoFocus,
  className,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const callbacksRef = useRef({ onChange, onSubmit, onCancel });

  // 渲染后同步最新回调闭包（render 期间不可写 ref——React Compiler 约束）。
  useEffect(() => {
    callbacksRef.current = { onChange, onSubmit, onCancel };
  });

  // 仅挂载时创建视图；defaultValue/autoFocus/placeholder 是初始化参数，变更不重建。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: defaultValue,
        extensions: [
          Prec.high(
            keymap.of([
              {
                key: "Mod-Enter",
                run: (v) => {
                  callbacksRef.current.onSubmit?.(v.state.doc.toString());
                  return true;
                },
              },
              {
                key: "Escape",
                run: () => {
                  callbacksRef.current.onCancel?.();
                  return true;
                },
              },
            ]),
          ),
          history(),
          markdown({ base: markdownLanguage }),
          // markdownKeymap：Enter 自动续列表/引用、Backspace 智能删标记
          keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          syntaxHighlighting(markdownHighlight),
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
          baseTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) callbacksRef.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
      parent: host,
    });
    if (autoFocus) view.focus();
    return () => view.destroy();
    // 初始化参数有意不进依赖：变更不应销毁用户正在编辑的视图。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={hostRef}
      // 外框镜像 Textarea 的观感（边框/圆角/聚焦环），字体走容器继承（font-sans）
      className={cn(
        "min-h-0 overflow-hidden rounded-lg border border-input bg-transparent font-sans transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        className,
      )}
    />
  );
}
