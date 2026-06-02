import { app, BrowserWindow, net } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";
import { initDb } from "@main/db/instance";
import { setModelFetch } from "@main/ai/model-factory";
import { registerAppHandlers } from "@main/ipc/app-handlers";
import { registerLibraryHandlers } from "@main/ipc/library-handlers";
import { registerSettingsHandlers } from "@main/ipc/settings-handlers";
import { registerChatHandlers } from "@main/ipc/chat-handlers";
import { registerAiHandlers } from "@main/ipc/ai-handlers";
import { registerAnnotationHandlers } from "@main/ipc/annotations-handlers";
import { registerPreferenceHandlers } from "@main/ipc/preferences-handlers";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

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
  // AI 出站请求默认走系统代理：Electron net.fetch 经 Chromium 网络栈，默认采用系统代理设置。
  // （部分地区直连 api.anthropic.com 会被 403「Request not allowed」按区域拦截，须经系统代理出网。）
  setModelFetch((input, init) => net.fetch(input instanceof URL ? input.toString() : input, init));
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
