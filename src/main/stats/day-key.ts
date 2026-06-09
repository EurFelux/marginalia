/** 把毫秒时间戳格式化为**本地**日期键 'YYYY-MM-DD'（纯函数）。 */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
