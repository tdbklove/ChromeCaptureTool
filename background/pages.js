// 翻頁截圖
//
// 適用於按「→」鍵可以切換下一張圖片的網頁（看圖彈窗、相簿、漫畫閱讀器等）：
// 擷取畫面中的主圖 → 模擬按下「→」鍵 → 等待換成下一張 → 重複，每頁輸出一張圖片。

import { saveCapture } from "../lib/db.js";
import { findMainImageInPage, pressArrowRightInPage } from "../lib/page-scripts.js";
import {
  captureTab,
  detectionMinSize,
  ensureTargetTabActive,
  newId,
  openCaptureEditor,
  runInPage,
  setProgress,
  wait
} from "./common.js";
import { beginTask, endTask, isStopRequested } from "./task.js";

// 單次最多擷取的頁數，以及所有頁面合計的最大高度（裝置像素，編輯頁的畫布上限）。
const MAX_PAGES = 60;
const MAX_PAGES_TOTAL_HEIGHT = 28000;

// 等待翻頁：輪詢間隔，以及兩次截圖之間的最短間隔（captureVisibleTab 每秒最多 2 次）。
const PAGE_POLL_MS = 200;
const MIN_CAPTURE_INTERVAL_MS = 600;

// 按下「→」鍵後，等待畫面開始換圖的時間；超過就重按一次，仍沒有變化才視為最後一頁。
const PAGE_CHANGE_TIMEOUT_MS = 6000;
const PAGE_RETRY_TIMEOUT_MS = 4000;

// 換圖後等待新圖片「準備好」的最長時間（大型圖片可能要載入較久），逾時就直接擷取目前的畫面。
const PAGE_READY_TIMEOUT_MS = 20000;

// 先顯示模糊預覽圖、再換成高解析度圖片的網站：最多再等這麼久讓高解析度圖片載入。
const LOW_RES_GRACE_MS = 4000;

// 主圖位置連續相同的次數（約 0.6 秒），用來確認換頁動畫已經結束。
const STABLE_POLLS = 3;

function sameRect(a, b) {
  return (
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
}

// 等待畫面中的主圖換成新的一張並「準備好」：
//   - 與 previousSignature 不同（第一頁時不需要）
//   - 已載入完成、完全不透明（淡入動畫結束）、位置連續數次相同（換頁動畫結束）
//   - 不是放大顯示的模糊預覽圖（最多再等 LOW_RES_GRACE_MS）
// 回傳 { status: "ready", main }、{ status: "no-change" }（在 changeTimeoutMs 內完全沒有換圖）
// 或 { status: "stopped" }（使用者要求停止）。
async function waitForMainImage(tabId, minSize, previousSignature, changeTimeoutMs) {
  const startedAt = Date.now();
  let changedAt = null;
  let last = null;
  let stableCount = 0;
  let latest = null;

  while (true) {
    if (isStopRequested()) {
      return { status: "stopped" };
    }

    const now = Date.now();
    const main = await runInPage(tabId, findMainImageInPage, [minSize]);
    const changed = Boolean(main) && main.signature !== previousSignature;

    if (!changed) {
      last = null;
      stableCount = 0;

      if (changedAt === null && now - startedAt > changeTimeoutMs) {
        return { status: "no-change" };
      }
    } else {
      changedAt ??= now;

      const same = last && last.signature === main.signature && sameRect(last.rect, main.rect);
      stableCount = same ? stableCount + 1 : 0;
      last = main;
      latest = main;

      const settled = stableCount >= STABLE_POLLS - 1;
      const opaque = main.opacity >= 0.99;
      const fullRes = !main.lowRes || now - changedAt > LOW_RES_GRACE_MS;

      if (settled && opaque && main.complete && fullRes) {
        return { status: "ready", main };
      }
    }

    // 已經換圖但一直沒有準備好（例如圖片很大、載入很慢）：逾時就用最後看到的狀態。
    if (changedAt !== null && now - changedAt > PAGE_READY_TIMEOUT_MS && latest) {
      return { status: "ready", main: latest };
    }

    await wait(PAGE_POLL_MS);
  }
}

// 從截圖中裁出主圖的範圍（CSS 像素換算為截圖像素）。
async function cropToRect(blob, rect, innerWidth, innerHeight) {
  const bitmap = await createImageBitmap(blob);

  try {
    const scaleX = bitmap.width / innerWidth;
    const scaleY = bitmap.height / innerHeight;

    const x = Math.max(0, Math.round(rect.x * scaleX));
    const y = Math.max(0, Math.round(rect.y * scaleY));
    const width = Math.max(1, Math.min(bitmap.width - x, Math.round(rect.width * scaleX)));
    const height = Math.max(1, Math.min(bitmap.height - y, Math.round(rect.height * scaleY)));

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(bitmap, x, y, width, height, 0, 0, width, height);

    return { blob: await canvas.convertToBlob({ type: "image/png" }), width, height };
  } finally {
    bitmap.close();
  }
}

export async function capturePages(tab) {
  beginTask("pages");

  try {
    const minSize = await detectionMinSize();

    const first = await waitForMainImage(tab.id, minSize, null, 3000);

    if (first.status === "stopped") {
      throw new Error("已停止翻頁截圖，尚未擷取任何頁面。");
    }

    let main = first.main;

    if (!main) {
      throw new Error("畫面中找不到圖片。如果圖片要點開彈窗才會顯示，請先點開彈窗再開始翻頁截圖。");
    }

    const pages = [];
    const seen = new Set();
    let totalHeight = 0;
    let endReason = "max";
    let lastCaptureAt = 0;

    for (let index = 0; index < MAX_PAGES; index++) {
      if (isStopRequested()) {
        endReason = "stopped";
        break;
      }

      await setProgress(
        `正在擷取第 ${index + 1} 頁，請勿切換分頁或操作網頁。可按「停止截圖」結束，已擷取的頁面會保留……`,
        String(index + 1)
      );

      await wait(Math.max(0, lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now()));

      await ensureTargetTabActive(tab.id, tab.windowId);
      const screenshot = await captureTab(tab.windowId);
      await ensureTargetTabActive(tab.id, tab.windowId);
      lastCaptureAt = Date.now();

      const page = await cropToRect(screenshot, main.rect, main.innerWidth, main.innerHeight);

      if (pages.length > 0 && totalHeight + page.height > MAX_PAGES_TOTAL_HEIGHT) {
        endReason = "limit";
        break;
      }

      pages.push({ ...page, alt: main.alt });
      seen.add(main.signature);
      totalHeight += page.height;

      await runInPage(tab.id, pressArrowRightInPage, [0]);

      let result = await waitForMainImage(tab.id, minSize, main.signature, PAGE_CHANGE_TIMEOUT_MS);

      // 完全沒有換圖：可能是按鍵時看圖程式還在播放動畫而忽略了按鍵，再按一次確認。
      if (result.status === "no-change" && !isStopRequested()) {
        await runInPage(tab.id, pressArrowRightInPage, [1]);
        result = await waitForMainImage(tab.id, minSize, main.signature, PAGE_RETRY_TIMEOUT_MS);
      }

      if (result.status === "stopped") {
        endReason = "stopped";
        break;
      }

      if (result.status === "no-change") {
        endReason = "no-change";
        break;
      }

      if (seen.has(result.main.signature)) {
        endReason = "loop";
        break;
      }

      main = result.main;
    }

    if (pages.length === 0) {
      throw new Error("已停止翻頁截圖，尚未擷取任何頁面。");
    }

    const id = newId("pages");

    await saveCapture({
      id,
      mode: "pages",
      pages,
      endReason,
      pageUrl: tab.url || "",
      pageTitle: tab.title || "",
      createdAt: Date.now()
    });

    await openCaptureEditor(tab, id);

    return { pageCount: pages.length, endReason };
  } finally {
    await setProgress("", "");
    endTask();
  }
}
