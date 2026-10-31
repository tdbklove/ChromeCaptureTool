// 輸出：裁切、預覽縮圖與下載。

import { buildFilename, prepareDownloadTarget, saveBlob } from "../lib/downloads.js";
import { maxOutputHeight, outputFormat } from "../lib/settings.js";
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

// 依下載設定的格式與品質產生圖片。
export function cropToBlob(rects, settings) {
  const format = outputFormat(settings);
  const canvas = composeCanvas(Array.isArray(rects) ? rects : [rects]);

  return canvasToBlob(canvas, format.mime, format.lossy ? settings.quality : undefined);
}

// 產生預覽縮圖（JPEG，比完整 PNG 快很多），回傳 Blob。
export function makeThumbnail(rect) {
  const scale = Math.min(1, THUMBNAIL_WIDTH / rect.width);
  return canvasToBlob(composeCanvas([rect], scale), "image/jpeg", 0.85);
}

export function filenameFor(label, settings) {
  return buildFilename({
    site: state.meta.site,
    time: state.meta.time,
    label,
    ext: outputFormat(settings).ext
  });
}

// 依目前的輸出格式，計算合併時一張圖最多能有多高（像素）。
export function mergeHeightLimit(width) {
  return maxOutputHeight(state.settings, width);
}

// 依序把範圍分組，每組的總高度不超過 limit（單一範圍本身超過時自成一組）。
export function splitByHeight(rects, limit) {
  const chunks = [];
  let current = [];
  let height = 0;

  for (const rect of rects) {
    if (current.length > 0 && height + rect.height > limit) {
      chunks.push(current);
      current = [];
      height = 0;
    }

    current.push(rect);
    height += rect.height;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
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
      const blob = await cropToBlob(item.rects, target.settings);
      location = await saveBlob(
        target,
        blob,
        filenameFor(item.label, target.settings),
        state.meta.site
      );
      saved++;
    } catch (error) {
      failed++;
      console.error(`${item.label} 下載失敗：`, error);
    }
  }

  return { saved, failed, location, notice: target.notice };
}

// 複製到剪貼簿（一律使用 PNG：瀏覽器的剪貼簿只支援 PNG 圖片）。
export async function copyRects(rects) {
  const list = Array.isArray(rects) ? rects : [rects];
  const blob = await canvasToBlob(composeCanvas(list), "image/png");

  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

// 結果卡片上的「複製」按鈕。getRects 在點擊時才取得範圍（範圍可能已被調整）。
export function createCopyButton(getRects, setStatus) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = "複製";
  button.title = "複製到剪貼簿，可直接貼到聊天軟體或文件中";

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "複製中……";

    try {
      await copyRects(getRects());
      setStatus("已複製到剪貼簿，可以直接貼上（Ctrl＋V）。");
    } catch (error) {
      console.error("複製失敗：", error);
      setStatus("複製失敗：圖片可能過大，或瀏覽器不允許存取剪貼簿。請改用下載。");
    } finally {
      button.disabled = false;
      button.textContent = "複製";
    }
  });

  return button;
}

// 卡片底部的按鈕列（下載與複製並排）。
export function buttonRow(...buttons) {
  const row = document.createElement("div");
  row.className = "cardButtons";
  row.append(...buttons);
  return row;
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
