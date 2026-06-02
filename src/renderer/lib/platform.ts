/** 当前是否 macOS（渲染层按 UA 判定；navigator 在渲染进程总可用）。 */
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** 主修饰键的平台字符：macOS 显示 ⌘，其余显示 Ctrl。用于快捷键展示。 */
export const modKeyLabel = isMac ? "⌘" : "Ctrl";
