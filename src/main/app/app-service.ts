/**
 * AppService：Electron API 的抽象层（端口-适配器中的端口）。
 * 本模块不 import electron——main.ts 注入环境值与能力实现（适配器），
 * 业务/基础设施模块面向本抽象编程，整条依赖链无头可测。
 * Spec: docs/superpowers/specs/2026-06-07-app-service-design.md
 */

/** main.ts 注入的运行环境实现。字段平台无关——不绑 Electron 术语 */
export interface AppServiceEnv {
  /** 应用数据根目录（Electron 适配 = app.getPath("userData")） */
  dataDir: string;
  /** 是否开发模式（Electron 适配 = !app.isPackaged） */
  isDev: boolean;
  /** 在系统文件管理器中打开目录（Electron 适配 = shell.openPath，吞掉其 string 返回值） */
  openFolder: (dir: string) => Promise<void>;
}

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
  get env(): AppServiceEnv {
    if (!this.#env) {
      throw new Error("AppService not initialized — initAppService must run before any consumer");
    }
    return this.#env;
  }
}

const service = new AppService();

/** 生命周期钩子：仅 main.ts 与测试（vitest setup / 单测重注入）深导入调用，不进 barrel */
export function initAppService(env: AppServiceEnv): void {
  service.init(env);
}

/** 只读单例——barrel 唯一导出。env 类型无 null：一次拿到完整环境，全字段 required */
export const appService: { readonly env: AppServiceEnv } = service;
