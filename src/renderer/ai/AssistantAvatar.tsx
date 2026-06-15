import { usePrefsStore } from "@renderer/store/prefs-store";
import { cn } from "@renderer/lib/utils";
import defaultAvatarUrl from "@renderer/ai/default-avatar.svg";

/**
 * Assistant 头像：有 avatarBlobId 走 media://blob/{id}（id 变即 URL 变、天然刷新），
 * 否则用内置默认 svg。圆形；尺寸由 className 控制（对话内小、设置预览大）。
 */
export function AssistantAvatar({ className }: { className?: string }) {
  const blobId = usePrefsStore((s) => s.avatarBlobId);
  const src = blobId ? `media://blob/${encodeURIComponent(blobId)}` : defaultAvatarUrl;
  return (
    <img
      src={src}
      alt=""
      className={cn("shrink-0 rounded-full object-cover", className)}
      onError={(e) => {
        // 协议异常兜底：回落默认 svg（避免破图）。
        if (e.currentTarget.src !== defaultAvatarUrl) e.currentTarget.src = defaultAvatarUrl;
      }}
    />
  );
}
