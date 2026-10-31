import {
  EDITOR_PAGE,
  MESSAGES,
  MIN_MEDIA_SIZE,
  STORAGE_KEYS
} from "./lib/constants.js";

import {
  clearAllCaptures,
  deleteCapture,
  deleteFrames,
  saveCapture,
  saveFrame
} from "./lib/db.js";

import {
  checkPageReadyInPage,
  findMainImageInPage,
  hideFixedElementsInPage,
  prepareScrollTargetInPage,
  pressArrowRightInPage,
  readViewportStateInPage,
  releaseScrollTargetInPage,
  restoreFixedElementsInPage,
  scanPageInPage,
  scrollByInPage,
  scrollToInPage
} from "./lib/page-scripts.js";

import { getDownloadSettings, MIN_IMAGE_SIZE_RANGE } from "./lib/settings.js";

const SCROLL_RATIO = 0.8;
const WAIT_AFTER_SCROLL_MS = 300;

// 等待頁面載入：輪詢間隔、初次與每段的最長等待時間。
const READY_POLL_MS = 400;
const INITIAL_READY_TIMEOUT_MS = 20000;
const FRAME_READY_TIMEOUT_MS = 8000;

// 單批的最大輸出高度（裝置像素）。超過此高度，編輯器的 Canvas 可能無法建立。
const MAX_DEVICE_HEIGHT = 24000;
const MIN_BATCH_FRAMES = 4;
const MAX_BATCH_FRAMES = 20;

// 單張截圖：captureVisibleTab 每秒最多呼叫 2 次，重試前需要等待。
const CAPTURE_RETRY_WAIT_MS = 600;
const MAX_CAPTURE_ATTEMPTS = 3;

// 同一時間只允許一項截圖工作，避免捲動與截圖互相干擾。
let busyTask = null;

// 使用者要求停止目前的長截圖或翻頁截圖：擷取迴圈會在下一個檢查點結束，保留已擷取的部分。
let stopRequested = false;

function requestStop() {
  if (busyTask !== "stitch" && busyTask !== "pages") {
    throw new Error("目前沒有進行中的長截圖或翻頁截圖。");
  }

  stopRequested = true;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function editorUrl(params) {
  return chrome.runtime.getURL(`${EDITOR_PAGE}?${new URLSearchParams(params)}`);
}

async function runInPage(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });

  return results?.[0]?.result;
}

async function beginTask(name) {
  if (busyTask) {
    throw new Error(
      busyTask === "stitch"
        ? "長截圖正在進行中，請等待完成後再試。"
        : busyTask === "pages"
        ? "翻頁截圖正在進行中，請等待完成後再試。"
        : "目前已有截圖工作正在執行。"
    );
  }

  busyTask = name;
  stopRequested = false;
}

function endTask() {
  busyTask = null;
  stopRequested = false;
}

// Chrome 限制每秒最多截圖 2 次。超過時會回傳此錯誤，稍等後重試即可。
const CAPTURE_QUOTA_ERROR = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|exceeds|quota/i;
const CAPTURE_QUOTA_RETRIES = 4;
const CAPTURE_QUOTA_WAIT_MS = 700;

// 擷取目前分頁的可見畫面，回傳 PNG Blob。
// 電腦較忙時，兩次截圖的間隔可能比預期短而超過次數限制，這時會自動等待後重試。
async function captureTab(windowId) {
  for (let attempt = 0; ; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      const response = await fetch(dataUrl);

      return await response.blob();
    } catch (error) {
      if (attempt >= CAPTURE_QUOTA_RETRIES || !CAPTURE_QUOTA_ERROR.test(error?.message || "")) {
        throw error;
      }

      await wait(CAPTURE_QUOTA_WAIT_MS * (attempt + 1));
    }
  }
}

// 確認目標分頁仍是該視窗的前景分頁。captureVisibleTab 只會拍攝前景分頁，
// 使用者若在截圖途中切換分頁，會拍到別的網頁並被拼進長圖，因此必須中止。
async function ensureTargetTabActive(tabId, windowId) {
  let tab;

  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    throw new Error("目標分頁已關閉，已停止擷取。");
  }

  if (!tab.active || tab.windowId !== windowId) {
    throw new Error("目標分頁已不在前景（可能切換了分頁），已停止擷取。請切回原分頁後重新開始。");
  }
}

// ---- 進度與錯誤提示 ----

// 進度文字寫入 storage（彈出視窗與編輯頁會監聽並顯示），並同步顯示在工具列圖示上。
async function setProgress(text, badge = "") {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.progress]: { text, at: Date.now() }
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
    await chrome.action.setBadgeText({ text: badge });
  } catch (error) {
    console.warn("無法更新進度：", error);
  }
}

// 用快捷鍵啟動時沒有彈出視窗可以顯示錯誤，改在工具列圖示上提示。
async function showBadgeError(message) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: `截圖失敗：${message}` });

    setTimeout(async () => {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "截圖與裁切" });
    }, 8000);
  } catch (error) {
    console.warn("無法顯示錯誤提示：", error);
  }
}

// ---- 單張截圖 ----

// 圖片偵測的最小尺寸（使用者可在設定頁調整）。
async function detectionMinSize() {
  try {
    const settings = await getDownloadSettings();
    const value = Number(settings.minImageSize);

    return Number.isFinite(value)
      ? Math.min(MIN_IMAGE_SIZE_RANGE.max, Math.max(MIN_IMAGE_SIZE_RANGE.min, value))
      : MIN_MEDIA_SIZE;
  } catch (error) {
    return MIN_MEDIA_SIZE;
  }
}

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
async function captureVisible(tab) {
  await beginTask("single");

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

// 開啟單張截圖或翻頁截圖的編輯頁，並記錄編輯頁與暫存的對應（編輯頁關閉時自動清除）。
async function openCaptureEditor(tab, id) {
  const editorTab = await chrome.tabs.create({
    url: editorUrl({ capture: id }),
    index: tab.index + 1,
    openerTabId: tab.id
  });

  const stored = await chrome.storage.local.get(STORAGE_KEYS.captureTabs);
  const captureTabs = stored[STORAGE_KEYS.captureTabs] || {};
  captureTabs[editorTab.id] = id;
  await chrome.storage.local.set({ [STORAGE_KEYS.captureTabs]: captureTabs });
}

// ---- 翻頁截圖 ----
//
// 適用於按「→」鍵可以切換下一張圖片的網頁（看圖彈窗、相簿、漫畫閱讀器等）：
// 擷取畫面中的主圖 → 模擬按下「→」鍵 → 等待換成下一張 → 重複，每頁輸出一張圖片。

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
// 回傳 { status: "ready", main } 或 { status: "no-change" }（在 changeTimeoutMs 內完全沒有換圖）。
async function waitForMainImage(tabId, minSize, previousSignature, changeTimeoutMs) {
  const startedAt = Date.now();
  let changedAt = null;
  let last = null;
  let stableCount = 0;
  let latest = null;

  while (true) {
    if (stopRequested) {
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

async function capturePages(tab) {
  await beginTask("pages");

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
      if (stopRequested) {
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
      if (result.status === "no-change" && !stopRequested) {
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

// ---- 長截圖 ----

async function checkPageReady(tabId, scope) {
  return (await runInPage(tabId, checkPageReadyInPage, [scope])) ??
    { complete: false, pending: 1, count: -1 };
}

// 等待頁面穩定：連續數次檢查都沒有待載入的圖片，且圖片數量不再變動。
// 回傳 true 表示已穩定；逾時回傳 false（仍會繼續截圖，但會記錄警告）。
async function waitForReady(tabId, scope, timeoutMs, requiredStable) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let lastCount = -2;

  while (Date.now() < deadline) {
    // 使用者要求停止：不再等待，交由擷取迴圈結束。
    if (stopRequested) {
      return true;
    }

    const state = await checkPageReady(tabId, scope);

    const ready =
      state.complete &&
      state.pending === 0 &&
      state.count === lastCount;

    stable = ready ? stable + 1 : 0;
    lastCount = state.count;

    if (stable >= requiredStable) {
      return true;
    }

    await wait(READY_POLL_MS);
  }

  return false;
}

async function scanForStitch(tabId, minSize) {
  const scan = await runInPage(tabId, scanPageInPage, [{
    minSize,
    includeExtras: false,
    includeSeparators: true
  }]);

  if (!scan) {
    throw new Error("無法掃描網頁圖片與廣告位置。");
  }

  return scan;
}

// 擷取一批截圖。每批是一個獨立的工作（jobId），最多 maxFrames 段。
// 若 startY 有值，會先捲動到該位置（捲動目標座標）再開始。
async function captureBatch({ tabId, windowId, jobId, startY }) {
  let pageTouched = false;
  let loadTimeouts = 0;
  let hiddenCount = 0;
  const minSize = await detectionMinSize();

  try {
    pageTouched = true;
    const target = await runInPage(tabId, prepareScrollTargetInPage);

    if (startY != null) {
      await runInPage(tabId, scrollToInPage, [startY]);
      await wait(WAIT_AFTER_SCROLL_MS);
    }

    await setProgress("正在等待頁面與圖片載入完成，請勿切換分頁或操作網頁，完成後會自動開始截圖……", "…");

    const initiallyReady = await waitForReady(tabId, "viewport", INITIAL_READY_TIMEOUT_MS, 3);

    if (!initiallyReady) {
      loadTimeouts++;
    }

    // 先掃描一次，取得可見高度與裝置像素比例，據以決定步距與批次上限。
    const probe = await scanForStitch(tabId, minSize);
    const visibleHeight = probe.clip.height;

    if (!visibleHeight || visibleHeight <= 0) {
      throw new Error("無法取得網頁可視高度。");
    }

    const step = Math.max(1, Math.floor(visibleHeight * SCROLL_RATIO));
    const dpr = probe.devicePixelRatio || 1;

    const maxFrames = Math.min(
      MAX_BATCH_FRAMES,
      Math.max(MIN_BATCH_FRAMES, Math.floor(MAX_DEVICE_HEIGHT / (step * dpr)))
    );

    let frameCount = 0;
    let done = false;
    let stopped = false;

    for (let i = 0; i < maxFrames; i++) {
      // 使用者按下「停止截圖」：保留已擷取的段落，不再往下擷取（例如不想截到下方的評論區）。
      if (stopRequested) {
        stopped = true;
        done = true;
        break;
      }

      await setProgress(
        `正在擷取第 ${i + 1} 段（本批最多 ${maxFrames} 段），請勿切換分頁或操作網頁。` +
          "擷取到想要的位置時，可按「停止截圖」結束……",
        String(i + 1)
      );

      // 每一段都等待視窗附近的圖片載入完成，才拍攝。
      const frameReady = await waitForReady(tabId, "viewport", FRAME_READY_TIMEOUT_MS, 2);

      if (stopRequested) {
        stopped = true;
        done = true;
        break;
      }

      if (!frameReady) {
        loadTimeouts++;
      }

      // 每一段都重新隱藏固定元素，途中才出現的浮動元素（Cookie 提示、客服視窗）也會被隱藏。
      hiddenCount = Math.max(hiddenCount, await runInPage(tabId, hideFixedElementsInPage) ?? 0);

      await wait(WAIT_AFTER_SCROLL_MS);

      const scan = await scanForStitch(tabId, minSize);

      // 拍攝前後都檢查，避免在檢查與拍攝之間切換分頁。
      await ensureTargetTabActive(tabId, windowId);
      const blob = await captureTab(windowId);
      await ensureTargetTabActive(tabId, windowId);

      await saveFrame({
        id: `${jobId}_${String(frameCount).padStart(3, "0")}`,
        jobId,
        index: frameCount,
        blob,
        scrollTop: scan.scrollTop,
        clip: scan.clip,
        innerWidth: scan.innerWidth,
        innerHeight: scan.innerHeight,
        layout: {
          images: scan.images.map((item) => ({
            top: item.top,
            bottom: item.bottom,
            left: item.left,
            right: item.right,
            src: item.src
          })),
          separators: scan.separators
        }
      });

      frameCount++;

      const nextTop = await runInPage(tabId, scrollByInPage, [step]);

      if (nextTop == null || nextTop <= scan.scrollTop) {
        done = true;
        break;
      }
    }

    if (frameCount === 0) {
      throw new Error(stopped ? "已停止長截圖，尚未擷取任何畫面。" : "沒有成功擷取任何畫面。");
    }

    return {
      frameCount,
      done,
      stopped,
      hiddenCount,
      loadTimeouts,
      scrollMode: target?.mode || "window"
    };
  } catch (error) {
    try {
      await deleteFrames(jobId);
    } catch (cleanupError) {
      console.error("清除暫存失敗：", cleanupError);
    }

    throw error;
  } finally {
    if (pageTouched) {
      try {
        await runInPage(tabId, restoreFixedElementsInPage);
        await runInPage(tabId, releaseScrollTargetInPage);
      } catch (restoreError) {
        console.error("還原網頁狀態失敗：", restoreError);
      }
    }

    await setProgress("", "");
  }
}

async function getSession() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.session);
  return result[STORAGE_KEYS.session] || null;
}

// 開啟或更新編輯頁，回傳編輯頁的分頁 id。
async function openOrUpdateEditor(session, sourceTab) {
  const url = editorUrl({ job: session.jobId });

  if (session.editorTabId != null) {
    try {
      await chrome.tabs.update(session.editorTabId, { url, active: true });
      return session.editorTabId;
    } catch (error) {
      console.warn("原編輯頁已不存在，改為開新頁：", error);
    }
  }

  const tab = await chrome.tabs.create({
    url,
    ...(sourceTab ? { index: sourceTab.index + 1, openerTabId: sourceTab.id } : {})
  });

  return tab.id;
}

// 第一批：從目前捲動位置開始。
async function startStitch(tabId, windowId) {
  await beginTask("stitch");

  try {
    const tab = await chrome.tabs.get(tabId);

    if (tab.windowId !== windowId || !tab.active) {
      throw new Error("請先切回要擷取的目標分頁。");
    }

    const jobId = newId("stitch_b1");
    const batch = await captureBatch({ tabId, windowId, jobId, startY: null });

    // 新的長截圖成功後，才清除上一個工作階段的暫存（同一時間只保留一個）。
    const previous = await getSession();

    if (previous?.jobId) {
      try {
        await deleteFrames(previous.jobId);
      } catch (error) {
        console.error("清除舊工作失敗：", error);
      }
    }

    const session = {
      tabId,
      windowId,
      jobId,
      batchIndex: 1,
      done: batch.done,
      stopped: batch.stopped,
      hiddenCount: batch.hiddenCount,
      loadTimeouts: batch.loadTimeouts,
      scrollMode: batch.scrollMode,
      nextStartY: null,
      editorTabId: null,
      pageUrl: tab.url || "",
      pageTitle: tab.title || "",
      startedAt: Date.now()
    };

    session.editorTabId = await openOrUpdateEditor(session, tab);
    await chrome.storage.local.set({ [STORAGE_KEYS.session]: session });

    return { stopped: batch.stopped };
  } finally {
    endTask();
  }
}

// 繼續下一批：從編輯頁決定的接續位置開始。
async function continueStitch(jobId, nextStartY) {
  await beginTask("stitch");

  try {
    const session = await getSession();

    if (!session || session.jobId !== jobId) {
      throw new Error("這個長截圖已經結束或被新的長截圖取代，無法繼續。");
    }

    if (session.done || nextStartY == null) {
      throw new Error("目前沒有可繼續的截圖位置。");
    }

    // 切回目標分頁，確保可以擷取可見畫面。
    await chrome.windows.update(session.windowId, { focused: true });
    await chrome.tabs.update(session.tabId, { active: true });

    const batchIndex = session.batchIndex + 1;
    const nextJobId = newId(`stitch_b${batchIndex}`);

    const batch = await captureBatch({
      tabId: session.tabId,
      windowId: session.windowId,
      jobId: nextJobId,
      startY: nextStartY
    });

    // 新一批成功後才刪除上一批的暫存。
    try {
      await deleteFrames(session.jobId);
    } catch (error) {
      console.error("清除上一批暫存失敗：", error);
    }

    const updated = {
      ...session,
      jobId: nextJobId,
      batchIndex,
      done: batch.done,
      stopped: batch.stopped,
      hiddenCount: batch.hiddenCount,
      loadTimeouts: batch.loadTimeouts,
      scrollMode: batch.scrollMode,
      nextStartY: null
    };

    updated.editorTabId = await openOrUpdateEditor(updated, null);
    await chrome.storage.local.set({ [STORAGE_KEYS.session]: updated });

    return { stopped: batch.stopped };
  } finally {
    endTask();
  }
}

// 清除長截圖工作階段與暫存截圖。
async function discardStitchSession() {
  const session = await getSession();

  if (session?.jobId) {
    try {
      await deleteFrames(session.jobId);
    } catch (error) {
      console.error("清除長圖暫存失敗：", error);
    }
  }

  await chrome.storage.local.remove([STORAGE_KEYS.session, STORAGE_KEYS.progress]);
}

// 編輯頁按「結束並清除暫存」：只清除該頁對應的工作階段，不影響之後開始的新長截圖。
async function finishStitch(jobId) {
  if (busyTask === "stitch") {
    throw new Error("長截圖正在進行中，請等待完成。");
  }

  const session = await getSession();

  if (session?.jobId === jobId) {
    await discardStitchSession();
  }
}

// ---- 暫存自動清除 ----

// 編輯頁被關閉時，清除它使用的暫存截圖。
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.session,
      STORAGE_KEYS.captureTabs
    ]);

    const session = stored[STORAGE_KEYS.session];

    // 長截圖進行中時，編輯頁會在完成後重新開啟，因此不清除。
    if (session && session.editorTabId === tabId && busyTask !== "stitch") {
      await discardStitchSession();
    }

    const captureTabs = stored[STORAGE_KEYS.captureTabs] || {};
    const captureId = captureTabs[tabId];

    if (captureId) {
      await deleteCapture(captureId);
      delete captureTabs[tabId];
      await chrome.storage.local.set({ [STORAGE_KEYS.captureTabs]: captureTabs });
    }
  } catch (error) {
    console.error("清除暫存失敗：", error);
  }
});

// 瀏覽器重新啟動時，之前的編輯頁都已關閉，清除所有遺留的暫存。
async function clearLeftovers() {
  try {
    await clearAllCaptures();
  } catch (error) {
    console.error("清除遺留暫存失敗：", error);
  }

  await chrome.storage.local.remove([
    STORAGE_KEYS.session,
    STORAGE_KEYS.progress,
    STORAGE_KEYS.captureTabs,
    // 舊版本使用的鍵值。
    "pendingCapture",
    "pendingStitchJob"
  ]);
}

chrome.runtime.onStartup.addListener(clearLeftovers);

chrome.runtime.onInstalled.addListener((details) => {
  // 更新後暫存格式可能不同，清除舊版本的暫存。
  if (details.reason === "install" || details.reason === "update") {
    clearLeftovers();
  }
});

// ---- 快捷鍵 ----

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    if (!tab?.id || tab.windowId == null) {
      throw new Error("找不到目前的分頁。");
    }

    // 長截圖或翻頁截圖進行中，再按一次同一個快捷鍵：停止並保留已擷取的部分。
    if (
      (command === "capture-full" && busyTask === "stitch") ||
      (command === "capture-pages" && busyTask === "pages")
    ) {
      requestStop();
      await setProgress("正在停止，已擷取的部分會保留……", "■");
      return;
    }

    if (command === "capture-visible") {
      await captureVisible(tab);
    } else if (command === "capture-full") {
      await startStitch(tab.id, tab.windowId);
    } else if (command === "capture-pages") {
      await capturePages(tab);
    }
  } catch (error) {
    console.error("快捷鍵截圖失敗：", error);
    await showBadgeError(friendlyError(error, "截圖失敗。"));
  }
});

// ---- 訊息 ----

// Chrome 回傳的英文錯誤改為使用者看得懂的說明（例如在 chrome:// 頁面上截圖）。
function friendlyError(error, fallbackMessage) {
  const message = error?.message || "";

  if (/chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|extensions gallery|Chrome Web Store|cannot be scripted/i.test(message)) {
    return "這個頁面無法截圖：Chrome 不允許擴充功能擷取內建頁面（網址以 chrome:// 開頭）、" +
      "線上應用程式商店與其他擴充功能的頁面。請切換到一般網頁再試。";
  }

  if (/Cannot access contents|Missing host permission|activeTab/i.test(message)) {
    return "目前沒有存取這個頁面的權限（網頁可能已重新整理或換頁）。請在網頁上重新按一次工具列圖示或快捷鍵。";
  }

  if (/No tab with id|Tabs cannot be edited/i.test(message)) {
    return "找不到目標分頁，可能已經關閉。請重新開始截圖。";
  }

  return message || fallbackMessage;
}

function respond(promise, sendResponse, fallbackMessage) {
  promise
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((error) => {
      console.error(fallbackMessage, error);
      sendResponse({ ok: false, error: friendlyError(error, fallbackMessage) });
    });

  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case MESSAGES.captureVisible:
      return respond(
        chrome.tabs.get(message.tabId).then(captureVisible),
        sendResponse,
        "截圖失敗。"
      );

    case MESSAGES.capturePages:
      return respond(
        chrome.tabs.get(message.tabId).then(capturePages),
        sendResponse,
        "翻頁截圖失敗。"
      );

    case MESSAGES.startStitch:
      return respond(
        startStitch(message.tabId, message.windowId),
        sendResponse,
        "長圖擷取失敗。"
      );

    case MESSAGES.continueStitch:
      return respond(
        continueStitch(message.jobId, message.nextStartY),
        sendResponse,
        "繼續截圖失敗。"
      );

    case MESSAGES.stopCapture:
      return respond(
        Promise.resolve().then(() => {
          requestStop();
          return setProgress("正在停止，已擷取的部分會保留……", "■");
        }),
        sendResponse,
        "無法停止截圖。"
      );

    case MESSAGES.getStatus:
      sendResponse({ ok: true, busyTask });
      return false;

    case MESSAGES.finishStitch:
      return respond(finishStitch(message.jobId), sendResponse, "清除暫存失敗。");

    default:
      return false;
  }
});
