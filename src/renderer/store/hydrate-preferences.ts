import { useReaderStore } from "@renderer/store/reader-store";
import { usePrefsStore } from "@renderer/store/prefs-store";

/**
 * 启动时从主进程 DB 拉全偏好快照，hydrate 各 store（缺失/损坏的 key 保持 store 默认值）。
 * 用 setState 直写（非 action）以免触发各 action 的回写持久化。在 App 挂载时调用一次。
 */
export async function hydratePreferences(): Promise<void> {
  if (typeof window === "undefined" || !window.api?.preferences) return;
  const snap = await window.api.preferences.getAll().catch(() => null);
  if (!snap) return;
  if (snap.readerPrefs) useReaderStore.setState({ prefs: snap.readerPrefs });
  if (snap.lastHighlightStyle) {
    useReaderStore.setState({ lastHighlightStyle: snap.lastHighlightStyle });
  }
  if (snap.autoSummarize !== undefined) {
    usePrefsStore.setState({ autoSummarize: snap.autoSummarize });
  }
}
