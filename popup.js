import { MESSAGES, STORAGE_KEYS } from "./lib/constants.js";

const captureButton = document.querySelector("#captureButton");
const stitchButton = document.querySelector("#stitchButton");
const pagesButton = document.querySelector("#pagesButton");
const stopButton = document.querySelector("#stopButton");
const settingsButton = document.querySelector("#settingsButton");
const status = document.querySelector("#status");
const shortcutTip = document.querySelector("#shortcutTip");

// 長截圖或翻頁截圖進行中時，進度文字即時顯示在彈出視窗中，並顯示「停止截圖」按鈕。
let isStitchRunning = false;

function setRunning(running) {
  isStitchRunning = running;
  stopButton.hidden = !running;
  stopButton.disabled = false;
  captureButton.disabled = running;
  stitchButton.disabled = running;
  pagesButton.disabled = running;
}

// 顯示截圖進度或結果；error 為 true 時以紅色顯示。沒有訊息時隱藏整個區塊。
function setStatus(text, error = false) {
  status.textContent = text || "";
  status.hidden = !text;
  status.classList.toggle("error", error);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || tab.windowId == null) {
    throw new Error("找不到目前的分頁。");
  }

  return tab;
}

// 截圖與偵測都在背景程式中進行，完成後會開啟編輯頁（彈出視窗隨之關閉）。
// 單張截圖不會影響進行中的長截圖，兩者各自使用獨立的編輯頁。
captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  setStatus("正在偵測圖片並擷取畫面……");

  try {
    const tab = await getActiveTab();

    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.captureVisible,
      tabId: tab.id
    });

    if (!response?.ok) {
      throw new Error(response?.error || "截圖失敗，請確認目前分頁是否允許截圖。");
    }

    setStatus("截圖完成，已開啟編輯頁。");
  } catch (error) {
    console.error("截圖或偵測失敗：", error);
    setStatus(error.message || "操作失敗，請確認目前分頁是否允許截圖。", true);
  } finally {
    captureButton.disabled = false;
  }
});

stitchButton.addEventListener("click", async () => {
  setRunning(true);
  setStatus("等待頁面載入完成後自動開始截圖……");

  try {
    const tab = await getActiveTab();

    // 背景程式會在整個工作結束後才回覆。
    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.startStitch,
      tabId: tab.id,
      windowId: tab.windowId
    });

    if (response?.ok) {
      setStatus(response.stopped
        ? "已停止長截圖，已擷取的部分已在編輯頁開啟。"
        : "長圖擷取完成，已開啟編輯頁。");
    } else {
      setStatus(response?.error || "長圖擷取失敗，請重新嘗試。", true);
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || "無法啟動長圖擷取。", true);
  } finally {
    setRunning(false);
  }
});

// 翻頁截圖：在背景程式中逐頁擷取，完成後開啟編輯頁。
pagesButton.addEventListener("click", async () => {
  setRunning(true);
  setStatus("正在尋找彈窗中的圖片……");

  try {
    const tab = await getActiveTab();

    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.capturePages,
      tabId: tab.id
    });

    if (response?.ok) {
      setStatus(response.endReason === "stopped"
        ? `已停止翻頁截圖，已擷取的 ${response.pageCount} 頁已在編輯頁開啟。`
        : `已擷取 ${response.pageCount} 頁，已開啟編輯頁。`);
    } else {
      setStatus(response?.error || "翻頁截圖失敗，請重新嘗試。", true);
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || "無法啟動翻頁截圖。", true);
  } finally {
    setRunning(false);
  }
});

// 停止截圖：背景程式會在下一個檢查點結束，保留已擷取的部分並開啟編輯頁。
stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  setStatus("正在停止，已擷取的部分會保留……");

  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGES.stopCapture });

    if (!response?.ok) {
      throw new Error(response?.error || "無法停止截圖。");
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || "無法停止截圖。", true);
    stopButton.disabled = false;
  }
});

settingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEYS.progress]) return;

  const text = changes[STORAGE_KEYS.progress].newValue?.text;

  if (!isStitchRunning) return;

  if (text) {
    setStatus(text);
  } else if (startedElsewhere) {
    // 由快捷鍵或先前開啟的選單啟動的截圖已結束（進度文字被清除）。
    startedElsewhere = false;
    setRunning(false);
    setStatus("截圖已結束，已開啟編輯頁。");
  }
});

// 開啟選單時，若有進行中的長截圖或翻頁截圖（例如用快捷鍵啟動，或關閉選單後再打開），
// 也顯示進度與「停止截圖」按鈕。
let startedElsewhere = false;

chrome.runtime.sendMessage({ type: MESSAGES.getStatus }).then((response) => {
  if (response?.busyTask === "stitch" || response?.busyTask === "pages") {
    startedElsewhere = true;
    setRunning(true);
    setStatus(response.busyTask === "stitch" ? "長截圖進行中……" : "翻頁截圖進行中……");
  }
}).catch(() => {});

function kbd(text) {
  const element = document.createElement("kbd");
  element.textContent = text;
  return element;
}

// 在按鈕上顯示目前設定的快捷鍵，方便使用者記住；開啟本選單的快捷鍵顯示在使用說明中。
// 快捷鍵與其他擴充功能衝突、或擴充功能更新前就已安裝時，Chrome 可能不會指派，此時顯示「未設定」。
chrome.commands.getAll().then((commands) => {
  const buttons = {
    "capture-visible": captureButton,
    "capture-full": stitchButton,
    "capture-pages": pagesButton
  };

  let menuShortcut = "";
  let missing = false;

  for (const command of commands) {
    if (command.name === "_execute_action") {
      menuShortcut = command.shortcut;
      missing ||= !command.shortcut;
      continue;
    }

    const button = buttons[command.name];

    if (!button) continue;

    const hint = kbd(command.shortcut || "未設定");
    hint.classList.toggle("unset", !command.shortcut);
    button.appendChild(hint);

    missing ||= !command.shortcut;
  }

  shortcutTip.replaceChildren();

  if (menuShortcut) {
    shortcutTip.append("按 ", kbd(menuShortcut), " 可開啟此選單。");
  } else {
    shortcutTip.append("開啟此選單的快捷鍵尚未設定。");
  }

  shortcutTip.append(missing
    ? "未設定的快捷鍵可按下方「下載位置與快捷鍵設定」指定。"
    : "快捷鍵可在下方的設定中修改。");
});
