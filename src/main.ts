import { app, BrowserWindow, net } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";
import { initDb, getDb } from "@main/db/instance";
import { setModelFetch } from "@main/ai/model-factory";
import { getPreference } from "@main/preferences/repository";
import { initMainI18n } from "@main/i18n";
import { resolveInitialLanguage } from "@shared/i18n/language";
import { registerAppHandlers } from "@main/ipc/app-handlers";
import { registerLibraryHandlers } from "@main/ipc/library-handlers";
import { registerSettingsHandlers } from "@main/ipc/settings-handlers";
import { registerChatHandlers } from "@main/ipc/chat-handlers";
import { registerAiHandlers } from "@main/ipc/ai-handlers";
import { registerAnnotationHandlers } from "@main/ipc/annotations-handlers";
import { registerPreferenceHandlers } from "@main/ipc/preferences-handlers";
import { registerCoverProtocol, registerCoverProtocolScheme } from "@main/library/cover-protocol";

// dev 与 production 各用独立的 userData 目录 + 钥匙串命名空间，避免跨身份
// （dev 的 Electron 二进制 vs 打包产物）共用 safeStorage 密钥导致解密失败。
// 必须在任何 app.getPath("userData") 调用前生效（instance.ts 在 app.ready 才首次读取）；
// setName 同时决定 userData 路径与 macOS 钥匙串 service 名（"<name> Safe Storage"）。
if (!app.isPackaged) {
  app.setName(`${app.getName()}-dev`); // marginalia → marginalia-dev
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// cover:// 自定义协议：scheme 注册须在 app.ready 前。
registerCoverProtocolScheme();

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL).catch((err: unknown) => {
      console.error("[window] loadURL failed:", err);
    });
  } else {
    void mainWindow
      .loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`))
      .catch((err: unknown) => {
        console.error("[window] loadFile failed:", err);
      });
  }

  // Open the DevTools.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools();
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => {
  try {
    initDb();
  } catch (err) {
    console.error("[db] failed to initialize:", err);
    app.quit();
    return;
  }
  // 主进程 i18n：读已存语言偏好（null → undefined 退系统 locale 匹配）
  initMainI18n(
    resolveInitialLanguage(getPreference(getDb(), "language") ?? undefined, app.getLocale()),
  );
  // AI 出站请求默认走系统代理：Electron net.fetch 经 Chromium 网络栈，默认采用系统代理设置。
  // （部分地区直连 api.anthropic.com 会被 403「Request not allowed」按区域拦截，须经系统代理出网。）
  setModelFetch((input, init) => net.fetch(input instanceof URL ? input.toString() : input, init));
  registerCoverProtocol(); // cover:// handler 需 getDb()，故在 initDb 后
  registerAppHandlers();
  registerLibraryHandlers();
  registerSettingsHandlers();
  registerChatHandlers();
  registerAnnotationHandlers();
  registerPreferenceHandlers();
  registerAiHandlers();
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
