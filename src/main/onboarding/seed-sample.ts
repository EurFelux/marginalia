import type { DB } from "@main/db/client";
import type { UILanguage } from "@shared/i18n/language";
import { importBook } from "@main/library/repository";
import { writeBookFile } from "@main/library/book-files";
import { getAppMeta, setAppMeta } from "@main/app-meta/repository";
import { buildSampleEpub } from "@main/onboarding/sample-book";
import { createLogger } from "@main/logger";

const log = createLogger("onboarding");

/**
 * 首启幂等播种内置样书：未播过则按 language 构建并导入一本（DB 行 + 磁盘文件副本），置 sampleSeeded 标记。
 * 已播过（含用户删书后）直接返回——删了不再自动塞回。失败留 warn 不置标记，下次重试。
 * booksDir 注入（appService.getPath("booksDir")），与正常导入路径写同一位置，故样书可正常打开阅读。
 */
export async function maybeSeedSampleBook(
  db: DB,
  language: UILanguage,
  booksDir: string,
): Promise<void> {
  if (getAppMeta(db, "sampleSeeded") === true) return;
  try {
    const bytes = buildSampleEpub(language);
    const book = await importBook(db, { bytes });
    await writeBookFile(booksDir, book.id, book.format, bytes);
    setAppMeta(db, "sampleSeeded", true);
    log.info(`seeded sample book (${language})`);
  } catch (err) {
    log.warn("sample book seed failed", err);
  }
}
