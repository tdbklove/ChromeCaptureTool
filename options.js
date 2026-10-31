import { deleteHandle, getHandle, saveHandle } from "./lib/db.js";
import { FOLDER_HANDLE_KEY, sanitizeFolderPath } from "./lib/downloads.js";
import { getDownloadSettings, updateDownloadSettings } from "./lib/settings.js";

const modeInputs = document.querySelectorAll("input[name='mode']");
const subfolderInput = document.querySelector("#subfolderInput");
const saveAsInput = document.querySelector("#saveAsInput");
const perSiteInput = document.querySelector("#perSiteInput");
const folderName = document.querySelector("#folderName");
const pickFolderButton = document.querySelector("#pickFolderButton");
const clearFolderButton = document.querySelector("#clearFolderButton");
const shortcutList = document.querySelector("#shortcutList");
const shortcutsButton = document.querySelector("#shortcutsButton");
const status = document.querySelector("#status");
const formatInputs = document.querySelectorAll("input[name='format']");
const qualityRow = document.querySelector("#qualityRow");
const qualityInput = document.querySelector("#qualityInput");
const qualityValue = document.querySelector("#qualityValue");

const COMMAND_LABELS = {
  _execute_action: "開啟截圖選單",
  "capture-visible": "擷取目前畫面",
  "capture-full": "自動捲動並拼接長圖"
};

let statusTimer = null;

function showStatus(text) {
  status.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = "";
  }, 3000);
}

function applyModeUi(mode) {
  for (const sub of document.querySelectorAll(".sub[data-for]")) {
    sub.classList.toggle("disabled", sub.dataset.for !== mode);
  }
}

function showFolder(name) {
  folderName.textContent = name || "尚未選擇資料夾";
  folderName.classList.toggle("empty", !name);
  clearFolderButton.hidden = !name;
}

async function save(patch, message = "已儲存設定。") {
  await updateDownloadSettings(patch);
  showStatus(message);
}

async function load() {
  const settings = await getDownloadSettings();

  for (const input of modeInputs) {
    input.checked = input.value === settings.mode;
  }

  subfolderInput.value = settings.subfolder;
  saveAsInput.checked = settings.saveAs;
  perSiteInput.checked = settings.perSite;

  for (const input of formatInputs) {
    input.checked = input.value === settings.format;
  }

  qualityInput.value = String(Math.round(settings.quality * 100));
  qualityValue.textContent = qualityInput.value;
  applyFormatUi(settings.format);
  applyModeUi(settings.mode);

  const handle = await getHandle(FOLDER_HANDLE_KEY);
  showFolder(handle ? handle.name : "");
}

for (const input of modeInputs) {
  input.addEventListener("change", async () => {
    applyModeUi(input.value);
    await save({ mode: input.value });

    if (input.value === "folder" && !(await getHandle(FOLDER_HANDLE_KEY))) {
      showStatus("請按「選擇資料夾」指定要存放截圖的位置。");
    }
  });
}

subfolderInput.addEventListener("change", async () => {
  // 顯示整理過的路徑，讓使用者知道實際會使用的資料夾名稱。
  const cleaned = sanitizeFolderPath(subfolderInput.value).join("/");
  subfolderInput.value = cleaned;
  await save({ subfolder: cleaned });
});

saveAsInput.addEventListener("change", () => save({ saveAs: saveAsInput.checked }));
perSiteInput.addEventListener("change", () => save({ perSite: perSiteInput.checked }));

// PNG 是無損格式，沒有品質可以調整。
function applyFormatUi(format) {
  qualityRow.classList.toggle("disabled", format === "png");
}

for (const input of formatInputs) {
  input.addEventListener("change", async () => {
    applyFormatUi(input.value);
    await save({ format: input.value });
  });
}

qualityInput.addEventListener("input", () => {
  qualityValue.textContent = qualityInput.value;
});

qualityInput.addEventListener("change", () => save({ quality: Number(qualityInput.value) / 100 }));

pickFolderButton.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({
      id: "screenshot-cropper",
      mode: "readwrite"
    });

    await saveHandle(FOLDER_HANDLE_KEY, handle);
    await updateDownloadSettings({ mode: "folder", folderName: handle.name });

    for (const input of modeInputs) {
      input.checked = input.value === "folder";
    }

    applyModeUi("folder");
    showFolder(handle.name);
    showStatus(`已選擇資料夾「${handle.name}」。`);
  } catch (error) {
    // 使用者按「取消」時不需要提示。
    if (error.name !== "AbortError") {
      console.error(error);
      showStatus(`無法使用這個資料夾：${error.message}`);
    }
  }
});

clearFolderButton.addEventListener("click", async () => {
  await deleteHandle(FOLDER_HANDLE_KEY);
  await updateDownloadSettings({ folderName: "" });
  showFolder("");
  showStatus("已清除資料夾。下載時會改存到「下載」資料夾。");
});

shortcutsButton.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

async function loadShortcuts() {
  const commands = await chrome.commands.getAll();
  shortcutList.replaceChildren();

  for (const command of commands) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = COMMAND_LABELS[command.name] || command.description || command.name;

    const key = document.createElement("kbd");
    key.textContent = command.shortcut || "未設定";

    item.append(label, key);
    shortcutList.appendChild(item);
  }
}

load();
loadShortcuts();
