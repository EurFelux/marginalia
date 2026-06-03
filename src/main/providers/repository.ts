import { asc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { assistants, providers } from "@main/db/schema";
import type { Encryptor } from "@main/secrets/encryptor";
import type { ProviderTester } from "@main/secrets/tester";
import { maskKey } from "@main/providers/mask";
import type {
  ProviderDto,
  ProviderKeyState,
  TestResult,
  UpsertProviderInput,
} from "@shared/providers";

export type ProviderRow = typeof providers.$inferSelect;

/** 在 main 内解密以产生掩码，明文绝不离开 main。解密失败则优雅降级为 undecryptable。 */
function keyState(cipher: Buffer | null, row: ProviderRow, encryptor: Encryptor): ProviderKeyState {
  if (cipher == null) return { status: "none" };
  try {
    return { status: "set", mask: maskKey(encryptor.decrypt(cipher)) };
  } catch (err) {
    // 跨机迁移属预期；但真实 encryptor 故障也走这里——记日志以便区分（err 来自 OS 钥匙串，不含明文）。
    console.warn(`[providers] toDto: decrypt failed for provider ${row.id}:`, err);
    return { status: "undecryptable" };
  }
}

/** 行 → DTO（密钥存在性收敛为判别联合 key）。 */
function toDto(row: ProviderRow, encryptor: Encryptor): ProviderDto {
  return {
    id: row.id,
    type: row.type,
    compatibleApis: row.compatibleApis ?? [row.type],
    label: row.label ?? null,
    baseUrl: row.baseUrl ?? null,
    key: keyState(row.apiKeyEncrypted, row, encryptor),
    models: row.models ?? [],
    isBuiltin: row.isBuiltin,
    createdAt: row.createdAt,
  };
}

export function getProviderRow(db: DB, id: string): ProviderRow | undefined {
  return db.select().from(providers).where(eq(providers.id, id)).get();
}

export function listProviders(db: DB, encryptor: Encryptor): ProviderDto[] {
  return db
    .select()
    .from(providers)
    .orderBy(asc(providers.createdAt))
    .all()
    .map((r) => toDto(r, encryptor));
}

export function upsertProvider(
  db: DB,
  encryptor: Encryptor,
  input: UpsertProviderInput,
): ProviderDto {
  // 仅当传入新明文 key 时加密；省略 apiKey = 保留既有密钥。
  // label / baseUrl 同理：省略=保留，显式 null=清空（两态；新建时 ?? null 回退正确）。
  let encrypted: Buffer | undefined;
  if (input.apiKey !== undefined) {
    if (!encryptor.isAvailable()) {
      throw new Error("Cannot store API key: OS secure storage is unavailable");
    }
    encrypted = encryptor.encrypt(input.apiKey);
  }

  if (input.id) {
    const existing = getProviderRow(db, input.id);
    if (!existing) throw new Error(`provider ${input.id} not found`);
    // 内置 provider：label / baseUrl 不可改；type 仅可在 compatibleApis 内切换。main 侧防御非法改动。
    if (existing.isBuiltin) {
      const compat = existing.compatibleApis ?? [existing.type];
      if (input.type !== existing.type && !compat.includes(input.type)) {
        throw new Error("内置 provider 的类型只能在兼容 API 内切换");
      }
      if (input.label != null && input.label !== existing.label) {
        throw new Error("内置 provider 的名称不可修改");
      }
      if (input.baseUrl != null && input.baseUrl !== existing.baseUrl) {
        throw new Error("内置 provider 的 baseUrl 不可修改");
      }
    }
    const lockedMeta = existing.isBuiltin; // label / baseUrl 锁定
    const row = db
      .update(providers)
      .set({
        type: input.type, // type 已校验（内置限 compatibleApis；非内置自由）
        ...(!lockedMeta && input.label !== undefined ? { label: input.label } : {}),
        ...(!lockedMeta && input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(encrypted !== undefined ? { apiKeyEncrypted: encrypted } : {}),
        ...(input.models !== undefined ? { models: input.models } : {}),
        // 非内置：compatibleApis 跟随当前 type（内置 compatibleApis 由 config 固定，不动）。
        ...(!existing.isBuiltin ? { compatibleApis: [input.type] } : {}),
      })
      .where(eq(providers.id, input.id))
      .returning()
      .get();
    if (!row) throw new Error(`provider ${input.id} not found`);
    return toDto(row, encryptor);
  }

  const inserted = db
    .insert(providers)
    .values({
      type: input.type,
      compatibleApis: [input.type], // 用户自建：单一当前 type
      label: input.label ?? null,
      baseUrl: input.baseUrl ?? null,
      apiKeyEncrypted: encrypted ?? null,
      models: input.models ?? [],
    })
    .returning()
    .get();
  return toDto(inserted, encryptor);
}

export function removeProvider(db: DB, id: string): void {
  const row = getProviderRow(db, id);
  if (!row) throw new Error(`provider ${id} not found`);
  if (row.isBuiltin) throw new Error("内置 provider 不可删除");
  db.transaction((tx) => {
    // 先解除默认 Assistant 对该 provider 的引用，避免外键约束失败。
    tx.update(assistants).set({ providerId: null }).where(eq(assistants.providerId, id)).run();
    tx.delete(providers).where(eq(providers.id, id)).run();
  });
}

export function revealProviderKey(db: DB, encryptor: Encryptor, id: string): string {
  const row = getProviderRow(db, id);
  if (!row) throw new Error(`provider ${id} not found`);
  if (row.apiKeyEncrypted == null) throw new Error(`provider ${id} has no API key`);
  return encryptor.decrypt(row.apiKeyEncrypted);
}

export async function testProvider(
  db: DB,
  encryptor: Encryptor,
  tester: ProviderTester,
  id: string,
  model: string,
): Promise<TestResult> {
  const row = getProviderRow(db, id);
  if (!row) throw new Error(`provider ${id} not found`);
  if (row.apiKeyEncrypted == null) {
    return { ok: false, message: "No API key set for this provider" };
  }
  let apiKey: string;
  try {
    apiKey = encryptor.decrypt(row.apiKeyEncrypted);
  } catch (err) {
    console.warn(`[providers] testProvider: decrypt failed for provider ${id}:`, err);
    return { ok: false, message: "Stored API key cannot be decrypted on this machine" };
  }
  return tester.test({ type: row.type, baseUrl: row.baseUrl ?? null, apiKey, model });
}
