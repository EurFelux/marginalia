/**
 * IPC 调用失败时给用户看的错误文案：去掉 Electron 包的
 * `Error invoking remote method '<channel>': Error: ` 前缀，只留主进程抛出的原文。
 */
export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, "");
}
