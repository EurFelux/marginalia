// src/main/permissions/repository.ts —— 工具权限规则的增删查（spec 2026-10-03 §5.3）。纯函数注入 DB。
import { and, asc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { permissionRules } from "@main/db/schema";
import { formatPattern, parsePattern } from "@main/permissions/command";
import type {
  AddPermissionRuleInput,
  PermissionRuleDto,
  PermissionTool,
} from "@shared/permissions";

export function listPermissionRules(db: DB, tool?: PermissionTool): PermissionRuleDto[] {
  return db
    .select()
    .from(permissionRules)
    .where(tool ? eq(permissionRules.tool, tool) : undefined)
    .orderBy(asc(permissionRules.createdAt), asc(permissionRules.id))
    .all();
}

/**
 * 新增一条规则；pattern 先规范化（同一前缀不同写法只存一条），已存在则返回原行。
 * pattern 不是纯词序列（含运算符、`$`、换行等）时抛错——这样的前缀永远匹配不上命令。
 */
export function addPermissionRule(db: DB, input: AddPermissionRuleInput): PermissionRuleDto {
  const tokens = parsePattern(input.pattern);
  if (!tokens) {
    throw new Error(
      `invalid rule pattern "${input.pattern}": use plain words only (no ; | & > $ or newlines)`,
    );
  }
  const pattern = formatPattern(tokens);
  const inserted = db
    .insert(permissionRules)
    .values({ tool: input.tool, decision: input.decision, pattern })
    .onConflictDoNothing()
    .returning()
    .get();
  if (inserted) return inserted;
  return db
    .select()
    .from(permissionRules)
    .where(
      and(
        eq(permissionRules.tool, input.tool),
        eq(permissionRules.decision, input.decision),
        eq(permissionRules.pattern, pattern),
      ),
    )
    .get()!;
}

export function deletePermissionRule(db: DB, id: string): void {
  db.delete(permissionRules).where(eq(permissionRules.id, id)).run();
}
