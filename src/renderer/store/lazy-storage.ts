import { createJSONStorage, type StateStorage } from "zustand/middleware";

// headless 测试（vitest 跑 Electron node 运行时）无 DOM，localStorage 未定义 → noop 降级，
// persist 仅内存、不抛错；renderer 真实环境用 window.localStorage。
// 每次操作惰性解析 localStorage（而非捕获一次）：createJSONStorage 仅在创建时调一次 getStorage，
// 若此刻 localStorage 未定义会永久绑死 noop；包一层每次读现值，使 DOM 后置就绪 / 测试 stub 仍生效。
const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
const lazyStorage: StateStorage = {
  getItem: (name) =>
    typeof localStorage !== "undefined" ? localStorage.getItem(name) : noopStorage.getItem(name),
  setItem: (name, value) =>
    typeof localStorage !== "undefined"
      ? localStorage.setItem(name, value)
      : noopStorage.setItem(name, value),
  removeItem: (name) =>
    typeof localStorage !== "undefined"
      ? localStorage.removeItem(name)
      : noopStorage.removeItem(name),
};

/** zustand persist 用的 localStorage 包装（惰性 + headless 安全）。 */
export const safeStorage = createJSONStorage(() => lazyStorage);
