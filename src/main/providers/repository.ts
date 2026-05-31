import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { assistants, providers } from "@main/db/schema";
import type { Encryptor } from "@main/secrets/encryptor";
import type { ProviderTester } from "@main/secrets/tester";
import { maskKey } from "@main/providers/mask";
import type { ProviderDto, TestResult, UpsertProviderInput } from "@shared/providers";

export type ProviderRow = typeof providers.$inferSelect;

/** 行 → DTO：在 main 内解密以产生掩码，明文绝不离开 main。解密失败则优雅降级。 */
function toDto(row: ProviderRow, encryptor: Encryptor): ProviderDto {
  const cipher = row.apiKeyEncrypted;
  let keyMask: string | null = null;
  let keyDecryptable = false;
  if (cipher != null) {
    try {
      keyMask = maskKey(encryptor.decrypt(cipher));
      keyDecryptable = true;
    } catch (err) {
      // 跨机迁移属预期；但真实 encryptor 故障也走这里——记日志以便区分（err 来自 OS 钥匙串，不含明文）。
      console.warn(`[providers] toDto: decrypt failed for provider ${row.id}:`, err);
      keyDecryptable = false;
    }
  }
  return {
    id: row.id,
    type: row.type,
    label: row.label ?? null,
    baseUrl: row.baseUrl ?? null,
    keyMask,
    hasKey: cipher != null,
    keyDecryptable,
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
    .all()
    .map((r) => toDto(r, encryptor));
}

export function upsertProvider(
  db: DB,
  encryptor: Encryptor,
  input: UpsertProviderInput,
): ProviderDto {
  // 仅当传入新明文 key 时加密；省略 apiKey = 保留既有密钥。
  let encrypted: Buffer | undefined;
  if (input.apiKey !== undefined) {
    if (!encryptor.isAvailable()) {
      throw new Error("Cannot store API key: OS secure storage is unavailable");
    }
    encrypted = encryptor.encrypt(input.apiKey);
  }

  if (input.id) {
    const row = db
      .update(providers)
      .set({
        type: input.type,
        label: input.label ?? null,
        baseUrl: input.baseUrl ?? null,
        ...(encrypted !== undefined ? { apiKeyEncrypted: encrypted } : {}),
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
      label: input.label ?? null,
      baseUrl: input.baseUrl ?? null,
      apiKeyEncrypted: encrypted ?? null,
    })
    .returning()
    .get();
  return toDto(inserted, encryptor);
}

export function removeProvider(db: DB, id: string): void {
  if (!getProviderRow(db, id)) throw new Error(`provider ${id} not found`);
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
