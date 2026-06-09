import { count } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books } from "@main/db/schema";
import { BACKUP_FORMAT_VERSION, type BackupManifest } from "@shared/backup";

/** 组装备份 manifest。读 bookCount；其余由胶水层注入（schemaHead/dbSha256/appVersion）。 */
export function buildManifest(
  db: DB,
  opts: { appVersion: string; schemaHead: string; dbSha256: string },
): BackupManifest {
  const [{ c }] = db.select({ c: count() }).from(books).all();
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: opts.appVersion,
    schemaHead: opts.schemaHead,
    createdAt: Date.now(),
    bookCount: c,
    includesApiKeys: true,
    dbSha256: opts.dbSha256,
  };
}
