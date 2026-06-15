import { protocol } from "electron";
import { getDb } from "@main/db/instance";
import { blobResponseFor } from "@main/media/blob-store";

/** 注册 media:// 为 privileged/secure scheme。必须在 app.ready 之前调用（main.ts 顶层）。 */
export function registerMediaProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/**
 * 挂 media:// handler。本期路由：
 *   media://blob/<blobId> → blob 表字节
 * 未知 host / 缺失 → 404。必须在 app.ready 内、initDb() 之后调用（handler 取 getDb()）。
 */
export function registerMediaProtocol(): void {
  protocol.handle("media", (request) => {
    const url = new URL(request.url);
    if (url.host !== "blob") return new Response(null, { status: 404 });
    const id = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const hit = blobResponseFor(getDb(), id);
    if (!hit) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(hit.bytes), {
      headers: { "content-type": hit.contentType },
    });
  });
}
