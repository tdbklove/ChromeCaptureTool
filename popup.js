import { MESSAGES, STORAGE_KEYS } from "./lib/constants.js";

const captureButton = document.querySelector("#captureButton");
const stitchButton = document.querySelector("#stitchButton");
const settingsButton = document.querySelector("#settingsButton");
const status = document.querySelector("#status");
const shortcutTip = document.querySelector("#shortcutTip");

// 背景工作進行中時，進度文字即時顯示在彈出視窗中。
let isStitchRunning = false;

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
  stitchButton.disabled = true;
  isStitchRunning = true;
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
      setStatus("長圖擷取完成，已開啟編輯頁。");
    } else {
      setStatus(response?.error || "長圖擷取失敗，請重新嘗試。", true);
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || "無法啟動長圖擷取。", true);
  } finally {
    stitchButton.disabled = false;
    isStitchRunning = false;
  }
});

settingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEYS.progress]) return;

  const text = changes[STORAGE_KEYS.progress].newValue?.text;

  if (isStitchRunning && text) {
    setStatus(text);
  }
});

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
    "capture-full": stitchButton
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
