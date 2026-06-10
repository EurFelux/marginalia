import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { appMeta } from "@main/db/schema";

/** 应用内部状态键（非用户偏好，渲染层不可见）。新增内部标记＝在此加一个字面量。 */
export type AppMetaKey = "sampleSeeded";

/** 读应用内部状态；未存返回 null。value 为存入时的任意 JSON。 */
export function getAppMeta(db: DB, key: AppMetaKey): unknown {
  const row = db.select().from(appMeta).where(eq(appMeta.key, key)).get();
  return row ? row.value : null;
}

/** 写应用内部状态（upsert）。 */
export function setAppMeta(db: DB, key: AppMetaKey, value: unknown): void {
  const now = Date.now();
  db.insert(appMeta)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: now } })
    .run();
}
