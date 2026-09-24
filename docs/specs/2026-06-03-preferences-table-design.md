# `preferences` 持久化表 · 设计文档

> 状态：用户 2026-06-03 指定（ROADMAP「基建/重构」）；夜间无人值守自驱实现，留待醒来审阅。后端全程 headless 可测；渲染层 hydrate 接线留 GUI 手验标注。

## 1. 背景与动机

用户偏好现散落两处且都不入 DB：`autoSummarize` 走 zustand `persist`→**localStorage**；`ReaderPrefs`（字号/行距/栏宽）与 `lastHighlightStyle`（RA3）仅 **reader-store 内存态**，重启即丢。

目标：建主进程 **`preferences` 表**（`key text` + `value json text`）+ **类型化 `key → value` 服务层**（Zod 单一源），把上述偏好收口到 DB——单一真相源、跨重启稳定、为后续「颜色模式」「设备间同步」铺路。遵循项目「主进程厚 / shared Zod 单一源 / 纯函数注入 DB」骨架。

## 2. 范围

**本轮持久化的 key**（有真实消费方者，YAGNI）：

| key                  | 值类型                                | 现状 → 改为            |
| -------------------- | ------------------------------------- | ---------------------- |
| `readerPrefs`        | `{ fontScale; lineHeight; maxWidth }` | reader-store 内存 → DB |
| `lastHighlightStyle` | `AnnotationStyle`（6 值枚举）         | reader-store 内存 → DB |
| `autoSummarize`      | `boolean`                             | localStorage → DB      |

**不含**：`colorMode`（颜色模式 UI 未落地，零消费方）——键注册表易扩展，待该功能落地时加。

## 3. 设计

### 3.1 DB（`src/main/db/schema.ts`）

```ts
export const preferences = sqliteTable("preferences", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(), // 任意 JSON，按 key 的 Zod schema 校验
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});
```

`pnpm db:generate` 出迁移（新建表，无表重建 → 不触发 FK 坑）。

### 3.2 Shared 单一源（`src/shared/preferences.ts`）

每个 key 一个 Zod schema，集中注册（值校验的唯一源）：

```ts
import { z } from "zod";
import { annotationStyle } from "@shared/annotations";

export const readerPrefsSchema = z.object({
  fontScale: z.number(),
  lineHeight: z.number(),
  maxWidth: z.number().int(),
});
export type ReaderPrefs = z.infer<typeof readerPrefsSchema>;

export const PREFERENCE_SCHEMAS = {
  readerPrefs: readerPrefsSchema,
  lastHighlightStyle: annotationStyle,
  autoSummarize: z.boolean(),
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_SCHEMAS;
export type PreferenceValue<K extends PreferenceKey> = z.infer<(typeof PREFERENCE_SCHEMAS)[K]>;
export const preferenceKey = z.enum(
  Object.keys(PREFERENCE_SCHEMAS) as [PreferenceKey, ...PreferenceKey[]],
);
/** 全偏好快照（hydrate 用）：仅含已存且校验通过的 key。 */
export type PreferencesSnapshot = Partial<{ [K in PreferenceKey]: PreferenceValue<K> }>;
```

`@renderer/types` 的 `ReaderPrefs` interface 改为 `export type { ReaderPrefs } from "@shared/preferences"`（结构同，收口单一源）。

### 3.3 服务层（`src/main/preferences/repository.ts`，纯函数注入 DB）

```ts
export function getPreference<K extends PreferenceKey>(db: DB, key: K): PreferenceValue<K> | null {
  const row = db.select().from(preferences).where(eq(preferences.key, key)).get();
  if (!row) return null;
  const parsed = PREFERENCE_SCHEMAS[key].safeParse(row.value);
  return parsed.success ? (parsed.data as PreferenceValue<K>) : null; // 损坏/陈旧 JSON → null（调用方退默认）
}

export function setPreference<K extends PreferenceKey>(
  db: DB,
  key: K,
  value: PreferenceValue<K>,
): void {
  const validated = PREFERENCE_SCHEMAS[key].parse(value); // 写前校验；非法抛
  const now = Date.now();
  db.insert(preferences)
    .values({ key, value: validated, updatedAt: now })
    .onConflictDoUpdate({ target: preferences.key, set: { value: validated, updatedAt: now } })
    .run();
}

export function getAllPreferences(db: DB): PreferencesSnapshot {
  /* 遍历已存行，逐 key safeParse，跳过损坏 */
}
```

### 3.4 IPC（`src/shared/ipc.ts` + `src/main/ipc/preferences-handlers.ts` + `src/preload.ts`）

- `preferences:get-all` → `PreferencesSnapshot`（渲染层启动一次性 hydrate）。
- `preferences:set`：input `{ key: preferenceKey, value: z.unknown() }`（边界校验 channel 形状 + key 合法）；value 的形状校验由 `setPreference` 的 `PREFERENCE_SCHEMAS[key].parse` 兜底（单一源，不在 IPC schema 重复联合）。invalid value → 抛 → IPC 返回错误。
- preload：`window.api.preferences.getAll()` / `.set(key, value)`（类型用 `@shared/preferences`）。

### 3.5 渲染层接线（GUI 手验标注）

- 启动时 `preferences:get-all` → hydrate `reader-store`（prefs、lastHighlightStyle）与 `autoSummarize`；缺失/损坏的 key 退各自默认。
- 变更时 `updatePrefs`/`setLastHighlightStyle`/`setAutoSummarize` 内 fire-and-forget `window.api.preferences.set(...)`（乐观本地态 + 异步落盘）。
- 移除 `prefs-store` 的 localStorage `persist`（改 DB）；保留 store 默认值作未 hydrate 前的初值。
- **hydrate 时序**：`get-all` 异步，到达前先用默认渲染，到达后 set 入 store（reader-store 的 CFI 进度恢复同理已是异步，无冲突）。

> ⚠️ 渲染层部分需 GUI 手验：改字号/行距/栏宽 + 选高亮色 + 切自动摘要 → **重启** → 确认全部保留。夜间我做完接线 + typecheck，留此清单待醒来验。

## 4. 测试（headless）

`src/main/preferences/repository.test.ts`（`:memory:`）：

- set 后 get 往返各 key（readerPrefs 对象 / lastHighlightStyle 枚举 / autoSummarize 布尔）；
- get 未存 key → null；
- set 同 key 覆盖（upsert）+ updatedAt 刷新；
- 存了损坏/陈旧 JSON（直插非法 value）→ get 返回 null（不抛）、getAll 跳过；
- setPreference 写非法 value → 抛；
- getAllPreferences 返回全部已存且合法的 key。

`src/shared/preferences.test.ts`：schema 校验（readerPrefsSchema 拒缺字段；preferenceKey 拒未知 key）。
迁移：`client.test.ts` 既有「runMigrations 往返」覆盖建表；可补 preferences 表 FK-free 建表断言（非必需）。

回归判据：现 192 测试不破 + 新增测试全绿；`pnpm typecheck`/`pnpm lint` 绿。

## 5. 非目标

- 颜色模式（独立 backlog；键待该功能落地再注册）。
- 设备间同步 / 偏好导入导出（远期）。
- 偏好的迁移/版本化（schema 变更时靠 safeParse 退默认，已足够 pre-release）。
