import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { appMeta } from "@main/db/schema";

/** 应用内部状态键（非用户偏好，渲染层不可见）。新增内部标记＝在此加一个字面量 + 下方 ValueMap 一条。 */
export type AppMetaKey = "sampleSeeded";

/** 每个内部状态键 → 其值类型（与 preferences 仓储的泛型取值同构）。 */
interface AppMetaValueMap {
  sampleSeeded: boolean;
}
type AppMetaValue<K extends AppMetaKey> = AppMetaValueMap[K];

/** 读应用内部状态；未存返回 null。 */
export function getAppMeta<K extends AppMetaKey>(db: DB, key: K): AppMetaValue<K> | null {
  const row = db.select().from(appMeta).where(eq(appMeta.key, key)).get();
  return row ? (row.value as AppMetaValue<K>) : null;
}

/** 写应用内部状态（upsert）。 */
export function setAppMeta<K extends AppMetaKey>(db: DB, key: K, value: AppMetaValue<K>): void {
  const now = Date.now();
  db.insert(appMeta)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: now } })
    .run();
}
