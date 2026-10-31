// 下載設定：儲存在 chrome.storage.local，關閉瀏覽器後仍會保留。

import { MIN_MEDIA_SIZE, STORAGE_KEYS } from "./constants.js";

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
  folderName: "",
  // 輸出格式（OUTPUT_FORMATS 的鍵值）與 JPEG／WebP 的品質（0.5～1）。
  format: "png",
  quality: 0.9,
  // 圖片偵測的最小尺寸（CSS 像素）：小於此尺寸的圖片（圖示、按鈕等）不列入偵測。
  minImageSize: MIN_MEDIA_SIZE
};

// 圖片偵測最小尺寸的可設定範圍。
export const MIN_IMAGE_SIZE_RANGE = { min: 16, max: 300 };

// 圖片總像素上限：超過時瀏覽器可能無法建立畫布或產生圖片。
export const MAX_OUTPUT_AREA = 120_000_000;

// 各輸出格式的設定。maxSide 為單邊的最大像素：
// Canvas 的單邊上限約 32767，保守使用 30000；WebP 格式本身的上限為 16383。
export const OUTPUT_FORMATS = {
  png: { label: "PNG", mime: "image/png", ext: "png", maxSide: 30000, lossy: false },
  jpeg: { label: "JPEG", mime: "image/jpeg", ext: "jpg", maxSide: 30000, lossy: true },
  webp: { label: "WebP", mime: "image/webp", ext: "webp", maxSide: 16383, lossy: true }
};

export function outputFormat(settings) {
  return OUTPUT_FORMATS[settings?.format] || OUTPUT_FORMATS.png;
}

// 指定寬度時，一張圖片最高可以有多少像素。
export function maxOutputHeight(settings, width) {
  return Math.min(
    outputFormat(settings).maxSide,
    Math.floor(MAX_OUTPUT_AREA / Math.max(1, width))
  );
}

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
