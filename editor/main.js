// 編輯頁進入點：依網址參數載入單張截圖（?capture=）或長條截圖（?job=），並串接各模組。

import { STORAGE_KEYS } from "../lib/constants.js";
import { getCapture } from "../lib/db.js";
import { siteNameFromUrl, timestampText } from "../lib/downloads.js";
import { buildDetections } from "../lib/stitch-plan.js";
import { drawNow, requestDraw, setOverlayDrawer, setSource } from "./canvas.js";
import { dom, setStatus } from "./dom.js";
import { initInteraction } from "./interaction.js";
import { describeDownload, downloadItems, revokePreviewUrls } from "./output.js";
import {
  drawActiveItem,
  drawDetectionBoxes,
  drawEditHandles,
  initSingleMode,
  refreshSingleControls,
  renderResults,
  resetDetections
} from "./single-mode.js";
import { state } from "./state.js";
import {
  buildStitchedCanvas,
  buildStitchStatus,
  defaultRemovedGapIds,
  detectSides,
  drawStitchOverlay,
  initSides,
  initStitchMode,
  protectImages,
  recomputeStitch,
  refreshStitchControls,
  renderStitchGroups,
  resetCuts
} from "./stitch-mode.js";

const SELECTION_COLOR = "#00a8ff";

function refreshControls() {
  refreshSingleControls();
  refreshStitchControls();
}

function applyMode() {
  const stitch = state.mode === "stitch";

  dom.modeBadge.textContent = stitch ? "長條截圖" : "單張截圖";

  // 還原按鈕的名稱與提示隨模式改變，讓使用者知道會還原什麼。
  dom.resetAllButton.textContent = stitch ? "還原移除區域" : "還原偵測框";
  dom.resetAllButton.title = stitch
    ? "把拖曳過的移除區域恢復為自動偵測的結果，並刪除手動新增的區域"
    : "把所有偵測框還原到自動偵測時的位置，並清除手動選取";

  dom.imageBatchControls.hidden = stitch;
  dom.stitchBatchControls.hidden = !stitch;
  dom.sessionControls.hidden = !stitch;

  if (stitch) {
    dom.resultsTitle.textContent = "長圖段落結果";
    dom.resultsInstruction.textContent =
      "紅色區域為會被移除的範圍（上下間隔與左右空白），黃色虛線為保留的範圍。" +
      "點擊預覽區的區域，或在下方勾選，即可切換移除與保留。" +
      "紫色標記為段落起點，段落的結束點會優先落在分隔處。";
  } else {
    dom.resultsTitle.textContent = "自動偵測結果";
    dom.resultsInstruction.textContent =
      "偵測圖片、影片、畫布、向量圖與背景圖，依網頁由上到下、由左到右排序，預設全部勾選。" +
      "可以單獨下載，或勾選後批次下載。只會偵測目前畫面可見的部分。";
  }
}

// 標示圖層：偵測框或移除區域，再疊上手動選取框。
function drawOverlay(ctx) {
  if (state.mode === "stitch") {
    drawStitchOverlay(ctx);
  } else {
    drawDetectionBoxes(ctx);
  }

  const selection = state.selection;

  if (selection && selection.width > 0 && selection.height > 0) {
    // 選取範圍以外變暗（evenodd 留下中間的洞，不會蓋住選取範圍）。
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.beginPath();
    ctx.rect(0, 0, state.width, state.height);
    ctx.rect(selection.x, selection.y, selection.width, selection.height);
    ctx.fill("evenodd");
    ctx.restore();

    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = Math.max(2, Math.round(state.width / 800));
    ctx.strokeRect(selection.x, selection.y, selection.width, selection.height);

    if (state.mode === "single") {
      drawEditHandles(ctx, selection, SELECTION_COLOR);
    }
  }

  if (state.mode === "single") {
    drawActiveItem(ctx);
  }
}

function canvasFromBitmap(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return canvas;
}

async function loadSingle(captureId) {
  const capture = await getCapture(captureId);

  if (!capture?.blob) {
    throw new Error("找不到截圖暫存，請重新擷取。");
  }

  const bitmap = await createImageBitmap(capture.blob);
  const canvas = canvasFromBitmap(bitmap);
  bitmap.close();

  state.mode = "single";
  state.meta = { site: siteNameFromUrl(capture.pageUrl), time: capture.createdAt };
  document.title = `截圖：${capture.pageTitle || state.meta.site}`;

  setSource(canvas);
  state.loaded = true;
  applyMode();

  state.detectedImages = buildDetections(capture, state.width, state.height);

  drawNow();
  renderResults();

  setStatus(
    `截圖尺寸：${state.width} × ${state.height}；偵測到 ${state.detectedImages.length} 個項目。` +
    (capture.aligned === false
      ? "注意：網頁在截圖時持續捲動，偵測框可能有些偏移，請確認後再下載。"
      : "")
  );
}

async function loadStitch(jobId) {
  setStatus("正在拼接長圖……");

  const stored = await chrome.storage.local.get(STORAGE_KEYS.session);
  const session = stored[STORAGE_KEYS.session] || null;
  const isCurrent = session?.jobId === jobId;

  state.session = session;
  state.jobId = jobId;

  const reachedBottom = isCurrent ? session.done === true : true;
  const built = await buildStitchedCanvas(jobId, reachedBottom);

  state.mode = "stitch";
  state.meta = {
    site: siteNameFromUrl(isCurrent ? session.pageUrl : ""),
    time: isCurrent ? session.startedAt : Date.now()
  };
  document.title = `長截圖：${(isCurrent && session.pageTitle) || state.meta.site}`;

  setSource(built.canvas);
  state.loaded = true;
  applyMode();

  state.nextStartY = isCurrent ? built.nextStartY : null;

  state.stitchLayout = {
    layouts: built.layouts,
    originScrollY: built.originScrollY,
    scale: built.scale
  };

  state.stitchInfo = {
    frameCount: built.frameCount,
    gapCount: built.gapCount,
    hiddenCount: isCurrent ? session.hiddenCount ?? 0 : 0,
    loadTimeouts: isCurrent ? session.loadTimeouts ?? 0 : 0,
    batchIndex: isCurrent ? session.batchIndex ?? 1 : 1,
    scrollMode: isCurrent ? session.scrollMode : "window",
    reachedBottom,
    forcedEnd: built.forcedEnd
  };

  initSides(protectImages(detectSides(built.canvas), built.pxPerCssX));

  state.cutOverrides = new Map();
  state.customCuts = [];
  state.removedGapIds = defaultRemovedGapIds();

  recomputeStitch();
  drawNow();
  await renderStitchGroups();

  setStatus(buildStitchStatus());
}

async function load() {
  const params = new URLSearchParams(location.search);

  try {
    if (params.has("job")) {
      await loadStitch(params.get("job"));
    } else if (params.has("capture")) {
      await loadSingle(params.get("capture"));
    } else {
      throw new Error("找不到截圖，請從工具列重新擷取。");
    }

    dom.saveButton.disabled = false;
  } catch (error) {
    console.error(error);
    setStatus(error.message || "無法載入截圖。");
    dom.resultsContainer.textContent = "目前沒有結果。";
  } finally {
    refreshControls();
  }
}

// ---- 共用按鈕 ----

dom.resetButton.addEventListener("click", () => {
  state.selection = null;
  state.startPoint = null;
  state.isDragging = false;

  requestDraw();
  setStatus("已清除手動選取範圍。");
});

dom.resetAllButton.addEventListener("click", () => {
  state.selection = null;
  state.startPoint = null;
  state.isDragging = false;

  if (state.mode === "stitch") {
    resetCuts();
    setStatus("已還原為自動偵測的移除範圍。");
    return;
  }

  resetDetections();
  requestDraw();
  setStatus("已還原所有偵測框為偵測到的原始位置，並清除手動選取。");
});

dom.saveButton.addEventListener("click", async () => {
  if (!state.loaded || !state.selection || state.selection.width < 2) {
    setStatus("請先在截圖上拖曳，選取要下載的範圍。");
    return;
  }

  dom.saveButton.disabled = true;

  try {
    const label = `manual_${timestampText(Date.now()).slice(9)}`;
    const result = await downloadItems([{ label, rects: { ...state.selection } }]);
    setStatus(describeDownload(result, "張圖片"));
  } finally {
    dom.saveButton.disabled = false;
  }
});

dom.settingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// 繼續截圖時，背景程式的進度文字顯示在狀態列。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEYS.progress]) return;

  const text = changes[STORAGE_KEYS.progress].newValue?.text;

  if (state.busy && text) {
    setStatus(text);
  }
});

window.addEventListener("pagehide", revokePreviewUrls);

setOverlayDrawer(drawOverlay);
initSingleMode(refreshControls);
initStitchMode(refreshControls);
initInteraction();
load();
