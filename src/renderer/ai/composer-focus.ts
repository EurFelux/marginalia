import { flushSync } from "react-dom";
import { usePrefsStore } from "@renderer/store/prefs-store";

/**
 * Composer 输入框的命令式聚焦句柄。三个 AI action 入口（use-ai-actions /
 * chat-store / AIPanel）都不在 Composer 的 ref 传递链上，故用模块级注册表承载
 * Composer 暴露的聚焦能力（useImperativeHandle 的精神，因调用方分散改用模块单例）。
 */
let focusFn: (() => void) | null = null;

/** Composer 挂载时注册自身聚焦能力，卸载时传 null 注销。 */
export function registerComposerFocus(fn: (() => void) | null): void {
  focusFn = fn;
}

/** 命令式聚焦输入框（已注册时）；未注册为安全 no-op。 */
export function focusComposer(): void {
  focusFn?.();
}

/**
 * 开 AI 面板并聚焦输入框。flushSync 强制「开面板」那次渲染同步 commit、摘除 inert
 * （关闭态面板子树为 inert，浏览器会吞掉对其内元素的 focus），随即命令式聚焦。
 */
export function openPanelAndFocusComposer(): void {
  flushSync(() => usePrefsStore.getState().updateLayout({ panelOpen: true }));
  focusComposer();
}
