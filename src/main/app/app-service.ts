/**
 * AppService：Electron API 的抽象层（端口-适配器中的端口）。
 * 本模块不 import electron——main.ts 注入环境值与能力实现（适配器），
 * 业务/基础设施模块面向本抽象编程，整条依赖链无头可测。
 * Spec: docs/superpowers/specs/2026-06-07-app-service-design.md
 */
import path from "node:path";

/** main.ts 注入的运行环境实现。字段平台无关——不绑 Electron 术语 */
export interface AppServiceEnv {
  /** 应用数据根目录（Electron 适配 = app.getPath("userData")）——注入后存于 #env 私有字段，永不对外暴露 */
  dataDir: string;
  /** 是否开发模式（Electron 适配 = !app.isPackaged） */
  isDev: boolean;
  /** 在系统文件管理器中打开目录（Electron 适配 = shell.openPath，吞掉其 string 返回值）。
   * 归属注：语义上更适合未来的 FileService（文件管理模块）；该模块尚无设计，暂栖于此。 */
  openFolder: (dir: string) => Promise<void>;
}

/** 数据路径 key（类型化，按需扩展）——dir/file 语义编码在 key 名里：*Dir 目录、*File 完整文件路径。
 * logsDir → LoggerService；booksDir → 书籍副本；dbFile → SQLite 数据库（历史布局均零迁移） */
export type DataPathKey = "logsDir" | "booksDir" | "dbFile" | "tmpDir" | "preRestoreDir";

/** key → 相对 dataDir 的路径。映射是 AppService 的内部策略——布局与文件名知识收归此处 */
const DATA_PATHS: Record<DataPathKey, string> = {
  logsDir: "logs",
  booksDir: "books",
  dbFile: "marginalia.db", // 历史布局：db 三件套在 dataDir 根（改动布局需数据迁移）
  tmpDir: "tmp", // 备份导出/还原的同盘暂存区（rename 不跨设备）
  preRestoreDir: "pre-restore", // 还原前的当前数据安全副本父目录（pre-restore/<ts>/）
};

/** 类不导出：消费方只能经 barrel 拿 appService，无法绕过封装 */
class AppService {
  #env: AppServiceEnv | null = null;

  /** 重复注入 last-wins：测试内按需重新注入依赖此语义 */
  init(env: AppServiceEnv): void {
    this.#env = env;
  }

  /**
   * 恒可用是全局不变量：生产由 main.ts 启动注入保证（失败即崩），
   * 测试由 vitest 全局 setup 注入保证。未注入即访问 = 初始化顺序 bug，fail-fast。
   */
  get #required(): AppServiceEnv {
    if (!this.#env) {
      throw new Error("AppService not initialized — initAppService must run before any consumer");
    }
    return this.#env;
  }

  /** module 专有数据路径（key → 路径的映射为内部策略）。纯计算不碰 fs——目录创建是消费方的事 */
  getPath(key: DataPathKey): string {
    return path.join(this.#required.dataDir, DATA_PATHS[key]);
  }

  get isDev(): boolean {
    return this.#required.isDev;
  }

  openFolder(dir: string): Promise<void> {
    return this.#required.openFolder(dir);
  }
}

const service = new AppService();

/** 生命周期钩子：仅 main.ts 与测试（vitest setup / 单测重注入）深导入调用，不进 barrel */
export function initAppService(env: AppServiceEnv): void {
  service.init(env);
}

/** 只读单例——barrel 唯一导出。原始 dataDir 不暴露：目录布局知识收归此处 */
export const appService: {
  getPath(key: DataPathKey): string;
  readonly isDev: boolean;
  openFolder(dir: string): Promise<void>;
} = service;
