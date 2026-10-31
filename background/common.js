// 背景程式各截圖模式共用的工具：截圖、執行網頁腳本、進度與錯誤提示、開啟編輯頁。

import { EDITOR_PAGE, MIN_MEDIA_SIZE, STORAGE_KEYS } from "../lib/constants.js";
import { getDownloadSettings, MIN_IMAGE_SIZE_RANGE } from "../lib/settings.js";

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function editorUrl(params) {
  return chrome.runtime.getURL(`${EDITOR_PAGE}?${new URLSearchParams(params)}`);
}

// 在目標分頁中執行 lib/page-scripts.js 的函式，回傳其結果。
export async function runInPage(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });

  return results?.[0]?.result;
}

// Chrome 限制每秒最多截圖 2 次。超過時會回傳此錯誤，稍等後重試即可。
const CAPTURE_QUOTA_ERROR = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|exceeds|quota/i;
const CAPTURE_QUOTA_RETRIES = 4;
const CAPTURE_QUOTA_WAIT_MS = 700;

// 擷取目前分頁的可見畫面，回傳 PNG Blob。
// 電腦較忙時，兩次截圖的間隔可能比預期短而超過次數限制，這時會自動等待後重試。
export async function captureTab(windowId) {
  for (let attempt = 0; ; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      const response = await fetch(dataUrl);

      return await response.blob();
    } catch (error) {
      if (attempt >= CAPTURE_QUOTA_RETRIES || !CAPTURE_QUOTA_ERROR.test(error?.message || "")) {
        throw error;
      }

      await wait(CAPTURE_QUOTA_WAIT_MS * (attempt + 1));
    }
  }
}

// 確認目標分頁仍是該視窗的前景分頁。captureVisibleTab 只會拍攝前景分頁，
// 使用者若在截圖途中切換分頁，會拍到別的網頁並被拼進長圖，因此必須中止。
export async function ensureTargetTabActive(tabId, windowId) {
  let tab;

  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    throw new Error("目標分頁已關閉，已停止擷取。");
  }

  if (!tab.active || tab.windowId !== windowId) {
    throw new Error("目標分頁已不在前景（可能切換了分頁），已停止擷取。請切回原分頁後重新開始。");
  }
}

// 圖片偵測的最小尺寸（使用者可在設定頁調整）。
export async function detectionMinSize() {
  try {
    const settings = await getDownloadSettings();
    const value = Number(settings.minImageSize);

    return Number.isFinite(value)
      ? Math.min(MIN_IMAGE_SIZE_RANGE.max, Math.max(MIN_IMAGE_SIZE_RANGE.min, value))
      : MIN_MEDIA_SIZE;
  } catch (error) {
    return MIN_MEDIA_SIZE;
  }
}

// 開啟單張截圖或翻頁截圖的編輯頁，並記錄編輯頁與暫存的對應（編輯頁關閉時自動清除）。
export async function openCaptureEditor(tab, id) {
  const editorTab = await chrome.tabs.create({
    url: editorUrl({ capture: id }),
    index: tab.index + 1,
    openerTabId: tab.id
  });

  const stored = await chrome.storage.local.get(STORAGE_KEYS.captureTabs);
  const captureTabs = stored[STORAGE_KEYS.captureTabs] || {};
  captureTabs[editorTab.id] = id;
  await chrome.storage.local.set({ [STORAGE_KEYS.captureTabs]: captureTabs });
}

// ---- 進度與錯誤提示 ----

// 進度文字寫入 storage（彈出視窗與編輯頁會監聽並顯示），並同步顯示在工具列圖示上。
export async function setProgress(text, badge = "") {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.progress]: { text, at: Date.now() }
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
    await chrome.action.setBadgeText({ text: badge });
  } catch (error) {
    console.warn("無法更新進度：", error);
  }
}

// 用快捷鍵啟動時沒有彈出視窗可以顯示錯誤，改在工具列圖示上提示。
export async function showBadgeError(message) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: `截圖失敗：${message}` });

    setTimeout(async () => {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "截圖與裁切" });
    }, 8000);
  } catch (error) {
    console.warn("無法顯示錯誤提示：", error);
  }
}

// Chrome 回傳的英文錯誤改為使用者看得懂的說明（例如在 chrome:// 頁面上截圖）。
export function friendlyError(error, fallbackMessage) {
  const message = error?.message || "";

  if (/chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|extensions gallery|Chrome Web Store|cannot be scripted/i.test(message)) {
    return "這個頁面無法截圖：Chrome 不允許擴充功能擷取內建頁面（網址以 chrome:// 開頭）、" +
      "線上應用程式商店與其他擴充功能的頁面。請切換到一般網頁再試。";
  }

  if (/Cannot access contents|Missing host permission|activeTab/i.test(message)) {
    return "目前沒有存取這個頁面的權限（網頁可能已重新整理或換頁）。請在網頁上重新按一次工具列圖示或快捷鍵。";
  }

  if (/No tab with id|Tabs cannot be edited/i.test(message)) {
    return "找不到目標分頁，可能已經關閉。請重新開始截圖。";
  }

  return message || fallbackMessage;
}
