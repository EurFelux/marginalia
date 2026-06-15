import type { DB } from "@main/db/client";
import type { AvatarPickResult } from "@shared/agent";
import { sniffImageType } from "@main/library/cover-bytes";
import { writeBlob, deleteBlob } from "@main/media/blob-store";
import { getPreference, setPreference } from "@main/preferences/repository";

/** 头像上传大小上限：2 MB（spec §5）。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 校验并存头像字节：写新 blob → 切 avatarBlobId → 删旧 blob（GC）。返回判别结果。 */
export function storeAvatar(db: DB, bytes: Uint8Array): AvatarPickResult {
  if (bytes.byteLength > AVATAR_MAX_BYTES) return { status: "too-large" };
  const mime = sniffImageType(bytes);
  if (!ALLOWED.has(mime)) return { status: "unsupported" };
  const prev = getPreference(db, "avatarBlobId");
  const blobId = writeBlob(db, bytes, mime);
  setPreference(db, "avatarBlobId", blobId);
  if (prev) deleteBlob(db, prev);
  return { status: "set", blobId };
}

/** 重置为默认：删当前头像 blob + 置 avatarBlobId=null。无头像时无害。 */
export function resetAvatar(db: DB): void {
  const prev = getPreference(db, "avatarBlobId");
  setPreference(db, "avatarBlobId", null);
  if (prev) deleteBlob(db, prev);
}
