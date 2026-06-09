/** 还原版本兼容判定（纯函数）：备份的 schemaHead 必须 ∈ 当前 app 的迁移目录集。
 * 命中 = 备份 schema 等于或早于当前（重启后迁移补齐）；未命中 = 备份来自更新版本，无法降级。 */
export function checkRestoreCompatibility(
  bundleSchemaHead: string,
  knownMigrationDirs: string[],
): { compatible: boolean; reason?: string } {
  if (!bundleSchemaHead) {
    return { compatible: false, reason: "backup manifest has no schema head" };
  }
  if (knownMigrationDirs.includes(bundleSchemaHead)) return { compatible: true };
  return {
    compatible: false,
    reason: `backup is from a newer app version (unknown migration ${bundleSchemaHead}); cannot downgrade`,
  };
}
