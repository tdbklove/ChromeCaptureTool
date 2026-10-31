// 暫存自動清除：編輯頁關閉時清除它使用的暫存；瀏覽器重新啟動或擴充功能更新時清除遺留的暫存。

import { STORAGE_KEYS } from "../lib/constants.js";
import { clearAllCaptures, deleteCapture } from "../lib/db.js";
import { discardStitchSession } from "./stitch.js";
import { getBusyTask } from "./task.js";

// 編輯頁被關閉時，清除它使用的暫存截圖。
export async function handleTabRemoved(tabId) {
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.session,
      STORAGE_KEYS.captureTabs
    ]);

    const session = stored[STORAGE_KEYS.session];

    // 長截圖進行中時，編輯頁會在完成後重新開啟，因此不清除。
    if (session && session.editorTabId === tabId && getBusyTask() !== "stitch") {
      await discardStitchSession();
    }

    const captureTabs = stored[STORAGE_KEYS.captureTabs] || {};
    const captureId = captureTabs[tabId];

    if (captureId) {
      await deleteCapture(captureId);
      delete captureTabs[tabId];
      await chrome.storage.local.set({ [STORAGE_KEYS.captureTabs]: captureTabs });
    }
  } catch (error) {
    console.error("清除暫存失敗：", error);
  }
}

// 瀏覽器重新啟動時，之前的編輯頁都已關閉，清除所有遺留的暫存。
export async function clearLeftovers() {
  try {
    await clearAllCaptures();
  } catch (error) {
    console.error("清除遺留暫存失敗：", error);
  }

  await chrome.storage.local.remove([
    STORAGE_KEYS.session,
    STORAGE_KEYS.progress,
    STORAGE_KEYS.captureTabs,
    // 舊版本使用的鍵值。
    "pendingCapture",
    "pendingStitchJob"
  ]);
}
