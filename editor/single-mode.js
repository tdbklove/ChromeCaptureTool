// 單張截圖：偵測框的繪製與調整、結果清單、批次下載。

import { clamp } from "../lib/stitch-plan.js";
import { pxPerCss, requestDraw } from "./canvas.js";
import { dom, notify, setStatus } from "./dom.js";
import {
  buttonRow,
  createCopyButton,
  downloadItems,
  makeThumbnail,
  reportDownload,
  revokePreviewUrls,
  runDownload
} from "./output.js";
import { state } from "./state.js";

export const DETECTED_COLOR = "#00a86b";
const UNSELECTED_COLOR = "#9ca3af";

// 控制點的觸發範圍（CSS 像素）與框的最小尺寸（截圖像素）。
export const HANDLE_CSS_PX = 14;
const EDIT_MIN_PX = 4;

// 只保留四邊的控制點：拖曳邊即可增減範圍。
const HANDLE_NAMES = ["n", "e", "s", "w"];

export const HANDLE_CURSORS = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize"
};

const KIND_LABELS = {
  image: "圖片",
  video: "影片",
  canvas: "畫布",
  svg: "向量圖",
  background: "背景圖"
};

function itemName(item) {
  if (item.kind === "page") {
    return `第 ${item.id} 頁`;
  }

  return `${KIND_LABELS[item.kind] || "圖片"} ${item.id}`;
}

function itemLabel(item) {
  const prefix = item.kind === "page" ? "page" : "img";
  return `${prefix}${String(item.id).padStart(2, "0")}`;
}

// ---- 繪製 ----

export function drawDetectionBoxes(ctx) {
  const lineWidth = Math.max(2, Math.round(1.5 * pxPerCss()));
  const fontSize = Math.max(12, Math.round(13 * pxPerCss()));

  for (const item of state.detectedImages) {
    const color = item.selected ? DETECTED_COLOR : UNSELECTED_COLOR;

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(item.x, item.y, item.width, item.height);

    // 編號加上底色，在深色圖片上也看得清楚。
    const label = String(item.id);
    ctx.font = `600 ${fontSize}px sans-serif`;
    const textWidth = ctx.measureText(label).width;
    const padding = Math.round(fontSize * 0.3);

    ctx.fillStyle = color;
    ctx.fillRect(item.x, item.y, textWidth + padding * 2, fontSize + padding * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, item.x + padding, item.y + padding + fontSize * 0.85);
  }
}

// 在框的四條邊中央畫出粗色拉條，顯示可以拖曳的位置。
// 尺寸以 CSS 像素計算，不論截圖解析度多高都能清楚看見、容易點到。
export function drawEditHandles(ctx, rect, color) {
  const ratio = pxPerCss();
  const thickness = Math.max(6, Math.round(8 * ratio));
  const maxBarLength = Math.max(24, Math.round(60 * ratio));

  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  const horizontalLength = Math.min(maxBarLength, Math.max(thickness * 2, rect.width * 0.5));
  const verticalLength = Math.min(maxBarLength, Math.max(thickness * 2, rect.height * 0.5));

  const bars = {
    n: { x: centerX - horizontalLength / 2, y: rect.y - thickness / 2, w: horizontalLength, h: thickness },
    s: { x: centerX - horizontalLength / 2, y: bottom - thickness / 2, w: horizontalLength, h: thickness },
    w: { x: rect.x - thickness / 2, y: centerY - verticalLength / 2, w: thickness, h: verticalLength },
    e: { x: right - thickness / 2, y: centerY - verticalLength / 2, w: thickness, h: verticalLength }
  };

  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(2, Math.round(2 * ratio));

  for (const name of HANDLE_NAMES) {
    const bar = bars[name];
    ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    ctx.strokeRect(bar.x, bar.y, bar.w, bar.h);
  }

  ctx.restore();
}

export function drawActiveItem(ctx) {
  const active = state.detectedImages.find((item) => item.id === state.activeItemId);

  if (!active) return;

  ctx.strokeStyle = DETECTED_COLOR;
  ctx.lineWidth = Math.max(3, Math.round(3 * pxPerCss()));
  ctx.strokeRect(active.x, active.y, active.width, active.height);

  drawEditHandles(ctx, active, DETECTED_COLOR);
}

// ---- 拖曳調整框 ----

// 判斷滑鼠是否在某條邊線上（沿著整條邊都有效，不只限於中點）。
// 角落同時靠近兩條邊時，選距離較近的那一條。
function hitTestHandle(rect, point, threshold) {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  const withinX = point.x >= rect.x - threshold && point.x <= right + threshold;
  const withinY = point.y >= rect.y - threshold && point.y <= bottom + threshold;

  const candidates = [];

  if (withinX && Math.abs(point.y - rect.y) <= threshold) {
    candidates.push({ name: "n", distance: Math.abs(point.y - rect.y) });
  }

  if (withinY && Math.abs(point.x - right) <= threshold) {
    candidates.push({ name: "e", distance: Math.abs(point.x - right) });
  }

  if (withinX && Math.abs(point.y - bottom) <= threshold) {
    candidates.push({ name: "s", distance: Math.abs(point.y - bottom) });
  }

  if (withinY && Math.abs(point.x - rect.x) <= threshold) {
    candidates.push({ name: "w", distance: Math.abs(point.x - rect.x) });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0].name;
}

function isInsideRect(rect, point) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

// 可以拖曳邊線的框：手動選取範圍，以及目前被點選的偵測框。
function editableTargets() {
  const targets = [];

  if (state.selection && state.selection.width > 0 && state.selection.height > 0) {
    targets.push({ kind: "selection", rect: state.selection });
  }

  const active = state.detectedImages.find((item) => item.id === state.activeItemId);

  if (active) {
    targets.push({ kind: "detected", item: active, rect: active });
  }

  return targets;
}

export function hitTestEditable(point) {
  const threshold = HANDLE_CSS_PX * pxPerCss();

  for (const target of editableTargets()) {
    const handle = hitTestHandle(target.rect, point, threshold);

    if (handle) {
      return { ...target, mode: handle };
    }
  }

  return null;
}

// 找出包含該點的偵測框（面積較小者優先），用於點選時選取該框。
export function findBoxAt(point) {
  let best = null;

  for (const item of state.detectedImages) {
    if (!isInsideRect(item, point)) continue;

    const area = item.width * item.height;

    if (!best || area < best.area) {
      best = { item, area };
    }
  }

  return best ? best.item : null;
}

export function beginEdit(hit, point) {
  if (hit.kind === "detected") {
    state.activeItemId = hit.item.id;
  }

  state.editDrag = {
    kind: hit.kind,
    item: hit.item || null,
    mode: hit.mode,
    startPoint: point,
    origin: {
      x: hit.rect.x,
      y: hit.rect.y,
      width: hit.rect.width,
      height: hit.rect.height
    },
    moved: false
  };

  requestDraw();
}

// 依拖曳距離計算新的範圍。控制點決定拖曳哪一條邊。
export function applyEdit(point) {
  const drag = state.editDrag;
  const origin = drag.origin;
  const dx = point.x - drag.startPoint.x;
  const dy = point.y - drag.startPoint.y;

  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;

  if (drag.mode === "w") {
    left = clamp(origin.x + dx, 0, right - EDIT_MIN_PX);
  } else if (drag.mode === "e") {
    right = clamp(right + dx, left + EDIT_MIN_PX, state.width);
  } else if (drag.mode === "n") {
    top = clamp(origin.y + dy, 0, bottom - EDIT_MIN_PX);
  } else if (drag.mode === "s") {
    bottom = clamp(bottom + dy, top + EDIT_MIN_PX, state.height);
  }

  const rect = {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top)
  };

  if (drag.item) {
    Object.assign(drag.item, rect);
  } else {
    state.selection = rect;
  }

  if (Math.abs(dx) + Math.abs(dy) > 1) {
    drag.moved = true;
  }

  setStatus(`調整中：${rect.width} × ${rect.height}px`);
  requestDraw();
}

export function finishEdit() {
  const drag = state.editDrag;
  state.editDrag = null;

  if (drag.kind === "detected") {
    const item = drag.item;

    if (drag.moved) {
      // 偵測框的預覽與尺寸需要更新，重新產生卡片。
      renderResults();
      setStatus(`已調整${itemName(item)} 的範圍（${item.width} × ${item.height}px）。`);
    } else {
      setStatus(`已選取${itemName(item)}。拖曳邊線可調整範圍。`);
    }
  } else if (drag.moved) {
    setStatus(`已調整手動選取範圍（${state.selection.width} × ${state.selection.height}px）。`);
  }

  requestDraw();
}

// ---- 結果清單 ----

export async function renderResults() {
  const generation = ++state.renderGeneration;

  revokePreviewUrls();
  dom.resultsContainer.replaceChildren();

  if (state.detectedImages.length === 0) {
    const message = document.createElement("p");
    message.textContent = "沒有找到符合條件的圖片。你仍然可以使用手動框選。";
    dom.resultsContainer.appendChild(message);
    return;
  }

  for (const item of state.detectedImages) {
    const card = document.createElement("article");
    card.className = "resultCard";

    const heading = document.createElement("h3");
    heading.textContent = item.alt ? `${itemName(item)}：${item.alt}` : itemName(item);

    const preview = document.createElement("img");
    preview.alt = `${itemName(item)}的裁切預覽`;

    const dimensions = document.createElement("p");
    dimensions.textContent = `裁切尺寸：${item.width} × ${item.height}px`;

    const selectLabel = document.createElement("label");
    selectLabel.className = "selectRow";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.selected;

    checkbox.addEventListener("change", () => {
      item.selected = checkbox.checked;
      requestDraw();
      refreshSingleControls();
    });

    selectLabel.append(checkbox, " 加入批次下載");

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.textContent = "下載這張圖片";

    downloadButton.addEventListener("click", async () => {
      downloadButton.disabled = true;
      downloadButton.textContent = "正在儲存……";

      const result = await runDownload(() =>
        downloadItems([{ label: itemLabel(item), rects: item }]));

      downloadButton.disabled = false;
      downloadButton.textContent = "下載這張圖片";

      if (result) {
        reportDownload(result, "張圖片", { button: downloadButton, buttonText: "下載這張圖片" });
      }
    });

    card.append(
      heading,
      preview,
      dimensions,
      selectLabel,
      buttonRow(downloadButton, createCopyButton(() => ({ ...item })))
    );
    dom.resultsContainer.appendChild(card);

    try {
      const blob = await makeThumbnail(item);

      if (generation !== state.renderGeneration) return;

      const url = URL.createObjectURL(blob);
      state.previewUrls.push(url);
      preview.src = url;
    } catch (error) {
      if (generation !== state.renderGeneration) return;

      console.error("預覽產生失敗：", error);
      preview.alt = "無法產生預覽";
    }
  }
}

function setAllSelected(value) {
  state.detectedImages.forEach((item) => {
    item.selected = value;
  });

  dom.resultsContainer
    .querySelectorAll(".resultCard input[type='checkbox']")
    .forEach((checkbox) => {
      checkbox.checked = value;
    });

  requestDraw();
  refreshSingleControls();
}

export function refreshSingleControls() {
  const selectedCount = state.detectedImages.filter((item) => item.selected).length;
  const hasImages = state.detectedImages.length > 0;

  dom.downloadSelectedButton.textContent = `下載選取的圖片（${selectedCount}）`;
  dom.downloadSelectedButton.disabled = state.busy || !state.loaded || selectedCount === 0;

  dom.selectAllButton.disabled = state.busy || !hasImages;
  dom.deselectAllButton.disabled = state.busy || !hasImages;
}

export function resetDetections() {
  state.detectedImages.forEach((item) => {
    Object.assign(item, item.original);
  });

  state.activeItemId = null;
  state.editDrag = null;

  renderResults();
}

export function initSingleMode(refreshControls) {
  dom.selectAllButton.addEventListener("click", () => setAllSelected(true));
  dom.deselectAllButton.addEventListener("click", () => setAllSelected(false));

  dom.downloadSelectedButton.addEventListener("click", async () => {
    const targets = state.detectedImages.filter((item) => item.selected);

    if (targets.length === 0) {
      notify("請先勾選至少一張圖片，再按下載。", "error");
      return;
    }

    state.busy = true;
    refreshControls();

    try {
      const result = await downloadItems(
        targets.map((item) => ({ label: itemLabel(item), rects: item })),
        (index, total) => setStatus(`正在儲存第 ${index + 1} ／ ${total} 張……`)
      );

      state.busy = false;
      refreshControls();
      reportDownload(result, "張圖片", { button: dom.downloadSelectedButton, buttonText: refreshControls });
    } catch (error) {
      state.busy = false;
      refreshControls();
      notify(error.message || "下載失敗，請重試。", "error");
    }
  });
}
