import { MESSAGES, STORAGE_KEYS } from "./lib/constants.js";

const captureButton = document.querySelector("#captureButton");
const stitchButton = document.querySelector("#stitchButton");
const settingsButton = document.querySelector("#settingsButton");
const status = document.querySelector("#status");

// 背景工作進行中時，進度文字即時顯示在彈出視窗中。
let isStitchRunning = false;

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
  status.textContent = "正在偵測圖片並擷取畫面……";

  try {
    const tab = await getActiveTab();

    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.captureVisible,
      tabId: tab.id
    });

    if (!response?.ok) {
      throw new Error(response?.error || "截圖失敗，請確認目前分頁是否允許截圖。");
    }

    status.textContent = "截圖完成。";
  } catch (error) {
    console.error("截圖或偵測失敗：", error);
    status.textContent = error.message || "操作失敗，請確認目前分頁是否允許截圖。";
  } finally {
    captureButton.disabled = false;
  }
});

stitchButton.addEventListener("click", async () => {
  stitchButton.disabled = true;
  isStitchRunning = true;
  status.textContent = "等待頁面載入完成後自動截圖，請保持目標分頁開啟，勿切換分頁。";

  try {
    const tab = await getActiveTab();

    // 背景程式會在整個工作結束後才回覆。
    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.startStitch,
      tabId: tab.id,
      windowId: tab.windowId
    });

    status.textContent = response?.ok
      ? "長圖擷取完成，已開啟預覽頁。"
      : response?.error || "長圖擷取失敗，請重新嘗試。";
  } catch (error) {
    console.error(error);
    status.textContent = error.message || "無法啟動長圖擷取。";
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
    status.textContent = text;
  }
});

// 在按鈕上顯示目前設定的快捷鍵，方便使用者記住。
// 快捷鍵與其他擴充功能衝突時，Chrome 不會指派，此時顯示「未設定」並提示到設定頁設定。
chrome.commands.getAll().then((commands) => {
  const labels = {
    "capture-visible": captureButton,
    "capture-full": stitchButton
  };

  let missing = false;

  for (const command of commands) {
    const button = labels[command.name];

    if (!button) continue;

    const hint = document.createElement("kbd");

    if (command.shortcut) {
      hint.textContent = command.shortcut;
    } else {
      hint.textContent = "未設定";
      hint.classList.add("unset");
      missing = true;
    }

    button.appendChild(hint);
  }

  if (missing) {
    status.textContent = "有快捷鍵尚未設定（可能與其他擴充功能衝突），可按下方「下載位置與快捷鍵設定」設定。";
  }
});
