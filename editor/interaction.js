// 預覽區的滑鼠操作：手動框選、拖曳偵測框、拖曳與切換移除區域。

import { getCanvasPoint, requestDraw } from "./canvas.js";
import { dom, setStatus } from "./dom.js";
import {
  applyEdit,
  beginEdit,
  finishEdit,
  findBoxAt,
  HANDLE_CURSORS,
  hitTestEditable
} from "./single-mode.js";
import { state } from "./state.js";
import {
  applyCutDrag,
  applySideDrag,
  applyTrimDrag,
  CUT_WARNING_TEXT,
  hitTestCut,
  hitTestSide,
  hitTestTrim,
  MIN_CUT_SIZE,
  recomputeStitch,
  sideAt,
  toggleGap,
  toggleSide,
  toggleTrim,
  trimAt,
  updateAddCutButton,
  updateStitchView
} from "./stitch-mode.js";

// 按下與放開的距離小於此值（CSS 像素）視為點擊。
const CLICK_TOLERANCE = 5;

function makeSelection(start, end) {
  return {
    x: Math.round(Math.min(start.x, end.x)),
    y: Math.round(Math.min(start.y, end.y)),
    width: Math.round(Math.abs(end.x - start.x)),
    height: Math.round(Math.abs(end.y - start.y))
  };
}

function onPointerDown(event) {
  if (!state.loaded) return;

  event.preventDefault();
  dom.overlay.setPointerCapture(event.pointerId);

  state.pointerDownClient = { x: event.clientX, y: event.clientY };
  const point = getCanvasPoint(event);

  if (state.mode === "stitch") {
    // 點選自訂移除框以外的地方時，取消點選（下方點到自訂移除框時會重新設定）。
    const previousActiveCut = state.activeCutIndex;
    state.activeCutIndex = null;

    // 新增移除框模式：拖曳出一個新的範圍。
    if (state.addCutMode) {
      state.customCuts.push({ startY: point.y, endY: point.y, enabled: true });
      state.activeCutIndex = state.customCuts.length - 1;

      state.dragCut = {
        adding: true,
        hit: { kind: "custom", index: state.customCuts.length - 1, mode: "add" },
        startPointY: point.y,
        origin: { startY: point.y, endY: point.y }
      };
      return;
    }

    // 按在左右空白的邊線上：左右調整。
    const sideHit = hitTestSide(point);

    if (sideHit) {
      state.dragCut = {
        adding: false,
        hit: sideHit,
        startPoint: point,
        origin: { ...state.sides[sideHit.side] }
      };
      return;
    }

    // 按在上下裁切的邊線上：上下調整（沒有裁切時，邊線就在長圖的最上緣與最下緣）。
    const trimHit = hitTestTrim(point);

    if (trimHit) {
      state.dragCut = {
        adding: false,
        hit: trimHit,
        startPoint: point,
        origin: { ...state.trims[trimHit.edge] }
      };
      return;
    }

    // 按在既有移除框的邊緣或內部：調整或移動。
    const hit = hitTestCut(point);

    if (hit) {
      if (hit.kind === "custom") {
        state.activeCutIndex = hit.index;
        hit.wasActive = previousActiveCut === hit.index;
      }

      state.dragCut = {
        adding: false,
        hit,
        startPointY: point.y,
        origin: { startY: hit.startY, endY: hit.endY }
      };
      return;
    }
  } else {
    // 單張模式：點到邊線時開始拉動邊框；其他位置則選取所在的框，並可開始新的手動選取。
    const hit = hitTestEditable(point);

    if (hit) {
      beginEdit(hit, point);
      return;
    }

    const inside = findBoxAt(point);
    state.activeItemId = inside ? inside.id : null;
  }

  // 其他位置：手動框選。
  state.startPoint = point;
  state.selection = { x: point.x, y: point.y, width: 0, height: 0 };
  state.isDragging = true;
  requestDraw();
}

function updateHoverCursor(point) {
  let cursor = "crosshair";

  if (state.mode === "single") {
    const hit = hitTestEditable(point);

    if (hit) {
      cursor = HANDLE_CURSORS[hit.mode];
    }
  } else if (!state.addCutMode) {
    if (hitTestSide(point)) {
      cursor = "ew-resize";
    } else if (hitTestTrim(point)) {
      cursor = "ns-resize";
    } else {
      const hit = hitTestCut(point);

      if (hit) {
        cursor = hit.mode === "move" ? "move" : "ns-resize";
      } else {
        cursor = "default";
      }
    }
  }

  dom.overlay.style.cursor = cursor;
}

function onPointerMove(event) {
  const point = getCanvasPoint(event);

  if (state.editDrag) {
    applyEdit(point);
    return;
  }

  if (state.dragCut) {
    const drag = state.dragCut;

    if (drag.hit.kind === "side") {
      applySideDrag(point);
    } else if (drag.hit.kind === "trim") {
      applyTrimDrag(point);
    } else if (drag.adding) {
      const cut = state.customCuts[drag.hit.index];
      cut.startY = Math.round(Math.min(drag.startPointY, point.y));
      cut.endY = Math.round(Math.max(drag.startPointY, point.y));
    } else {
      applyCutDrag(point);
    }

    recomputeStitch();
    requestDraw();

    setStatus(state.stitchCutWarning
      ? `${CUT_WARNING_TEXT}，請確認。`
      : "調整移除範圍中。");
    return;
  }

  if (!state.isDragging) {
    updateHoverCursor(point);
    return;
  }

  if (!state.startPoint) return;

  state.selection = makeSelection(state.startPoint, point);
  requestDraw();

  setStatus(`手動選取：${state.selection.width} × ${state.selection.height}px`);
}

function finishCutDrag(moved, point) {
  const drag = state.dragCut;
  state.dragCut = null;

  if (drag.hit.kind === "side") {
    if (!moved) {
      // 點一下邊線：切換該側空白；沒有空白時視為點擊該位置的間隔。
      state.sides[drag.hit.side] = drag.origin;

      if (drag.origin.width > 0) {
        toggleSide(drag.hit.side);
      } else {
        const gap = state.stitchGaps.find((item) => point.y >= item.startY && point.y < item.endY);

        if (gap) {
          toggleGap(gap.id);
        } else {
          requestDraw();
        }
      }
      return;
    }

    updateStitchView();
    setStatus(`已調整左右空白：左 ${state.sides.left.width}px、右 ${state.sides.right.width}px。`);
    return;
  }

  if (drag.hit.kind === "trim") {
    if (!moved) {
      // 點一下邊線：切換該區域裁掉或保留；沒有高度時視為點擊該位置的間隔。
      state.trims[drag.hit.edge] = drag.origin;

      if (drag.origin.size > 0) {
        toggleTrim(drag.hit.edge);
      } else {
        const gap = state.stitchGaps.find((item) => point.y >= item.startY && point.y < item.endY);

        if (gap) {
          toggleGap(gap.id);
        } else {
          requestDraw();
        }
      }
      return;
    }

    updateStitchView();
    setStatus(
      `已調整上下裁切：頂部 ${state.trims.top.removed ? state.trims.top.size : 0}px、` +
      `底部 ${state.trims.bottom.removed ? state.trims.bottom.size : 0}px，` +
      `長圖高度 ${state.height - (state.trims.top.removed ? state.trims.top.size : 0) - (state.trims.bottom.removed ? state.trims.bottom.size : 0)}px（尚未扣除其他移除區域）。`
    );
    return;
  }

  if (drag.adding) {
    const index = drag.hit.index;
    const cut = state.customCuts[index];
    const tooSmall = !cut || cut.endY - cut.startY < MIN_CUT_SIZE;

    if (tooSmall) {
      state.customCuts.splice(index, 1);
      state.activeCutIndex = null;
    }

    state.addCutMode = false;
    updateAddCutButton();
    updateStitchView();

    setStatus(tooSmall ? "移除框太小，已取消。" : "已新增移除框。");
    return;
  }

  // 沒有移動：點擊間隔切換移除，點擊自訂框則切換啟用。
  if (!moved) {
    const side = sideAt(point);
    const edge = trimAt(point);

    if (side) {
      toggleSide(side);
    } else if (edge) {
      toggleTrim(edge);
    } else if (drag.hit.kind === "gap") {
      toggleGap(drag.hit.id);
    } else if (!drag.hit.wasActive) {
      // 第一次點擊只點選，方便按 Delete 刪除；再點一次才切換啟用／停用。
      requestDraw();
      setStatus(
        `已點選自訂 ${drag.hit.index + 1}。按 Delete 可刪除，再點一次可切換啟用／停用，按 Esc 取消點選。`
      );
    } else {
      const cut = state.customCuts[drag.hit.index];
      cut.enabled = !(cut.enabled !== false);
      updateStitchView();

      setStatus(cut.enabled
        ? "已啟用自訂移除框。"
        : "已停用自訂移除框（仍保留在清單中）。");
    }
    return;
  }

  updateStitchView();

  setStatus(state.stitchCutWarning
    ? `已調整移除範圍。注意：${CUT_WARNING_TEXT}，請確認後再下載。`
    : "已調整移除範圍。");
}

function onPointerUp(event) {
  const moved = state.pointerDownClient
    ? Math.hypot(
        event.clientX - state.pointerDownClient.x,
        event.clientY - state.pointerDownClient.y
      ) >= CLICK_TOLERANCE
    : false;

  state.pointerDownClient = null;
  const point = getCanvasPoint(event);

  if (state.editDrag) {
    finishEdit();
    return;
  }

  if (state.dragCut) {
    finishCutDrag(moved, point);
    return;
  }

  if (!state.isDragging) return;

  state.isDragging = false;

  // 長條模式中單純點擊：切換所在位置的側邊空白、上下裁切或間隔。
  if (state.mode === "stitch" && !moved) {
    state.selection = null;
    state.startPoint = null;

    const side = sideAt(point);
    const edge = trimAt(point);
    const gap = state.stitchGaps.find((item) => point.y >= item.startY && point.y < item.endY);

    if (side) {
      toggleSide(side);
    } else if (edge) {
      toggleTrim(edge);
    } else if (gap) {
      toggleGap(gap.id);
    } else {
      requestDraw();
      setStatus("點擊的位置不在可移除的區域內。");
    }

    return;
  }

  state.selection = makeSelection(state.startPoint, point);
  state.startPoint = null;

  if (state.selection.width < 2 || state.selection.height < 2) {
    state.selection = null;
    requestDraw();

    const active = state.detectedImages.find((item) => item.id === state.activeItemId);

    setStatus(active
      ? `已選取圖片 ${active.id}。拖曳邊線可調整範圍。`
      : "選取範圍太小，請重新拖曳。");
    return;
  }

  requestDraw();
  setStatus(`已手動選取 ${state.selection.width} × ${state.selection.height}px。`);
}

function onPointerCancel() {
  state.editDrag = null;
  state.dragCut = null;
  state.isDragging = false;
  state.startPoint = null;
  state.pointerDownClient = null;
  state.selection = null;

  updateStitchViewIfNeeded();
}

function updateStitchViewIfNeeded() {
  if (state.mode === "stitch" && state.stitchLayout) {
    updateStitchView();
  } else {
    requestDraw();
  }
}

export function initInteraction() {
  dom.overlay.addEventListener("pointerdown", onPointerDown);
  dom.overlay.addEventListener("pointermove", onPointerMove);
  dom.overlay.addEventListener("pointerup", onPointerUp);
  dom.overlay.addEventListener("pointercancel", onPointerCancel);
}
