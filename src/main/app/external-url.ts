const ALLOWED = new Set(["http:", "https:", "mailto:"]);

/** 外链协议白名单：仅放行 http/https/mailto，拒 file/javascript/data 等（防 shell.openExternal 被滥用）。 */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return ALLOWED.has(new URL(url).protocol);
  } catch {
    return false; // 非法 URL
  }
}
