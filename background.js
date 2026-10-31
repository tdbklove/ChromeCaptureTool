// 背景程式進入點：接收彈出視窗、編輯頁的訊息與快捷鍵，交給各截圖模式處理。
//
//   background/task.js     目前進行中的截圖工作與停止要求
//   background/common.js   共用工具（截圖、執行網頁腳本、進度與錯誤提示、開啟編輯頁）
//   background/single.js   單張截圖
//   background/stitch.js   長條截圖
//   background/pages.js    翻頁截圖
//   background/cleanup.js  暫存自動清除

import { MESSAGES } from "./lib/constants.js";
import { clearLeftovers, handleTabRemoved } from "./background/cleanup.js";
import { friendlyError, setProgress, showBadgeError } from "./background/common.js";
import { capturePages } from "./background/pages.js";
import { captureVisible } from "./background/single.js";
import { continueStitch, finishStitch, startStitch } from "./background/stitch.js";
import { getBusyTask, requestStop } from "./background/task.js";

// ---- 暫存自動清除 ----

chrome.tabs.onRemoved.addListener(handleTabRemoved);

chrome.runtime.onStartup.addListener(clearLeftovers);

chrome.runtime.onInstalled.addListener((details) => {
  // 更新後暫存格式可能不同，清除舊版本的暫存。
  if (details.reason === "install" || details.reason === "update") {
    clearLeftovers();
  }
});

// ---- 停止截圖 ----

async function stopCapture() {
  requestStop();
  await setProgress("正在停止，已擷取的部分會保留……", "■");
}

// ---- 快捷鍵 ----

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    if (!tab?.id || tab.windowId == null) {
      throw new Error("找不到目前的分頁。");
    }

    // 長截圖或翻頁截圖進行中，再按一次同一個快捷鍵：停止並保留已擷取的部分。
    const busyTask = getBusyTask();

    if (
      (command === "capture-full" && busyTask === "stitch") ||
      (command === "capture-pages" && busyTask === "pages")
    ) {
      await stopCapture();
      return;
    }

    if (command === "capture-visible") {
      await captureVisible(tab);
    } else if (command === "capture-full") {
      await startStitch(tab.id, tab.windowId);
    } else if (command === "capture-pages") {
      await capturePages(tab);
    }
  } catch (error) {
    console.error("快捷鍵截圖失敗：", error);
    await showBadgeError(friendlyError(error, "截圖失敗。"));
  }
});

// ---- 訊息 ----

function respond(promise, sendResponse, fallbackMessage) {
  promise
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((error) => {
      console.error(fallbackMessage, error);
      sendResponse({ ok: false, error: friendlyError(error, fallbackMessage) });
    });

  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case MESSAGES.captureVisible:
      return respond(
        chrome.tabs.get(message.tabId).then(captureVisible),
        sendResponse,
        "截圖失敗。"
      );

    case MESSAGES.capturePages:
      return respond(
        chrome.tabs.get(message.tabId).then(capturePages),
        sendResponse,
        "翻頁截圖失敗。"
      );

    case MESSAGES.startStitch:
      return respond(
        startStitch(message.tabId, message.windowId),
        sendResponse,
        "長圖擷取失敗。"
      );

    case MESSAGES.continueStitch:
      return respond(
        continueStitch(message.jobId, message.nextStartY),
        sendResponse,
        "繼續截圖失敗。"
      );

    case MESSAGES.stopCapture:
      return respond(Promise.resolve().then(stopCapture), sendResponse, "無法停止截圖。");

    case MESSAGES.getStatus:
      sendResponse({ ok: true, busyTask: getBusyTask() });
      return false;

    case MESSAGES.finishStitch:
      return respond(finishStitch(message.jobId), sendResponse, "清除暫存失敗。");

    default:
      return false;
  }
});
