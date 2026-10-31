// 預覽區：底層是截圖本身（只畫一次），上層是透明的標示圖層（偵測框、移除區域、選取框）。
//
// 標示圖層的像素尺寸跟著「畫面上顯示的大小」，而不是截圖原始大小，
// 長圖也只需要重畫一張小很多的圖層；重畫時以 requestAnimationFrame 合併，每個畫面最多畫一次。

import { dom } from "./dom.js";
import { state } from "./state.js";

// Chrome 的 Canvas 單邊上限約 32767 像素，總面積也有上限。
const MAX_OVERLAY_SIDE = 32000;
const MAX_OVERLAY_AREA = 120_000_000;

const overlayCtx = dom.overlay.getContext("2d");

let drawOverlay = () => {};
let frameRequested = false;

export function setOverlayDrawer(drawer) {
  drawOverlay = drawer;
}

// 以傳入的 Canvas 作為截圖來源，直接放進預覽區（不再複製一份）。
export function setSource(sourceCanvas) {
  const previous = dom.stage.querySelector("#canvas");

  sourceCanvas.id = "canvas";

  if (previous) {
    previous.replaceWith(sourceCanvas);
  } else {
    dom.stage.prepend(sourceCanvas);
  }

  state.source = sourceCanvas;
  state.width = sourceCanvas.width;
  state.height = sourceCanvas.height;

  applyZoom();
}

function resizeOverlay() {
  if (!state.source) return;

  const rect = state.source.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) return;

  let scale = window.devicePixelRatio || 1;

  scale = Math.min(
    scale,
    MAX_OVERLAY_SIDE / rect.width,
    MAX_OVERLAY_SIDE / rect.height,
    Math.sqrt(MAX_OVERLAY_AREA / (rect.width * rect.height))
  );

  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));

  if (dom.overlay.width !== width || dom.overlay.height !== height) {
    dom.overlay.width = width;
    dom.overlay.height = height;
  }

  drawNow();
}

new ResizeObserver(resizeOverlay).observe(dom.stage);

export function drawNow() {
  frameRequested = false;

  if (!state.loaded || !state.width || !state.height) return;

  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, dom.overlay.width, dom.overlay.height);

  // 之後的繪製都使用截圖像素座標。
  overlayCtx.setTransform(
    dom.overlay.width / state.width,
    0,
    0,
    dom.overlay.height / state.height,
    0,
    0
  );

  drawOverlay(overlayCtx);
}

// 要求重畫；同一個畫面內的多次要求只會畫一次。
export function requestDraw() {
  if (frameRequested) return;

  frameRequested = true;
  requestAnimationFrame(drawNow);
}

// 截圖像素 ÷ 畫面上的 CSS 像素。用於讓控制點、線條在任何縮放比例下看起來大小一致。
export function pxPerCss() {
  const rect = dom.overlay.getBoundingClientRect();
  return rect.height > 0 ? state.height / rect.height : 1;
}

// 將滑鼠位置換算成截圖像素座標。
export function getCanvasPoint(event) {
  const rect = dom.overlay.getBoundingClientRect();

  const x = ((event.clientX - rect.left) * state.width) / rect.width;
  const y = ((event.clientY - rect.top) * state.height) / rect.height;

  return {
    x: Math.max(0, Math.min(state.width, x)),
    y: Math.max(0, Math.min(state.height, y))
  };
}

// 目前在畫面上看得到的截圖範圍（截圖像素），用於只在可見處畫控制點。
export function visibleRange() {
  const rect = dom.overlay.getBoundingClientRect();
  const viewport = dom.stage.parentElement.getBoundingClientRect();
  const ratio = rect.height > 0 ? state.height / rect.height : 1;

  const top = (Math.max(viewport.top, rect.top) - rect.top) * ratio;
  const bottom = (Math.min(viewport.bottom, window.innerHeight, rect.bottom) - rect.top) * ratio;

  return {
    top: Math.max(0, Math.min(state.height, top)),
    bottom: Math.max(0, Math.min(state.height, Math.max(top, bottom)))
  };
}

// 預覽區捲動時，控制點要跟著畫在看得到的位置。
dom.stage.parentElement.addEventListener("scroll", requestDraw, { passive: true });
window.addEventListener("scroll", requestDraw, { passive: true });

// ---- 預覽縮放 ----

const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];

// 「實際大小」（100%）時的 CSS 寬度：截圖的一個像素對應螢幕上的一個像素。
function actualCssWidth() {
  return state.width / (window.devicePixelRatio || 1);
}

function currentZoom() {
  if (state.zoom != null) return state.zoom;

  const width = state.source ? state.source.getBoundingClientRect().width : 0;
  return width > 0 ? width / actualCssWidth() : 1;
}

export function updateZoomControls() {
  const zoom = currentZoom();
  const percent = `${Math.round(zoom * 100)}%`;

  dom.zoomLabel.textContent = state.zoom == null ? `符合寬度（${percent}）` : percent;
  dom.zoomOutButton.disabled = !state.loaded || zoom <= ZOOM_STEPS[0] + 0.001;
  dom.zoomInButton.disabled = !state.loaded || zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001;
  dom.zoomFitButton.disabled = !state.loaded || state.zoom == null;
  dom.zoomActualButton.disabled = !state.loaded || state.zoom === 1;
}

// 依 state.zoom 設定截圖的顯示大小。null 表示符合預覽區寬度。
export function applyZoom() {
  if (!state.source) return;

  if (state.zoom == null) {
    state.source.style.width = "";
    state.source.style.maxWidth = "100%";
    dom.stage.style.maxWidth = "100%";
  } else {
    state.source.style.width = `${actualCssWidth() * state.zoom}px`;
    state.source.style.maxWidth = "none";
    dom.stage.style.maxWidth = "none";
  }

  resizeOverlay();
  updateZoomControls();
}

// 設定縮放比例。anchor 為滑鼠位置時，縮放後該位置下的截圖內容維持在滑鼠下方。
export function setZoom(zoom, anchor) {
  if (!state.loaded) return;

  const container = dom.stage.parentElement;
  const before = anchor ? getCanvasPoint(anchor) : null;

  state.zoom = zoom == null
    ? null
    : Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], zoom));

  applyZoom();

  if (before) {
    const rect = dom.overlay.getBoundingClientRect();
    const clientX = rect.left + (before.x * rect.width) / state.width;
    const clientY = rect.top + (before.y * rect.height) / state.height;

    container.scrollLeft += clientX - anchor.clientX;
    container.scrollTop += clientY - anchor.clientY;
  }
}

function stepZoom(direction, anchor) {
  const zoom = currentZoom();

  const next = direction > 0
    ? ZOOM_STEPS.find((step) => step > zoom + 0.001)
    : [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001);

  if (next != null) {
    setZoom(next, anchor);
  }
}

export function initZoom() {
  dom.zoomInButton.addEventListener("click", () => stepZoom(1));
  dom.zoomOutButton.addEventListener("click", () => stepZoom(-1));
  dom.zoomFitButton.addEventListener("click", () => setZoom(null));
  dom.zoomActualButton.addEventListener("click", () => setZoom(1));

  // 在預覽區按住 Ctrl 並滾動滑鼠滾輪：以滑鼠位置為中心縮放。
  dom.stage.parentElement.addEventListener("wheel", (event) => {
    if (!event.ctrlKey || !state.loaded) return;

    event.preventDefault();
    stepZoom(event.deltaY < 0 ? 1 : -1, event);
  }, { passive: false });

  // 符合寬度時，視窗大小改變會影響實際比例，需要更新顯示的百分比。
  window.addEventListener("resize", updateZoomControls);

  updateZoomControls();
}
