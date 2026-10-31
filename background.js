const DB_NAME = "ScreenshotStitchDB";
// 版本 2：舊版編輯頁可能在沒有資料表的情況下建立了版本 1 的資料庫，
// 升級時會補建資料表。此版本號必須與 editor.js 的 STITCH_DB_VERSION 一致。
const DB_VERSION = 2;
const STORE_NAME = "frames";

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

const SESSION_KEY = "stitchSession";

let isStitching = false;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id"
        });

        store.createIndex("jobId", "jobId", {
          unique: false
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveFrame(frame) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");

    transaction.objectStore(STORE_NAME).put(frame);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };

    transaction.onabort = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function deleteFrames(jobId) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index("jobId");
    const request = index.openCursor(IDBKeyRange.only(jobId));

    request.onsuccess = () => {
      const cursor = request.result;

      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newJobId(batchIndex) {
  return `stitch_${Date.now()}_b${batchIndex}`;
}

// ---- 以下函式會被序列化後注入目標網頁，必須完全自給自足 ----

// 隱藏固定定位與吸附在視窗邊緣的 sticky 元素（visibility: hidden，保留版面）。
// 原始樣式記錄在 window.__sccHidden，供還原使用。回傳隱藏的元素數量。
function hideFixedElementsInPage() {
  const leftover = window.__sccHidden || [];

  for (const entry of leftover) {
    entry.el.style.setProperty(
      "visibility",
      entry.value,
      entry.priority
    );
  }

  const vw = window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const viewportArea = vw * vh;

  const containsLargeMedia = (element) => {
    const media = element.querySelectorAll("img, video, canvas");

    for (const item of media) {
      const rect = item.getBoundingClientRect();

      if (rect.width * rect.height >= viewportArea * 0.4) {
        return true;
      }
    }

    return false;
  };

  const hidden = [];

  for (const element of document.querySelectorAll("body *")) {
    const style = window.getComputedStyle(element);

    if (style.position !== "fixed" && style.position !== "sticky") {
      continue;
    }

    if (style.visibility === "hidden") {
      continue;
    }

    const rect = element.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      continue;
    }

    if (style.position === "sticky") {
      const stuck = rect.top <= 1 || rect.bottom >= vh - 1;

      if (!stuck) {
        continue;
      }
    }

    if (
      rect.width * rect.height >= viewportArea * 0.5 &&
      containsLargeMedia(element)
    ) {
      continue;
    }

    hidden.push({
      el: element,
      value: element.style.getPropertyValue("visibility"),
      priority: element.style.getPropertyPriority("visibility")
    });

    element.style.setProperty("visibility", "hidden", "important");
  }

  window.__sccHidden = hidden;

  return hidden.length;
}

function restoreFixedElementsInPage() {
  const hidden = window.__sccHidden || [];

  for (const entry of hidden) {
    entry.el.style.setProperty(
      "visibility",
      entry.value,
      entry.priority
    );
  }

  window.__sccHidden = [];

  return hidden.length;
}

// 掃描目前畫面，回傳圖片與廣告區塊的整頁座標（CSS 像素），
// 以及內容區域（不含捲軸）與裝置像素比例等尺寸資訊。
function scanPageForStitch() {
  const contentHeight =
    document.documentElement.clientHeight || window.innerHeight;
  const contentWidth =
    document.documentElement.clientWidth || window.innerWidth;

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  const AD_PATTERN =
    /(^|[^a-z])(ad|ads|advert|advertisement|advertising|sponsor|sponsored|banner|adsbygoogle|doubleclick|googlesyndication)([^a-z]|$)/i;

  const VIDEO_PATTERN = /youtube|youtu\.be|vimeo|bilibili|player/i;

  const isRendered = (element) => {
    let node = element;

    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const style = window.getComputedStyle(node);

      if (style.display === "none" || Number(style.opacity) === 0) {
        return false;
      }

      node = node.parentElement;
    }

    return window.getComputedStyle(element).visibility !== "hidden";
  };

  const toPage = (rect) => ({
    top: rect.top + scrollY,
    bottom: rect.bottom + scrollY,
    left: rect.left + scrollX,
    right: rect.right + scrollX
  });

  const images = [];

  for (const img of document.images) {
    if (
      !isRendered(img) ||
      !img.complete ||
      img.naturalWidth < 40 ||
      img.naturalHeight < 40
    ) {
      continue;
    }

    const rect = img.getBoundingClientRect();

    if (rect.width < 40 || rect.height < 40) {
      continue;
    }

    images.push({
      ...toPage(rect),
      src: img.currentSrc || img.src,
      alt: img.alt || ""
    });
  }

  const separators = [];

  for (const element of document.querySelectorAll("iframe, ins, [id], [class]")) {
    if (element.tagName === "IMG") {
      continue;
    }

    const attributeText =
      `${element.id || ""} ${element.getAttribute("class") || ""} ` +
      `${element.getAttribute("name") || ""}`;

    const sourceText =
      element.tagName === "IFRAME" ? element.getAttribute("src") || "" : "";

    const isVideoEmbed = VIDEO_PATTERN.test(sourceText);

    const isAdLike =
      element.classList.contains("adsbygoogle") ||
      AD_PATTERN.test(attributeText) ||
      AD_PATTERN.test(sourceText) ||
      (element.tagName === "IFRAME" && !isVideoEmbed);

    if (!isAdLike) {
      continue;
    }

    if (window.getComputedStyle(element).position === "fixed") {
      continue;
    }

    if (!isRendered(element)) {
      continue;
    }

    const rect = element.getBoundingClientRect();

    if (rect.width < 200 || rect.height < 50 || rect.height > contentHeight * 1.5) {
      continue;
    }

    const box = toPage(rect);

    separators.push({
      top: box.top,
      bottom: box.bottom
    });
  }

  return {
    scrollY,
    viewportHeight: contentHeight,
    contentWidth,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    images,
    separators
  };
}

// 將目標頁面捲動到指定的整頁位置。
function scrollToPageInPage(top) {
  window.scrollTo({ top, behavior: "instant" });

  return window.scrollY;
}

// 向下捲動一段距離，回傳捲動後的位置與是否已到底部。
function scrollStepInPage(distance) {
  const before = window.scrollY;

  window.scrollTo({
    top: before + distance,
    behavior: "instant"
  });

  return window.scrollY;
}

// 檢查視窗附近的圖片是否都已載入完成。scope 為 "viewport" 時只看視窗附近的圖片，
// 因為遠處的 lazy-load 圖片在捲動到之前本來就不會載入。
function checkPageReadyInPage(scope) {
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const margin = 300;

  let pending = 0;

  for (const img of document.images) {
    const style = window.getComputedStyle(img);
    const rect = img.getBoundingClientRect();

    if (style.display === "none" || style.visibility === "hidden") {
      continue;
    }

    if (rect.width < 2 || rect.height < 2) {
      continue;
    }

    const nearViewport = rect.bottom > -margin && rect.top < vh + margin;

    if (scope === "viewport" && !nearViewport) {
      continue;
    }

    if (!img.complete) {
      pending++;
    }
  }

  return {
    complete: document.readyState === "complete",
    pending,
    count: document.images.length
  };
}

async function checkPageReady(tabId, scope) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [scope],
    func: checkPageReadyInPage
  });

  return results?.[0]?.result ?? { complete: false, pending: 1, count: -1 };
}

// 等待頁面穩定：連續數次檢查都沒有待載入的圖片，且圖片數量不再變動。
// 回傳 true 表示已穩定；逾時回傳 false（仍會繼續截圖，但會記錄警告）。
async function waitForReady(tabId, scope, timeoutMs, requiredStable) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let lastCount = -2;

  while (Date.now() < deadline) {
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

// 進度文字寫入 storage，彈出視窗與編輯頁會監聽並顯示。
async function setProgress(text) {
  try {
    await chrome.storage.local.set({
      stitchProgress: { text, at: Date.now() }
    });
  } catch (error) {
    console.warn("無法更新進度：", error);
  }
}

async function hideFixedElements(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: hideFixedElementsInPage
  });

  return results?.[0]?.result ?? 0;
}

async function restoreFixedElements(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: restoreFixedElementsInPage
  });
}

async function scanPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: scanPageForStitch
  });

  const scan = results?.[0]?.result;

  if (!scan) {
    throw new Error("無法掃描網頁圖片與廣告位置。");
  }

  return scan;
}

async function scrollToPage(tabId, top) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [top],
    func: scrollToPageInPage
  });

  return results?.[0]?.result ?? 0;
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

async function scrollStep(tabId, distance) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [distance],
    func: scrollStepInPage
  });

  return results?.[0]?.result ?? 0;
}

// 擷取一批截圖。每批是一個獨立的工作（jobId），最多 maxFrames 段。
// 若 startY 有值，會先捲動到該整頁位置再開始。
async function captureBatch({ tabId, windowId, jobId, startY }) {
  if (isStitching) {
    throw new Error("目前已有截圖工作正在執行。");
  }

  isStitching = true;

  let hidingStarted = false;
  let loadTimeouts = 0;

  try {
    if (startY != null) {
      await scrollToPage(tabId, startY);
      await wait(WAIT_AFTER_SCROLL_MS);
    }

    await setProgress("正在等待頁面與圖片載入完成，請勿操作網頁，完成後會自動開始截圖……");

    const initiallyReady = await waitForReady(
      tabId,
      "viewport",
      INITIAL_READY_TIMEOUT_MS,
      3
    );

    if (!initiallyReady) {
      loadTimeouts++;
    }

    // 先掃描一次，取得視窗高度與裝置像素比例，據以決定步距與批次上限。
    const probe = await scanPage(tabId);
    const viewportHeight = probe.viewportHeight;

    if (!viewportHeight || viewportHeight <= 0) {
      throw new Error("無法取得網頁可視高度。");
    }

    const step = Math.max(1, Math.floor(viewportHeight * SCROLL_RATIO));
    const dpr = probe.devicePixelRatio || 1;

    const maxFrames = Math.min(
      MAX_BATCH_FRAMES,
      Math.max(
        MIN_BATCH_FRAMES,
        Math.floor(MAX_DEVICE_HEIGHT / (step * dpr))
      )
    );

    hidingStarted = true;
    const hiddenCount = await hideFixedElements(tabId);

    let frameCount = 0;
    let done = false;

    for (let i = 0; i < maxFrames; i++) {
      await setProgress(
        `正在擷取第 ${i + 1} 段（本批最多 ${maxFrames} 段），請勿操作網頁……`
      );

      // 每一段都等待視窗附近的圖片載入完成，才拍攝。
      const frameReady = await waitForReady(
        tabId,
        "viewport",
        FRAME_READY_TIMEOUT_MS,
        2
      );

      if (!frameReady) {
        loadTimeouts++;
      }

      await wait(WAIT_AFTER_SCROLL_MS);

      const scan = await scanPage(tabId);

      // 拍攝前後都檢查，避免在檢查與拍攝之間切換分頁。
      await ensureTargetTabActive(tabId, windowId);

      const screenshot = await chrome.tabs.captureVisibleTab(
        windowId,
        { format: "png" }
      );

      await ensureTargetTabActive(tabId, windowId);

      await saveFrame({
        id: `${jobId}_${String(frameCount).padStart(3, "0")}`,
        jobId,
        index: frameCount,
        dataUrl: screenshot,
        scrollY: scan.scrollY,
        viewportHeight: scan.viewportHeight,
        innerWidth: scan.innerWidth,
        innerHeight: scan.innerHeight,
        contentWidth: scan.contentWidth,
        layout: {
          images: scan.images,
          separators: scan.separators
        }
      });

      frameCount++;

      const nextY = await scrollStep(tabId, step);

      if (nextY <= scan.scrollY) {
        done = true;
        break;
      }
    }

    if (frameCount === 0) {
      throw new Error("沒有成功擷取任何畫面。");
    }

    return { frameCount, done, hiddenCount, loadTimeouts };
  } catch (error) {
    try {
      await deleteFrames(jobId);
    } catch (cleanupError) {
      console.error("清除暫存失敗：", cleanupError);
    }

    throw error;
  } finally {
    if (hidingStarted) {
      try {
        await restoreFixedElements(tabId);
      } catch (restoreError) {
        console.error("還原固定元素失敗：", restoreError);
      }
    }

    isStitching = false;
  }
}

async function getSession() {
  const result = await chrome.storage.local.get(SESSION_KEY);
  return result[SESSION_KEY] || null;
}

// 開啟或重新整理編輯頁，回傳編輯頁的分頁 id。
async function openOrReloadEditor(session) {
  const url = chrome.runtime.getURL("editor.html");

  if (session.editorTabId != null) {
    try {
      await chrome.tabs.update(session.editorTabId, { active: true });
      await chrome.tabs.reload(session.editorTabId);
      return session.editorTabId;
    } catch (error) {
      console.warn("原編輯頁已不存在，改為開新頁：", error);
    }
  }

  const tab = await chrome.tabs.create({ url });
  return tab.id;
}

// 第一批：從目前捲動位置開始。
async function startStitch(tabId, windowId) {
  if (isStitching) {
    throw new Error("目前已有一項長圖擷取工作正在執行。");
  }

  const tab = await chrome.tabs.get(tabId);

  if (tab.windowId !== windowId || !tab.active) {
    throw new Error("請先切回要擷取的目標分頁。");
  }

  // 清除上一個未完成的工作。
  const previous = await getSession();

  if (previous?.jobId) {
    try {
      await deleteFrames(previous.jobId);
    } catch (error) {
      console.error("清除舊工作失敗：", error);
    }
  }

  const jobId = newJobId(1);

  const batch = await captureBatch({
    tabId,
    windowId,
    jobId,
    startY: null
  });

  const session = {
    tabId,
    windowId,
    jobId,
    batchIndex: 1,
    done: batch.done,
    hiddenCount: batch.hiddenCount,
    loadTimeouts: batch.loadTimeouts,
    nextStartY: null,
    editorTabId: null
  };

  await chrome.storage.local.set({
    [SESSION_KEY]: session,
    pendingStitchJob: jobId
  });

  session.editorTabId = await openOrReloadEditor(session);

  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

// 繼續下一批：從編輯頁決定的接續位置開始。
async function continueStitch() {
  if (isStitching) {
    throw new Error("目前已有截圖工作正在執行。");
  }

  const session = await getSession();

  if (!session || session.done || session.nextStartY == null) {
    throw new Error("目前沒有可繼續的截圖位置。");
  }

  // 切回目標分頁，確保可以擷取可見畫面。
  await chrome.windows.update(session.windowId, { focused: true });
  await chrome.tabs.update(session.tabId, { active: true });

  const batchIndex = session.batchIndex + 1;
  const jobId = newJobId(batchIndex);

  const batch = await captureBatch({
    tabId: session.tabId,
    windowId: session.windowId,
    jobId,
    startY: session.nextStartY
  });

  // 新一批成功後才刪除上一批的暫存。
  try {
    await deleteFrames(session.jobId);
  } catch (error) {
    console.error("清除上一批暫存失敗：", error);
  }

  const updated = {
    ...session,
    jobId,
    batchIndex,
    done: batch.done,
    hiddenCount: batch.hiddenCount,
    loadTimeouts: batch.loadTimeouts,
    nextStartY: null
  };

  await chrome.storage.local.set({
    [SESSION_KEY]: updated,
    pendingStitchJob: jobId
  });

  updated.editorTabId = await openOrReloadEditor(updated);

  await chrome.storage.local.set({ [SESSION_KEY]: updated });
}

// 清除目前的長圖工作階段（含暫存截圖），讓單張擷取不會被舊的長圖結果蓋過。
async function discardStitchSession() {
  if (isStitching) {
    throw new Error("長圖擷取進行中，無法切換為單張截圖，請等待完成。");
  }

  const session = await getSession();

  if (session?.jobId) {
    try {
      await deleteFrames(session.jobId);
    } catch (error) {
      console.error("清除長圖暫存失敗：", error);
    }
  }

  await chrome.storage.local.remove([
    SESSION_KEY,
    "pendingStitchJob",
    "stitchProgress"
  ]);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DISCARD_STITCH") {
    discardStitchSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "無法清除長圖暫存。"
        });
      });

    return true;
  }

  if (message?.type === "START_STITCH") {
    startStitch(message.tabId, message.windowId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("長圖擷取失敗：", error);
        sendResponse({
          ok: false,
          error: error.message || "長圖擷取失敗。"
        });
      });

    return true;
  }

  if (message?.type === "CONTINUE_STITCH") {
    continueStitch()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("繼續截圖失敗：", error);
        sendResponse({
          ok: false,
          error: error.message || "繼續截圖失敗。"
        });
      });

    return true;
  }
});
