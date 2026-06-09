/** 秒 → 人读时长，单位标签经调用方注入（i18n）。0/负 → "0{m}"；整点省略分钟。 */
export function formatDuration(totalSeconds: number, hLabel: string, mLabel: string): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes}${mLabel}`;
  if (minutes === 0) return `${hours}${hLabel}`;
  return `${hours}${hLabel} ${minutes}${mLabel}`;
}
