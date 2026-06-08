import type { KeyboardEvent } from "react";

/** isSubmitEnter 实际读取的字段；React.KeyboardEvent 结构兼容，便于单测构造。 */
type SubmitKeyEvent = Pick<KeyboardEvent, "key" | "shiftKey"> & {
  readonly nativeEvent: { readonly isComposing: boolean };
};

/**
 * 「裸 Enter 提交」守卫：Enter、无 Shift、且不处于 IME 组字中（纯函数、可测）。
 *
 * 东亚输入法（中/日/韩）按 Enter 是确认候选词「上屏」，浏览器对这次 keydown 派发的
 * nativeEvent.isComposing 为 true——此时若触发发送/提交，会把半截组字误当成消息发出。
 * 聊天发送、单行表单提交等输入框共用此守卫，免得每处 onKeyDown 各自漏判 IME。
 */
export function isSubmitEnter(e: SubmitKeyEvent): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;
}
