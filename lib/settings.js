// 下載設定：儲存在 chrome.storage.local，關閉瀏覽器後仍會保留。

import { STORAGE_KEYS } from "./constants.js";

// mode：
//   "downloads"  存到 Chrome 預設「下載」資料夾底下的子資料夾（chrome.downloads API）
//   "folder"     存到使用者在設定頁選擇的任意資料夾（File System Access API）
export const DEFAULT_DOWNLOAD_SETTINGS = {
  mode: "downloads",
  // 「下載」資料夾底下的子資料夾，可用「/」建立多層；空白表示直接存在「下載」資料夾。
  subfolder: "ChromeCaptureTool",
  // 是否依網站名稱再分一層資料夾。
  perSite: true,
  // 是否每次都跳出「另存新檔」視窗（只適用於 downloads 模式）。
  saveAs: false,
  // 選擇的資料夾名稱（只用於顯示；實際的資料夾代號存在 IndexedDB）。
  folderName: ""
};

export async function getDownloadSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.downloadSettings);

  return {
    ...DEFAULT_DOWNLOAD_SETTINGS,
    ...(result[STORAGE_KEYS.downloadSettings] || {})
  };
}

// 依序執行更新：連續修改多個設定時，後一次更新不會蓋掉前一次的結果。
let pendingUpdate = Promise.resolve();

export function updateDownloadSettings(patch) {
  const run = async () => {
    const current = await getDownloadSettings();
    const next = { ...current, ...patch };

    await chrome.storage.local.set({ [STORAGE_KEYS.downloadSettings]: next });

    return next;
  };

  const result = pendingUpdate.then(run, run);
  pendingUpdate = result.catch(() => {});

  return result;
}
