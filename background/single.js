// 單張截圖：擷取目前畫面，偵測其中的圖片，開啟編輯頁。

import { saveCapture } from "../lib/db.js";
import {
  readViewportStateInPage,
  releaseScrollTargetInPage,
  scanPageInPage
} from "../lib/page-scripts.js";
import {
  captureTab,
  detectionMinSize,
  newId,
  openCaptureEditor,
  runInPage,
  wait
} from "./common.js";
import { beginTask, endTask } from "./task.js";

// captureVisibleTab 每秒最多呼叫 2 次，重試前需要等待。
const CAPTURE_RETRY_WAIT_MS = 600;
const MAX_CAPTURE_ATTEMPTS = 3;

// 將截圖裁成網頁內容區域，去掉右側與底部的捲軸（Windows 常見）。
async function cropToContent(blob, pageInfo) {
  const bitmap = await createImageBitmap(blob);

  try {
    const scaleX = bitmap.width / pageInfo.innerWidth;
    const scaleY = bitmap.height / pageInfo.innerHeight;

    const width = Math.min(bitmap.width, Math.round(pageInfo.viewportWidth * scaleX));
    const height = Math.min(bitmap.height, Math.round(pageInfo.viewportHeight * scaleY));

    if (width === bitmap.width && height === bitmap.height) {
      return blob;
    }

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height, 0, 0, width, height);

    return canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

function sameViewportState(a, b) {
  return (
    a.scrollX === b.scrollX &&
    a.scrollY === b.scrollY &&
    a.innerWidth === b.innerWidth &&
    a.innerHeight === b.innerHeight
  );
}

async function scanVisible(tabId, minSize) {
  try {
    // 清除長截圖可能遺留的捲動區塊標記，單張截圖一律以整個視窗為範圍。
    await runInPage(tabId, releaseScrollTargetInPage);

    const pageInfo = await runInPage(tabId, scanPageInPage, [{
      minSize,
      includeExtras: true,
      visibleOnly: true,
      includeSeparators: false
    }]);

    if (!pageInfo) {
      throw new Error("無法取得網頁圖片資訊。");
    }

    return pageInfo;
  } catch (error) {
    console.error("無法在此頁面執行偵測：", error);
    throw new Error(
      "無法讀取此頁面，請確認目前分頁是允許擷取的網頁（瀏覽器內建頁面與擴充功能商店無法擷取）。"
    );
  }
}

// 偵測圖片位置後截圖，再確認截圖當下的捲動位置與偵測時相同。
// 若網頁在兩者之間捲動或改變大小（偵測框會對不準），就重新偵測與截圖。
export async function captureVisible(tab) {
  beginTask("single");

  try {
    const minSize = await detectionMinSize();

    let pageInfo = null;
    let rawBlob = null;
    let aligned = false;

    for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS && !aligned; attempt++) {
      if (attempt > 1) {
        await wait(CAPTURE_RETRY_WAIT_MS);
      }

      pageInfo = await scanVisible(tab.id, minSize);
      rawBlob = await captureTab(tab.windowId);

      const after = await runInPage(tab.id, readViewportStateInPage);
      aligned = Boolean(after) && sameViewportState(pageInfo, after);
    }

    const blob = await cropToContent(rawBlob, pageInfo);
    const id = newId("capture");

    await saveCapture({
      id,
      blob,
      viewportWidth: pageInfo.viewportWidth,
      viewportHeight: pageInfo.viewportHeight,
      images: pageInfo.images.map((item) => ({
        kind: item.kind,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        alt: item.alt,
        sourceWidth: item.sourceWidth,
        sourceHeight: item.sourceHeight
      })),
      aligned,
      pageUrl: tab.url || "",
      pageTitle: tab.title || "",
      createdAt: Date.now()
    });

    await openCaptureEditor(tab, id);

    return { aligned };
  } finally {
    endTask();
  }
}
