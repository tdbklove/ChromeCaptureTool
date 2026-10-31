// 編輯頁進入點：依網址參數載入單張截圖（?capture=）或長條截圖（?job=），並串接各模組。

import { STORAGE_KEYS } from "../lib/constants.js";
import { getCapture } from "../lib/db.js";
import { siteNameFromUrl, timestampText } from "../lib/downloads.js";
import { DEFAULT_DOWNLOAD_SETTINGS, getDownloadSettings } from "../lib/settings.js";
import { buildDetections } from "../lib/stitch-plan.js";
import {
  drawNow,
  initZoom,
  requestDraw,
  setOverlayDrawer,
  setSource,
  updateZoomControls
} from "./canvas.js";
import { dom, flashButton, notify, setStatus } from "./dom.js";
import { initHistory, recordHistory, redo, resetHistory, undo } from "./history.js";
import { initInteraction } from "./interaction.js";
import {
  copyRects,
  downloadItems,
  reportDownload,
  revokePreviewUrls,
  runDownload
} from "./output.js";
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
  deleteActiveCut,
  detectedEdges,
  detectSides,
  drawStitchOverlay,
  initSides,
  initTrims,
  initStitchMode,
  protectImages,
  recomputeStitch,
  refreshStitchControls,
  renderStitchGroups,
  resetCuts,
  updateAddCutButton,
  updateStitchView
} from "./stitch-mode.js";

const SELECTION_COLOR = "#00a8ff";

function refreshControls() {
  refreshSingleControls();
  refreshStitchControls();
  updateZoomControls();
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
  dom.stitchDownloadControls.hidden = !stitch;
  dom.sessionControls.hidden = !stitch;

  // 預覽區的說明：只描述目前模式中實際會出現的顏色與操作。
  dom.previewHint.textContent = stitch
    ? "紅色區域為會被移除的範圍（上下的間隔與左右的空白），黃色虛線為保留的範圍，點一下即可切換移除或保留。" +
      "拖曳紅色區域的上下邊線可調整範圍；長圖最上方與最下方的邊線可上下拖曳，裁掉不需要的高度；左右兩側的邊線可左右拖曳。" +
      "在其他位置拖曳可手動框選範圍（藍色框線，框外會變暗），再按「下載手動選取範圍」。"
    : "綠色框線為偵測到的圖片，取消勾選「加入批次下載」的圖片會改為灰色框線。" +
      "點一下圖片框即可拖曳它的邊線調整範圍。" +
      "在其他位置拖曳可手動框選範圍（藍色框線，框外會變暗），再按「下載手動選取範圍」。";

  if (stitch) {
    dom.resultsTitle.textContent = "長圖段落結果";
    dom.resultsInstruction.textContent =
      "移除區域會把長圖分成多組，預覽區的藍色線為每一組的起點；" +
      "過長的組會在間隔處自動分段，紫色線為分段的位置。" +
      "每一段可以單獨下載，或勾選「加入合併」後合併成一張長圖。";
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
  initTrims(detectedEdges());

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
    dom.copySelectionButton.disabled = false;
    resetHistory();
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
    notify("請先在截圖上拖曳，選取要下載的範圍。", "error");
    return;
  }

  dom.saveButton.disabled = true;

  const label = `manual_${timestampText(Date.now()).slice(9)}`;
  const result = await runDownload(() =>
    downloadItems([{ label, rects: { ...state.selection } }]));

  dom.saveButton.disabled = false;

  if (result) {
    reportDownload(result, "張圖片", { button: dom.saveButton, buttonText: "下載手動選取範圍" });
  }
});

dom.copySelectionButton.addEventListener("click", async () => {
  if (!state.loaded || !state.selection || state.selection.width < 2) {
    notify("請先在截圖上拖曳，選取要複製的範圍。", "error");
    return;
  }

  dom.copySelectionButton.disabled = true;

  try {
    await copyRects({ ...state.selection });
    dom.copySelectionButton.disabled = false;
    notify("已將手動選取範圍複製到剪貼簿，可以直接貼上（Ctrl＋V）。");
    flashButton(dom.copySelectionButton, "✓ 已複製", "複製手動選取範圍");
  } catch (error) {
    console.error("複製失敗：", error);
    dom.copySelectionButton.disabled = false;
    notify("複製失敗：圖片可能過大，或瀏覽器不允許存取剪貼簿。請改用下載。", "error");
  }
});

dom.settingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// ---- 復原／重做 ----

// 從歷史紀錄還原狀態後，重新計算並更新畫面。
function afterRestore() {
  state.activeCutIndex = null;
  state.activeItemId = null;

  if (state.mode === "stitch") {
    updateStitchView();
  } else {
    renderResults();
    requestDraw();
  }

  refreshControls();
}

function undoStep() {
  setStatus(undo() ? "已復原上一步。" : "沒有可以復原的操作。");
}

function redoStep() {
  setStatus(redo() ? "已重做。" : "沒有可以重做的操作。");
}

dom.undoButton.addEventListener("click", undoStep);
dom.redoButton.addEventListener("click", redoStep);

// 每次操作（滑鼠放開、勾選、按下按鈕）結束後記錄一次狀態；與上一筆相同時不會重複記錄。
for (const type of ["pointerup", "change", "click"]) {
  document.addEventListener(type, () => setTimeout(recordHistory, 0));
}

// ---- 鍵盤操作 ----

document.addEventListener("keydown", (event) => {
  if (!state.loaded || dom.mergeDialog.open) return;

  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  // Ctrl＋Z 復原；Ctrl＋Y 或 Ctrl＋Shift＋Z 重做。
  if (ctrl && key === "z" && !event.shiftKey) {
    event.preventDefault();
    undoStep();
    return;
  }

  if (ctrl && (key === "y" || (key === "z" && event.shiftKey))) {
    event.preventDefault();
    redoStep();
    return;
  }

  // Esc：取消新增移除框模式、手動選取，以及目前點選的框。
  if (event.key === "Escape") {
    event.preventDefault();
    cancelCurrent();
    return;
  }

  // Delete／Backspace：刪除目前點選的自訂移除框。
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();

    if (state.mode === "stitch" && deleteActiveCut()) {
      setTimeout(recordHistory, 0);
      return;
    }

    setStatus(state.mode === "stitch"
      ? "請先在預覽區點選要刪除的自訂移除框（紫色），再按 Delete。"
      : "Delete 用於刪除長條截圖中的自訂移除框。");
  }
});

function cancelCurrent() {
  const messages = [];

  if (state.addCutMode) {
    state.addCutMode = false;
    updateAddCutButton();
    messages.push("已取消新增移除框");
  }

  if (state.selection) {
    state.selection = null;
    state.startPoint = null;
    state.isDragging = false;
    messages.push("已取消手動選取");
  }

  if (state.activeItemId != null || state.activeCutIndex != null) {
    state.activeItemId = null;
    state.activeCutIndex = null;
    messages.push("已取消點選");
  }

  requestDraw();
  setStatus(messages.length > 0 ? `${messages.join("、")}。` : "目前沒有可以取消的操作。");
  setTimeout(recordHistory, 0);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  // 在設定頁修改輸出格式時，合併長圖的高度上限也會跟著改變。
  if (changes[STORAGE_KEYS.downloadSettings]) {
    state.settings = {
      ...DEFAULT_DOWNLOAD_SETTINGS,
      ...(changes[STORAGE_KEYS.downloadSettings].newValue || {})
    };
    refreshControls();
  }

  // 繼續截圖時，背景程式的進度文字顯示在狀態列。
  const text = changes[STORAGE_KEYS.progress]?.newValue?.text;

  if (state.busy && text) {
    setStatus(text);
  }
});

window.addEventListener("pagehide", revokePreviewUrls);

setOverlayDrawer(drawOverlay);
initSingleMode(refreshControls);
initStitchMode(refreshControls);
initInteraction();
initZoom();
initHistory(afterRestore);

getDownloadSettings()
  .catch(() => ({ ...DEFAULT_DOWNLOAD_SETTINGS }))
  .then((settings) => {
    state.settings = settings;
    return load();
  });
