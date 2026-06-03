import { protocol } from "electron";
import { getDb } from "@main/db/instance";
import { coverResponseFor } from "@main/library/cover-bytes";

/** 注册 cover:// 为 privileged/secure scheme。必须在 app.ready 之前调用（main.ts 顶层）。 */
export function registerCoverProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "cover", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/**
 * 挂 cover:// handler：cover://b/<encodeURIComponent(bookId)> → 读 books.cover 返回图片。
 * 必须在 app.ready 内、initDb() 之后调用（handler 取 getDb()）。
 */
export function registerCoverProtocol(): void {
  protocol.handle("cover", (request) => {
    const id = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
    const hit = coverResponseFor(getDb(), id);
    if (!hit) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(hit.bytes), {
      headers: { "content-type": hit.contentType },
    });
  });
}
