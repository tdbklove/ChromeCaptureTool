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

  resizeOverlay();
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
