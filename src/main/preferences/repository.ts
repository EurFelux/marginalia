import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { preferences } from "@main/db/schema";
import {
  PREFERENCE_SCHEMAS,
  type PreferenceKey,
  type PreferenceValue,
  type PreferencesSnapshot,
} from "@shared/preferences";

/** 读单个偏好；未存或存的 JSON 不合当前 schema（陈旧/损坏）→ null（调用方退默认）。 */
export function getPreference<K extends PreferenceKey>(db: DB, key: K): PreferenceValue<K> | null {
  const row = db.select().from(preferences).where(eq(preferences.key, key)).get();
  if (!row) return null;
  const parsed = PREFERENCE_SCHEMAS[key].safeParse(row.value);
  return parsed.success ? (parsed.data as PreferenceValue<K>) : null;
}

/** 写单个偏好（upsert）；写前按 key 的 schema 校验，非法值抛错。 */
export function setPreference<K extends PreferenceKey>(
  db: DB,
  key: K,
  value: PreferenceValue<K>,
): void {
  const validated = PREFERENCE_SCHEMAS[key].parse(value);
  const now = Date.now();
  db.insert(preferences)
    .values({ key, value: validated, updatedAt: now })
    .onConflictDoUpdate({ target: preferences.key, set: { value: validated, updatedAt: now } })
    .run();
}

/** 全偏好快照（渲染层启动一次性 hydrate）：仅含已存且校验通过的 key，跳过未知/损坏。 */
export function getAllPreferences(db: DB): PreferencesSnapshot {
  const out: PreferencesSnapshot = {};
  for (const row of db.select().from(preferences).all()) {
    const schema = PREFERENCE_SCHEMAS[row.key as PreferenceKey];
    if (!schema) continue; // 注册表已删的陈旧 key
    const parsed = schema.safeParse(row.value);
    if (parsed.success)
      (out as Record<PreferenceKey, unknown>)[row.key as PreferenceKey] = parsed.data;
  }
  return out;
}
