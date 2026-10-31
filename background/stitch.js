// 長條截圖：自動捲動、分段截圖並存入暫存，由編輯頁拼接；頁面很長時分批擷取。

import { STORAGE_KEYS } from "../lib/constants.js";
import { deleteFrames, saveFrame } from "../lib/db.js";
import {
  checkPageReadyInPage,
  hideFixedElementsInPage,
  prepareScrollTargetInPage,
  releaseScrollTargetInPage,
  restoreFixedElementsInPage,
  scanPageInPage,
  scrollByInPage,
  scrollToInPage
} from "../lib/page-scripts.js";
import {
  captureTab,
  detectionMinSize,
  editorUrl,
  ensureTargetTabActive,
  newId,
  runInPage,
  setProgress,
  wait
} from "./common.js";
import { beginTask, endTask, getBusyTask, isStopRequested } from "./task.js";

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
    if (isStopRequested()) {
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
      if (isStopRequested()) {
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

      if (isStopRequested()) {
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

export async function getSession() {
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
export async function startStitch(tabId, windowId) {
  beginTask("stitch");

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
export async function continueStitch(jobId, nextStartY) {
  beginTask("stitch");

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
export async function discardStitchSession() {
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
export async function finishStitch(jobId) {
  if (getBusyTask() === "stitch") {
    throw new Error("長截圖正在進行中，請等待完成。");
  }

  const session = await getSession();

  if (session?.jobId === jobId) {
    await discardStitchSession();
  }
}
