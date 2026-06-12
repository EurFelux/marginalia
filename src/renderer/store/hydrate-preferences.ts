import { usePrefsStore } from "@renderer/store/prefs-store";

/**
 * 启动时从主进程同步快照 hydrate 偏好（缺失/损坏的 key 保持 store 默认值）。
 * 快照由 preload 在首帧前经 sendSync 取好缓存（window.api.preferences.getAll() 同步返回）。
 * 用 setState 直写（非 action）以免触发各 action 的回写持久化。在 App 挂载时调用一次。
 * 注：colorMode 不在此处处理——已由 theme-store 在初始化时从同一份快照同步接管。
 */
export function hydratePreferences(): void {
  if (typeof window === "undefined" || !window.api?.preferences) return;
  const snap = window.api.preferences.getAll();
  if (snap.readerPrefs) usePrefsStore.setState({ prefs: snap.readerPrefs });
  if (snap.readerLayout) usePrefsStore.setState({ layout: snap.readerLayout });
  if (snap.lastHighlightStyle) {
    usePrefsStore.setState({ lastHighlightStyle: snap.lastHighlightStyle });
  }
  if (snap.autoSummarize !== undefined) {
    usePrefsStore.setState({ autoSummarize: snap.autoSummarize });
  }
  if (snap.chatModel) usePrefsStore.setState({ chatModel: snap.chatModel });
  if (snap.summaryModel) usePrefsStore.setState({ summaryModel: snap.summaryModel });
  if (snap.pdfZoom !== undefined) usePrefsStore.setState({ pdfZoom: snap.pdfZoom });
  if (snap.stepLimit !== undefined) usePrefsStore.setState({ stepLimit: snap.stepLimit });
  if (snap.onboardingDismissed !== undefined) {
    usePrefsStore.setState({ onboardingDismissed: snap.onboardingDismissed });
  }
  if (snap.memoryEnabled !== undefined) {
    usePrefsStore.setState({ memoryEnabled: snap.memoryEnabled });
  }
  if (snap.soul) usePrefsStore.setState({ soul: snap.soul });
  if (snap.instructions !== undefined) usePrefsStore.setState({ instructions: snap.instructions });
  if (snap.ttsPrefs) usePrefsStore.setState({ ttsPrefs: snap.ttsPrefs });
}
