import { eq } from "drizzle-orm";
import type { DBTransaction } from "@main/db/client";
import { appMeta } from "@main/db/schema";

/** 应用内部状态键（非用户偏好，渲染层不可见）。新增内部标记＝在此加一个字面量 + 下方 ValueMap 一条。 */
export type AppMetaKey = "sampleSeeded" | "usageLedgerBackfilled";

/** 每个内部状态键 → 其值类型（与 preferences 仓储的泛型取值同构）。 */
interface AppMetaValueMap {
  sampleSeeded: boolean;
  /** 用量账本已从历史消息回填（spec 2026-10-12-ai-usage-stats-design §4.4）。 */
  usageLedgerBackfilled: boolean;
}
type AppMetaValue<K extends AppMetaKey> = AppMetaValueMap[K];

/** 读应用内部状态；未存返回 null。可在事务内调用（DB 亦满足 DBTransaction）。 */
export function getAppMeta<K extends AppMetaKey>(
  db: DBTransaction,
  key: K,
): AppMetaValue<K> | null {
  const row = db.select().from(appMeta).where(eq(appMeta.key, key)).get();
  return row ? (row.value as AppMetaValue<K>) : null;
}

/** 写应用内部状态（upsert）。可在事务内调用。 */
export function setAppMeta<K extends AppMetaKey>(
  db: DBTransaction,
  key: K,
  value: AppMetaValue<K>,
): void {
  const now = Date.now();
  db.insert(appMeta)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: now } })
    .run();
}
