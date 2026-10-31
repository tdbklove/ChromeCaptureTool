// 輸出：裁切、預覽縮圖與下載。

import { buildFilename, prepareDownloadTarget, saveBlob } from "../lib/downloads.js";
import { state } from "./state.js";

// 預覽縮圖的最大寬度（像素）。只用於顯示，不影響下載的原圖品質。
const THUMBNAIL_WIDTH = 480;

export function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("無法產生圖片。"));
      }
    }, type, quality);
  });
}

// 從截圖中裁出一個或多個範圍，依序由上往下接成一張圖。
// rects：[{ x, y, width, height }]，寬度需相同（長圖合併時使用）。
function composeCanvas(rects, scale = 1) {
  const width = Math.max(1, Math.round(rects[0].width * scale));
  const heights = rects.map((rect) => Math.max(1, Math.round(rect.height * scale)));
  const totalHeight = heights.reduce((sum, height) => sum + height, 0);

  const output = document.createElement("canvas");
  output.width = width;
  output.height = totalHeight;

  const ctx = output.getContext("2d");

  if (!ctx) {
    throw new Error("圖片尺寸過大，無法建立畫布。");
  }

  let destinationY = 0;

  rects.forEach((rect, index) => {
    ctx.drawImage(
      state.source,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      destinationY,
      width,
      heights[index]
    );

    destinationY += heights[index];
  });

  return output;
}

export function cropToBlob(rects) {
  return canvasToBlob(composeCanvas(Array.isArray(rects) ? rects : [rects]));
}

// 產生預覽縮圖（JPEG，比完整 PNG 快很多），回傳 Blob。
export function makeThumbnail(rect) {
  const scale = Math.min(1, THUMBNAIL_WIDTH / rect.width);
  return canvasToBlob(composeCanvas([rect], scale), "image/jpeg", 0.85);
}

export function filenameFor(label) {
  return buildFilename({ site: state.meta.site, time: state.meta.time, label });
}

// 依下載設定儲存多個檔案。items：[{ label, rects }]。
// 必須在按鈕的 click 事件中直接呼叫（要求資料夾權限需要使用者操作）。
// 回傳 { saved, failed, location, notice }。
export async function downloadItems(items, onProgress) {
  const target = await prepareDownloadTarget();

  let saved = 0;
  let failed = 0;
  let location = "";

  for (const [index, item] of items.entries()) {
    onProgress?.(index, items.length);

    try {
      const blob = await cropToBlob(item.rects);
      location = await saveBlob(target, blob, filenameFor(item.label), state.meta.site);
      saved++;
    } catch (error) {
      failed++;
      console.error(`${item.label} 下載失敗：`, error);
    }
  }

  return { saved, failed, location, notice: target.notice };
}

// 下載結果的狀態文字。
export function describeDownload(result, noun) {
  const parts = [];

  if (result.failed === 0) {
    parts.push(`已儲存 ${result.saved} ${noun}`);
  } else {
    parts.push(`已儲存 ${result.saved} ${noun}，${result.failed} ${noun}失敗，請重試`);
  }

  if (result.location) {
    // 只顯示資料夾，不顯示最後一個檔名。
    const folder = result.location.slice(0, result.location.lastIndexOf("/") + 1);
    parts.push(`位置：${folder || result.location}`);
  }

  let text = parts.join("。") + "。";

  if (result.notice) {
    text += result.notice;
  }

  return text;
}

export function revokePreviewUrls() {
  state.previewUrls.forEach((url) => URL.revokeObjectURL(url));
  state.previewUrls = [];
}
