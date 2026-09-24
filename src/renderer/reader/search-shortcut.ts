import { isMac } from "@renderer/lib/platform";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useSearchStore } from "@renderer/store/search-store";

/** ⌘F（macOS）/ Ctrl+F（其他平台），不含其他修饰键。 */
export function isFindShortcut(e: KeyboardEvent, mac = isMac): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f";
}

/** 打开书内搜索：侧栏收起时展开，切到搜索页并请求聚焦输入框。 */
export function openBookSearch(): void {
  const { layout, updateLayout } = usePrefsStore.getState();
  if (!layout.sidebarOpen) updateLayout({ sidebarOpen: true });
  useNavigationStore.getState().setSidebarTab("search");
  useSearchStore.getState().requestFocus();
}

/** 阅读器 keydown 处理：document 与 ePub iframe 文档共用。 */
export function handleFindShortcut(e: KeyboardEvent): void {
  if (!isFindShortcut(e)) return;
  e.preventDefault();
  openBookSearch();
}
