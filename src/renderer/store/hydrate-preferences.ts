import { useReaderStore } from "@renderer/store/reader-store";
import { usePrefsStore } from "@renderer/store/prefs-store";

/**
 * 启动时从主进程同步快照 hydrate 各 store（缺失/损坏的 key 保持 store 默认值）。
 * 快照由 preload 在首帧前经 sendSync 取好缓存（window.api.preferences.getAll() 同步返回）。
 * 用 setState 直写（非 action）以免触发各 action 的回写持久化。在 App 挂载时调用一次。
 * 注：colorMode 不在此处处理——已由 theme-store 在初始化时从同一份快照同步接管（preload 已挂好 .dark）。
 */
export function hydratePreferences(): void {
  if (typeof window === "undefined" || !window.api?.preferences) return;
  const snap = window.api.preferences.getAll();
  if (snap.readerPrefs) useReaderStore.setState({ prefs: snap.readerPrefs });
  if (snap.lastHighlightStyle) {
    useReaderStore.setState({ lastHighlightStyle: snap.lastHighlightStyle });
  }
  if (snap.autoSummarize !== undefined) {
    usePrefsStore.setState({ autoSummarize: snap.autoSummarize });
  }
}
