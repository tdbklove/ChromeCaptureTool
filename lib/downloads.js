// 依下載設定儲存圖片，並產生不會互相覆蓋的檔名。
//
// 使用方式：在按鈕的 click 事件中「第一個 await 之前」呼叫 prepareDownloadTarget()，
// 因為向使用者要求資料夾權限必須在使用者操作的當下進行。之後再對每個檔案呼叫 saveBlob()。

import { getHandle } from "./db.js";
import { getDownloadSettings } from "./settings.js";

export const FOLDER_HANDLE_KEY = "downloadDir";

// 移除 Windows／macOS 檔名不允許的字元，並避免「..」等特殊名稱。
export function sanitizeSegment(name) {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "";
  }

  return cleaned.slice(0, 80);
}

// 將「a/b/c」形式的子資料夾設定拆成安全的資料夾名稱陣列。
export function sanitizeFolderPath(path) {
  return String(path || "")
    .split(/[\\/]+/)
    .map(sanitizeSegment)
    .filter(Boolean);
}

// 由網址取得網站名稱（去掉 www.），例如 https://www.example.com/a → example.com。
export function siteNameFromUrl(url) {
  try {
    const { hostname } = new URL(url);
    return sanitizeSegment(hostname.replace(/^www\./, "")) || "page";
  } catch (error) {
    return "page";
  }
}

// 20261031-142530 形式的時間字串。
export function timestampText(time) {
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");

  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// 檔名：網站_截圖時間_標籤.png，例如 example.com_20261031-142530_img01.png。
export function buildFilename({ site, time, label }) {
  return `${sanitizeSegment(site) || "page"}_${timestampText(time)}_${sanitizeSegment(label)}.png`;
}

async function ensureFolderPermission(handle) {
  const options = { mode: "readwrite" };

  if ((await handle.queryPermission(options)) === "granted") {
    return true;
  }

  return (await handle.requestPermission(options)) === "granted";
}

// 依設定準備下載目標。回傳的物件交給 saveBlob() 使用。
// 選擇資料夾模式但尚未選擇資料夾、或使用者拒絕權限時，改用「下載」資料夾，並在 notice 說明原因。
export async function prepareDownloadTarget() {
  const settings = await getDownloadSettings();

  if (settings.mode === "folder") {
    const handle = await getHandle(FOLDER_HANDLE_KEY);

    if (!handle) {
      return {
        mode: "downloads",
        settings,
        notice: "尚未在設定中選擇資料夾，已改存到「下載」資料夾。"
      };
    }

    let granted = false;

    try {
      granted = await ensureFolderPermission(handle);
    } catch (error) {
      console.warn("無法取得資料夾權限：", error);
    }

    if (!granted) {
      return {
        mode: "downloads",
        settings,
        notice: `沒有取得「${handle.name}」資料夾的寫入權限，已改存到「下載」資料夾。`
      };
    }

    return { mode: "folder", settings, handle, notice: "" };
  }

  return { mode: "downloads", settings, notice: "" };
}

async function fileExists(directory, name) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    return false;
  }
}

// 資料夾中已有同名檔案時，改為「名稱 (2).png」、「名稱 (3).png」……
async function uniqueName(directory, filename) {
  if (!(await fileExists(directory, filename))) {
    return filename;
  }

  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";

  for (let index = 2; index < 1000; index++) {
    const candidate = `${base} (${index})${extension}`;

    if (!(await fileExists(directory, candidate))) {
      return candidate;
    }
  }

  return `${base}_${Date.now()}${extension}`;
}

async function saveToFolder(target, blob, filename, site) {
  let directory = target.handle;

  if (target.settings.perSite && site) {
    directory = await directory.getDirectoryHandle(sanitizeSegment(site) || "page", { create: true });
  }

  const name = await uniqueName(directory, filename);
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();

  await writable.write(blob);
  await writable.close();

  return `${target.handle.name}/${target.settings.perSite && site ? `${site}/` : ""}${name}`;
}

async function saveToDownloads(target, blob, filename, site) {
  const folders = sanitizeFolderPath(target.settings.subfolder);

  if (target.settings.perSite && site) {
    folders.push(sanitizeSegment(site) || "page");
  }

  const path = [...folders, filename].join("/");
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename: path,
      conflictAction: "uniquify",
      saveAs: target.settings.saveAs === true
    });
  } finally {
    // 下載開始後瀏覽器已取得資料；保留一段時間再釋放，避免大型檔案尚未讀取完畢。
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  return `下載/${path}`;
}

// 儲存一個檔案，回傳顯示用的儲存位置。
export function saveBlob(target, blob, filename, site) {
  if (target.mode === "folder") {
    return saveToFolder(target, blob, filename, site);
  }

  return saveToDownloads(target, blob, filename, site);
}
