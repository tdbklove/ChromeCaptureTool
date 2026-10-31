// 長條截圖：拼接、移除區域（上下間隔、左右空白、自訂範圍）、分段與下載。

import { MESSAGES } from "../lib/constants.js";
import { getFrames } from "../lib/db.js";
import { outputFormat } from "../lib/settings.js";
import {
  chooseBatchEnd,
  clamp,
  computeStitchGroups,
  computeStitchPlan,
  detectSideMargins,
  splitIntoParts
} from "../lib/stitch-plan.js";
import { pxPerCss, requestDraw, visibleRange } from "./canvas.js";
import { dom, notify, setStatus } from "./dom.js";
import {
  buttonRow,
  createCopyButton,
  downloadItems,
  makeThumbnail,
  mergeHeightLimit,
  reportDownload,
  revokePreviewUrls,
  runDownload,
  splitByHeight
} from "./output.js";
import { state } from "./state.js";

// 單張長圖的最大高度（裝置像素）。超過時會在圖片間隔處切開。
const MAX_PART_PX = 10000;

// 拼接後的尺寸上限（Canvas 的限制）。
const MAX_STITCH_HEIGHT = 30000;
const MAX_STITCH_AREA = 120_000_000;

const MIN_CUT_PX = 4;
const HANDLE_CSS_PX = 14;

const CUT_COLOR = "rgba(220, 38, 38, 0.35)";
const CUSTOM_CUT_COLOR = "rgba(109, 40, 217, 0.35)";
const GAP_COLOR = "#d97706";
const GROUP_COLOR = "#2563eb";
const PART_COLOR = "#7c3aed";
const SIDE_COLOR = "#b91c1c";

export const CUT_WARNING_TEXT = "此移除範圍已切入圖片";

const SIDE_LABELS = { left: "左側空白", right: "右側空白" };

// ---- 拼接 ----

// 將一批截圖依捲動位置拼成一張長圖。
// 只取每段截圖中「捲動目標」的範圍（去掉捲軸，以及頁面內捲動時區塊外的固定版面），
// 並在本批的結束位置（chooseBatchEnd）截止，下一批從接續位置開始。
export async function buildStitchedCanvas(jobId, reachedBottom) {
  const frames = await getFrames(jobId);

  if (frames.length === 0) {
    throw new Error("找不到長圖的截圖片段。這個長截圖可能已經結束或被新的長截圖取代，請重新擷取。");
  }

  const first = frames[0];
  const firstBitmap = await createImageBitmap(first.blob);
  const fullWidth = firstBitmap.width;
  const fullHeight = firstBitmap.height;
  firstBitmap.close();

  const pxPerCssX = first.innerWidth ? fullWidth / first.innerWidth : 1;
  const pxPerCssY = first.innerHeight ? fullHeight / first.innerHeight : 1;
  const clip = first.clip;

  const cropX = clamp(Math.round(clip.left * pxPerCssX), 0, fullWidth - 1);
  const cropY = clamp(Math.round(clip.top * pxPerCssY), 0, fullHeight - 1);
  const cropWidth = clamp(Math.round(clip.width * pxPerCssX), 1, fullWidth - cropX);
  const cropHeight = clamp(Math.round(clip.height * pxPerCssY), 1, fullHeight - cropY);

  const scale = cropHeight / clip.height;
  const plan = computeStitchPlan(frames, cropHeight, scale, clip.height);

  const layouts = frames.map((frame) => frame.layout || { images: [], separators: [] });
  const originScrollY = first.scrollTop;
  const last = frames[frames.length - 1];

  const end = chooseBatchEnd({
    layouts,
    originScrollY,
    capturedBottomPage: last.scrollTop + clip.height,
    reachedBottom
  });

  const outputHeight = clamp(
    Math.round((end.endPage - originScrollY) * scale),
    1,
    plan.totalHeight
  );

  if (outputHeight > MAX_STITCH_HEIGHT || outputHeight * cropWidth > MAX_STITCH_AREA) {
    throw new Error("本批長圖尺寸過大，無法建立。請縮小瀏覽器視窗後重新擷取。");
  }

  const output = document.createElement("canvas");
  output.width = cropWidth;
  output.height = outputHeight;

  const ctx = output.getContext("2d");

  if (!ctx) {
    throw new Error("無法建立長圖畫布。");
  }

  // 一次只解碼一段截圖，避免同時佔用大量記憶體。
  let destinationY = 0;

  for (const segment of plan.segments) {
    if (destinationY >= outputHeight) break;

    const bitmap = await createImageBitmap(frames[segment.frameIndex].blob);

    try {
      if (bitmap.width !== fullWidth || bitmap.height !== fullHeight) {
        throw new Error("截圖尺寸不一致（擷取途中可能調整了視窗大小），無法安全拼接。");
      }

      const height = Math.min(segment.height, outputHeight - destinationY);

      ctx.drawImage(
        bitmap,
        cropX,
        cropY + segment.sourceY,
        cropWidth,
        height,
        0,
        destinationY,
        cropWidth,
        height
      );

      destinationY += height;
    } finally {
      bitmap.close();
    }
  }

  return {
    canvas: output,
    frameCount: frames.length,
    gapCount: plan.gapCount,
    layouts,
    originScrollY,
    scale,
    pxPerCssX: cropWidth / clip.width,
    forcedEnd: end.forced,
    nextStartY: reachedBottom ? null : end.nextStartPage
  };
}

// 偵測左右兩側的空白。長圖先縮小高度再讀取像素（空白欄縮小後仍是空白）。
export function detectSides(source) {
  const sampleHeight = Math.min(source.height, 3000);
  const sample = document.createElement("canvas");
  sample.width = source.width;
  sample.height = sampleHeight;

  const ctx = sample.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, source.width, sampleHeight);

  const { data } = ctx.getImageData(0, 0, source.width, sampleHeight);
  return detectSideMargins(data, source.width, sampleHeight);
}

// 自動偵測的空白不能切到偵測到的圖片：依圖片的左右邊界縮小。
export function protectImages(detected, pxPerCssX) {
  const pageTop = state.stitchLayout.originScrollY;
  const pageBottom = pageTop + state.height / state.stitchLayout.scale;

  const boxes = state.stitchLayout.layouts
    .flatMap((layout) => layout.images || [])
    .filter((box) => box.bottom > pageTop && box.top < pageBottom && box.right > box.left);

  if (boxes.length === 0) {
    return detected;
  }

  const minLeft = Math.min(...boxes.map((box) => box.left)) * pxPerCssX;
  const maxRight = Math.max(...boxes.map((box) => box.right)) * pxPerCssX;

  return {
    left: clamp(Math.min(detected.left, Math.floor(minLeft)), 0, state.width),
    right: clamp(Math.min(detected.right, Math.floor(state.width - maxRight)), 0, state.width)
  };
}

// 偵測到的左右空白預設移除（與其他移除區域一樣預設全選）。
export function initSides(detected) {
  state.sides = {
    detected,
    left: { width: detected.left, removed: detected.left > 0 },
    right: { width: detected.right, removed: detected.right > 0 }
  };
}

function resetSides() {
  initSides(state.sides.detected);
}

// 輸出時保留的水平範圍（截圖像素）。
export function outputXRange() {
  const left = state.sides.left.removed ? state.sides.left.width : 0;
  const right = state.sides.right.removed ? state.width - state.sides.right.width : state.width;

  return { x: left, width: Math.max(1, right - left) };
}

function sideEdgeX(side) {
  return side === "left" ? state.sides.left.width : state.width - state.sides.right.width;
}

// ---- 上下裁切 ----
// 長圖最上方與最下方各有一條可拖曳的邊線，不論是否偵測到空白或廣告都可以使用，
// 方便使用者裁掉頁首、頁尾等內容，控制整張圖的高度。預設值為圖片上方與下方的空間。

// detected：{ top, bottom }，自動偵測的頂部、底部空間（截圖像素）。
export function initTrims(detected) {
  state.trims = {
    detected,
    top: { size: detected.top, removed: detected.top > 0 },
    bottom: { size: detected.bottom, removed: detected.bottom > 0 }
  };
}

function resetTrims() {
  initTrims(state.trims.detected);
}

// 自動偵測的頂部、底部空間。
export function detectedEdges() {
  return computeStitchGroups({
    ...state.stitchLayout,
    heightPx: state.height
  }).edges;
}

function activeTrims() {
  return {
    top: state.trims.top.removed ? state.trims.top.size : 0,
    bottom: state.trims.bottom.removed ? state.trims.bottom.size : 0
  };
}

function trimEdgeY(edge) {
  return edge === "top" ? state.trims.top.size : state.height - state.trims.bottom.size;
}

// 判斷滑鼠是否在上下裁切的邊線上（整條邊線都有效）。
export function hitTestTrim(point) {
  const threshold = HANDLE_CSS_PX * pxPerCss();
  let nearest = null;

  for (const edge of ["top", "bottom"]) {
    const distance = Math.abs(point.y - trimEdgeY(edge));

    if (distance <= threshold && (!nearest || distance < nearest.distance)) {
      nearest = { kind: "trim", edge, distance };
    }
  }

  return nearest;
}

// 點擊位置所在的上下裁切區域（有高度時）。
export function trimAt(point) {
  if (state.trims.top.size > 0 && point.y < state.trims.top.size) {
    return "top";
  }

  if (state.trims.bottom.size > 0 && point.y > state.height - state.trims.bottom.size) {
    return "bottom";
  }

  return null;
}

export function applyTrimDrag(point) {
  const { edge } = state.dragCut.hit;
  const other = edge === "top" ? state.trims.bottom : state.trims.top;
  const maxSize = state.height - (other.removed ? other.size : 0) - MIN_CUT_PX;

  const size = edge === "top"
    ? clamp(Math.round(point.y), 0, maxSize)
    : clamp(Math.round(state.height - point.y), 0, maxSize);

  // 拖曳邊線表示要裁掉這個範圍。
  state.trims[edge] = { size, removed: size > 0 };
}

export function toggleTrim(edge) {
  const entry = state.trims[edge];
  entry.removed = !entry.removed;

  updateStitchView();
  setStatus(`${TRIM_LABELS[edge]}已${entry.removed ? "裁掉" : "保留"}。`);
}

const TRIM_LABELS = { top: "頂部區域", bottom: "底部區域" };

// ---- 分組計算 ----

export function recomputeStitch() {
  const plan = computeStitchGroups({
    ...state.stitchLayout,
    heightPx: state.height,
    removedGapIds: state.removedGapIds,
    cutOverrides: state.cutOverrides,
    customCuts: state.customCuts,
    edgeTrims: activeTrims()
  });

  state.stitchGaps = plan.gaps;
  state.stitchGroups = plan.groups;
  state.stitchCuts = plan.cuts;
  state.stitchImageBoxes = plan.imageBoxes;
  state.stitchCutWarning = state.stitchCuts.some((cut) =>
    state.stitchImageBoxes.some((box) => cut.startY < box.endY && cut.endY > box.startY)
  );

  state.stitchParts = splitIntoParts({
    groups: state.stitchGroups,
    keptGaps: state.stitchGaps.filter((gap) => !gap.removed),
    maxPx: MAX_PART_PX
  });

  state.stitchInfo.imageCount = plan.imageCount;
  state.stitchInfo.separatorCount = plan.separatorCount;
}

// 自動偵測的預設移除區域：所有圖片之間的間隔（預設全選）。
export function defaultRemovedGapIds() {
  const initial = computeStitchGroups({
    ...state.stitchLayout,
    heightPx: state.height
  });

  return new Set(initial.gaps.filter((gap) => gap.removed).map((gap) => gap.id));
}

function partRect(part) {
  const { x, width } = outputXRange();
  return { x, y: part.startY, width, height: part.endY - part.startY };
}

export function gapLabelById(id) {
  return `間隔 ${id}`;
}

export function buildStitchStatus() {
  const info = state.stitchInfo;
  const adGapCount = state.stitchGaps.filter((gap) => gap.adCandidate).length;
  const forcedParts = state.stitchParts.filter((part) => part.forced).length;
  const { width } = outputXRange();

  const parts = [
    `第 ${info.batchIndex} 批`,
    `長圖尺寸 ${width} × ${state.height}px`,
    `拼接 ${info.frameCount} 段截圖`,
    `偵測到 ${info.imageCount} 張圖片、` +
      `${info.separatorCount} 個廣告候選、` +
      `${state.stitchGaps.length} 處間隔（其中 ${adGapCount} 處含廣告）`
  ];

  if (state.stitchCuts.length > 0) {
    parts.push(`移除 ${state.stitchCuts.length} 處，分為 ${state.stitchGroups.length} 組`);
  } else {
    parts.push("未移除任何間隔");
  }

  const removedSides = ["left", "right"].filter((side) => state.sides[side].removed);

  if (removedSides.length > 0) {
    parts.push(`移除${removedSides.map((side) => SIDE_LABELS[side]).join("與")}`);
  }

  const trims = activeTrims();

  if (trims.top > 0 || trims.bottom > 0) {
    parts.push(`裁掉頂部 ${trims.top}px、底部 ${trims.bottom}px`);
  }

  parts.push(`共 ${state.stitchParts.length} 段輸出`);

  if (info.scrollMode === "element") {
    parts.push("已擷取頁面內的捲動區塊");
  }

  if (info.hiddenCount > 0) {
    parts.push(`已暫時隱藏 ${info.hiddenCount} 個固定元素（已還原）`);
  }

  let text = parts.join("，") + "。";

  if (info.reachedBottom) {
    text += "已擷取到頁面底部，這是最後一批。";
  } else if (state.nextStartY != null) {
    text += "尚未到頁面底部。下載完成後，可按「繼續截圖」擷取下一批。";
  }

  if (state.stitchCutWarning) {
    text += `注意：${CUT_WARNING_TEXT}，請確認。`;
  }

  if ((info.loadTimeouts || 0) > 0) {
    text += `注意：有 ${info.loadTimeouts} 次等待圖片載入逾時，部分圖片可能尚未完整載入。`;
  }

  if (info.forcedEnd) {
    text += "注意：本批在找不到分隔處的情況下結束，結尾可能落在內容中間。";
  }

  if (forcedParts > 0) {
    text += `注意：有 ${forcedParts} 段找不到可切的間隔，已在長度上限處切開。`;
  }

  if (info.gapCount > 0) {
    text += `注意：有 ${info.gapCount} 處捲動距離超過可見高度，接縫處可能缺漏。`;
  }

  return text;
}

// ---- 繪製 ----

export function drawStitchOverlay(ctx) {
  const ratio = pxPerCss();
  const labelSize = Math.max(12, Math.round(13 * ratio));
  const barLength = Math.max(24, Math.round(60 * ratio));
  const barThickness = Math.max(6, Math.round(8 * ratio));
  const thinLine = Math.max(2, Math.round(1.5 * ratio));
  const view = visibleRange();

  // 上下拖曳的拉條：畫在邊線的水平中央。
  const drawHorizontalHandles = (startY, endY, color) => {
    const x = Math.round((state.width - barLength) / 2);

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(2, Math.round(2 * ratio));

    for (const y of [startY, endY]) {
      // 位於長圖最上緣或最下緣的邊線（頂部、底部區域），拉條往內移，才不會有一半被切掉。
      const barY = clamp(y - barThickness / 2, 0, state.height - barThickness);

      ctx.fillRect(x, barY, barLength, barThickness);
      ctx.strokeRect(x, barY, barLength, barThickness);
    }

    ctx.restore();
  };

  // 左右拖曳的拉條：畫在目前看得到的範圍中央，長圖捲動時也找得到。
  const drawVerticalHandle = (x, color) => {
    const centerY = (view.top + view.bottom) / 2;

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(2, Math.round(2 * ratio));
    ctx.fillRect(x - barThickness / 2, centerY - barLength / 2, barThickness, barLength);
    ctx.strokeRect(x - barThickness / 2, centerY - barLength / 2, barThickness, barLength);
    ctx.restore();
  };

  const drawLabel = (text, color, x, y, align = "left") => {
    ctx.font = `600 ${labelSize}px sans-serif`;
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.textAlign = "left";
  };

  const labelX = (state.sides.left.removed ? state.sides.left.width : 0) + 8 * ratio;

  for (const gap of state.stitchGaps) {
    const label = gapLabelById(gap.id);

    if (gap.removed) {
      if (gap.cutEndY > gap.cutStartY) {
        ctx.fillStyle = CUT_COLOR;
        ctx.fillRect(0, gap.cutStartY, state.width, gap.cutEndY - gap.cutStartY);
        drawHorizontalHandles(gap.cutStartY, gap.cutEndY, "#b91c1c");
      }

      drawLabel(`${label}：移除`, "#b91c1c", labelX, gap.cutStartY + labelSize + 4 * ratio);
    } else {
      ctx.save();
      ctx.strokeStyle = GAP_COLOR;
      ctx.lineWidth = thinLine;
      ctx.setLineDash([12 * ratio, 8 * ratio]);
      ctx.strokeRect(1, gap.startY + 1, state.width - 2, gap.endY - gap.startY - 2);
      ctx.restore();

      drawLabel(`${label}：保留`, GAP_COLOR, labelX, gap.startY + labelSize + 4 * ratio);
    }
  }

  state.customCuts.forEach((cut, index) => {
    if (cut.endY <= cut.startY) return;

    if (cut.enabled === false) {
      ctx.save();
      ctx.strokeStyle = "#6d28d9";
      ctx.lineWidth = thinLine;
      ctx.setLineDash([10 * ratio, 6 * ratio]);
      ctx.strokeRect(1, cut.startY + 1, state.width - 2, cut.endY - cut.startY - 2);
      ctx.restore();

      drawLabel(`自訂 ${index + 1}：停用`, "#6d28d9", labelX, cut.startY + labelSize + 4 * ratio);
      return;
    }

    ctx.fillStyle = CUSTOM_CUT_COLOR;
    ctx.fillRect(0, cut.startY, state.width, cut.endY - cut.startY);
    drawHorizontalHandles(cut.startY, cut.endY, "#6d28d9");

    drawLabel(`自訂 ${index + 1}：移除`, "#6d28d9", labelX, cut.startY + labelSize + 4 * ratio);
  });

  // 目前點選的自訂移除框：粗框標示，可按 Delete 刪除。
  const activeCut = state.customCuts[state.activeCutIndex];

  if (activeCut && activeCut.endY > activeCut.startY) {
    ctx.save();
    ctx.strokeStyle = "#6d28d9";
    ctx.lineWidth = Math.max(3, Math.round(3 * ratio));
    ctx.strokeRect(0, activeCut.startY, state.width, activeCut.endY - activeCut.startY);
    ctx.restore();

    drawLabel(
      "已點選（Delete 刪除）",
      "#6d28d9",
      state.width - 8 * ratio,
      activeCut.startY + labelSize + 4 * ratio,
      "right"
    );
  }

  // 上下裁切：裁掉時以紅色標示；不論有沒有裁切，上下邊線都有拉條可以拖曳。
  for (const edge of ["top", "bottom"]) {
    const entry = state.trims[edge];
    const edgeY = trimEdgeY(edge);
    const regionY = edge === "top" ? 0 : edgeY;

    if (entry.size > 0) {
      if (entry.removed) {
        ctx.fillStyle = CUT_COLOR;
        ctx.fillRect(0, regionY, state.width, entry.size);
      } else {
        ctx.save();
        ctx.strokeStyle = GAP_COLOR;
        ctx.lineWidth = thinLine;
        ctx.setLineDash([12 * ratio, 8 * ratio]);
        ctx.beginPath();
        ctx.moveTo(0, edgeY);
        ctx.lineTo(state.width, edgeY);
        ctx.stroke();
        ctx.restore();
      }

      const labelY = edge === "top"
        ? labelSize + 4 * ratio
        : edgeY + labelSize + 4 * ratio;

      drawLabel(
        `${TRIM_LABELS[edge]}：${entry.removed ? "裁掉" : "保留"}`,
        entry.removed ? "#b91c1c" : GAP_COLOR,
        labelX,
        Math.min(labelY, state.height - 4 * ratio)
      );
    }

    // 拉條畫在邊線的水平中央；邊線在最上緣或最下緣時往內移，完整顯示。
    const x = Math.round((state.width - barLength) / 2);
    const barY = clamp(edgeY - barThickness / 2, 0, state.height - barThickness);

    ctx.save();
    ctx.fillStyle = entry.removed && entry.size > 0 ? SIDE_COLOR : GAP_COLOR;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(2, Math.round(2 * ratio));
    ctx.fillRect(x, barY, barLength, barThickness);
    ctx.strokeRect(x, barY, barLength, barThickness);
    ctx.restore();
  }

  // 左右空白：移除時以紅色直條標示，保留時以虛線標示。
  for (const side of ["left", "right"]) {
    const entry = state.sides[side];
    const edgeX = sideEdgeX(side);
    const regionX = side === "left" ? 0 : edgeX;

    if (entry.width > 0) {
      if (entry.removed) {
        ctx.fillStyle = CUT_COLOR;
        ctx.fillRect(regionX, 0, entry.width, state.height);
      } else {
        ctx.save();
        ctx.strokeStyle = GAP_COLOR;
        ctx.lineWidth = thinLine;
        ctx.setLineDash([12 * ratio, 8 * ratio]);
        ctx.beginPath();
        ctx.moveTo(edgeX, 0);
        ctx.lineTo(edgeX, state.height);
        ctx.stroke();
        ctx.restore();
      }
    }

    drawVerticalHandle(edgeX, entry.removed ? SIDE_COLOR : GAP_COLOR);
  }

  const groupLine = Math.max(3, Math.round(3 * ratio));
  const { x: keepX, width: keepWidth } = outputXRange();

  state.stitchGroups.forEach((group, index) => {
    ctx.fillStyle = GROUP_COLOR;
    ctx.fillRect(keepX, group.startY, keepWidth, groupLine);

    drawLabel(
      `第 ${index + 1} 組`,
      GROUP_COLOR,
      keepX + keepWidth - 8 * ratio,
      group.startY + groupLine + labelSize + 2 * ratio,
      "right"
    );
  });

  state.stitchParts.forEach((part, index) => {
    if (index === 0) return;

    ctx.fillStyle = PART_COLOR;
    ctx.fillRect(keepX, part.startY, keepWidth, Math.max(2, Math.round(2 * ratio)));
  });
}

// ---- 拖曳與點擊 ----

// 判斷滑鼠是否在左右空白的邊線上（整條邊線都有效）。
export function hitTestSide(point) {
  const threshold = HANDLE_CSS_PX * pxPerCss();
  let nearest = null;

  for (const side of ["left", "right"]) {
    const distance = Math.abs(point.x - sideEdgeX(side));

    if (distance <= threshold && (!nearest || distance < nearest.distance)) {
      nearest = { kind: "side", side, distance };
    }
  }

  return nearest;
}

// 點擊位置所在的側邊空白區域（有寬度時）。
export function sideAt(point) {
  if (state.sides.left.width > 0 && point.x < state.sides.left.width) {
    return "left";
  }

  if (state.sides.right.width > 0 && point.x > state.width - state.sides.right.width) {
    return "right";
  }

  return null;
}

export function applySideDrag(point) {
  const { side } = state.dragCut.hit;
  const other = side === "left" ? state.sides.right : state.sides.left;
  const maxWidth = state.width - (other.removed ? other.width : 0) - MIN_CUT_PX;

  const width = side === "left"
    ? clamp(Math.round(point.x), 0, maxWidth)
    : clamp(Math.round(state.width - point.x), 0, maxWidth);

  // 拖曳邊線表示要移除這個範圍。
  state.sides[side] = { width, removed: width > 0 };
}

export function toggleSide(side) {
  const entry = state.sides[side];
  entry.removed = !entry.removed;

  updateStitchView();
  setStatus(`${SIDE_LABELS[side]}已${entry.removed ? "移除" : "保留"}。`);
}

// 判斷滑鼠位置是否在某個移除框的上緣、下緣或內部。
// 邊線的觸發範圍可能互相重疊（框很薄或畫面縮小時），因此選擇距離最近的一條邊。
export function hitTestCut(point) {
  const threshold = HANDLE_CSS_PX * pxPerCss();
  const entries = [];

  for (const gap of state.stitchGaps) {
    if (gap.removed && gap.cutEndY > gap.cutStartY) {
      entries.push({ kind: "gap", id: gap.id, startY: gap.cutStartY, endY: gap.cutEndY });
    }
  }

  state.customCuts.forEach((cut, index) => {
    if (cut.endY > cut.startY) {
      entries.push({ kind: "custom", index, startY: cut.startY, endY: cut.endY });
    }
  });

  // 第一步：找出所有在觸發範圍內的邊線，取距離最近者。
  let nearest = null;

  for (const entry of entries) {
    for (const mode of ["top", "bottom"]) {
      const distance = Math.abs(point.y - (mode === "top" ? entry.startY : entry.endY));

      if (distance <= threshold && (!nearest || distance < nearest.distance)) {
        nearest = { ...entry, mode, distance };
      }
    }
  }

  if (nearest) {
    const { distance, ...hit } = nearest;
    return hit;
  }

  // 第二步：沒有命中邊線，才判斷是否在框內部（整體移動）。
  for (const entry of entries) {
    if (point.y > entry.startY && point.y < entry.endY) {
      return { ...entry, mode: "move" };
    }
  }

  return null;
}

// 依拖曳距離更新移除範圍，並限制在截圖範圍內。
export function applyCutDrag(point) {
  const { hit, origin, startPointY } = state.dragCut;
  const dy = point.y - startPointY;

  let startY = origin.startY;
  let endY = origin.endY;

  if (hit.mode === "top") {
    startY = clamp(origin.startY + dy, 0, endY - MIN_CUT_PX);
  } else if (hit.mode === "bottom") {
    endY = clamp(origin.endY + dy, startY + MIN_CUT_PX, state.height);
  } else {
    const length = origin.endY - origin.startY;
    startY = clamp(origin.startY + dy, 0, state.height - length);
    endY = startY + length;
  }

  const rounded = { startY: Math.round(startY), endY: Math.round(endY) };

  if (hit.kind === "gap") {
    state.cutOverrides.set(hit.id, rounded);
  } else {
    state.customCuts[hit.index] = { ...rounded, enabled: state.customCuts[hit.index].enabled };
  }
}

export function toggleGap(gapId) {
  if (state.removedGapIds.has(gapId)) {
    state.removedGapIds.delete(gapId);
  } else {
    state.removedGapIds.add(gapId);
  }

  updateStitchView();

  setStatus(
    `${gapLabelById(gapId)} 已${state.removedGapIds.has(gapId) ? "移除" : "保留"}。` +
    `目前共移除 ${state.stitchCuts.length} 處，分為 ${state.stitchParts.length} 段輸出。`
  );
}

export const MIN_CUT_SIZE = MIN_CUT_PX;

export function updateAddCutButton() {
  dom.addCutButton.textContent = state.addCutMode ? "完成新增" : "手動新增移除區域";
  dom.addCutButton.setAttribute("aria-pressed", String(state.addCutMode));
}

// 重新計算並更新預覽與清單。
export function updateStitchView() {
  recomputeStitch();
  requestDraw();
  renderStitchGroups();
}

// ---- 結果清單 ----

function addPanel(title, rows) {
  const panel = document.createElement("div");
  panel.className = "gapPanel";

  const heading = document.createElement("h3");
  heading.textContent = title;
  panel.append(heading, ...rows);

  dom.cutListContainer.appendChild(panel);
}

function checkboxRow(checked, text, title, onChange, extra) {
  const row = document.createElement("label");
  row.className = "selectRow";
  row.title = title;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.title = title;
  checkbox.addEventListener("change", () => onChange(checkbox.checked));

  row.append(checkbox, text);

  if (extra) {
    row.appendChild(extra);
  }

  return row;
}

function renderCutList() {
  dom.cutListContainer.replaceChildren();

  const trimRows = ["top", "bottom"]
    .filter((edge) => state.trims[edge].size > 0)
    .map((edge) => checkboxRow(
      state.trims[edge].removed,
      ` ${TRIM_LABELS[edge]}（${state.trims[edge].size}px）`,
      "勾選＝裁掉此區域；取消勾選＝保留",
      () => toggleTrim(edge)
    ));

  const sideRows = ["left", "right"]
    .filter((side) => state.sides[side].width > 0)
    .map((side) => checkboxRow(
      state.sides[side].removed,
      ` ${SIDE_LABELS[side]}（${state.sides[side].width}px）`,
      "勾選＝移除此區域；取消勾選＝保留",
      () => toggleSide(side)
    ));

  if (trimRows.length + sideRows.length > 0) {
    addPanel("上下左右邊緣", [...trimRows, ...sideRows]);
  }

  if (state.stitchGaps.length > 0) {
    addPanel(
      "移除區域（圖片之間的間隔）",
      state.stitchGaps.map((gap) => checkboxRow(
        gap.removed,
        ` ${gapLabelById(gap.id)}（${gap.endY - gap.startY}px，${gap.adCandidate ? "偵測到廣告" : "未偵測到廣告"}）`,
        "勾選＝移除此區域；取消勾選＝保留",
        () => toggleGap(gap.id)
      ))
    );
  }

  if (state.customCuts.length > 0) {
    addPanel(
      "手動新增的移除區域",
      state.customCuts.map((cut, index) => {
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.textContent = "刪除";

        removeButton.addEventListener("click", (event) => {
          event.preventDefault();
          removeCustomCut(index);
        });

        return checkboxRow(
          cut.enabled !== false,
          ` 自訂 ${index + 1}（${cut.endY - cut.startY}px）`,
          "勾選＝啟用移除；取消勾選＝暫時停用",
          (checked) => {
            cut.enabled = checked;
            updateStitchView();
          },
          removeButton
        );
      })
    );
  }
}

function partLabel(number) {
  return `long_b${state.stitchInfo.batchIndex}_p${String(number).padStart(2, "0")}`;
}

export async function renderStitchGroups() {
  const generation = ++state.renderGeneration;

  revokePreviewUrls();
  dom.resultsContainer.replaceChildren();
  renderCutList();
  renderPartList();

  if (state.stitchParts.length === 0) {
    const message = document.createElement("p");
    message.textContent = "沒有可輸出的段落。";
    dom.resultsContainer.appendChild(message);
    refreshStitchControls();
    return;
  }

  for (const [index, part] of state.stitchParts.entries()) {
    const number = index + 1;
    const rect = partRect(part);

    const card = document.createElement("article");
    card.className = "resultCard";
    card.dataset.partRow = String(index);

    const heading = document.createElement("h3");
    heading.textContent = `第 ${number} 段`;

    const preview = document.createElement("img");
    preview.alt = `第 ${number} 段的長圖預覽`;

    const dimensions = document.createElement("p");
    dimensions.textContent = `${rect.width} × ${rect.height}px`;

    const previewFrame = document.createElement("div");
    previewFrame.className = "previewFrame";
    previewFrame.appendChild(preview);

    card.append(heading, previewFrame, dimensions);

    if (part.forced) {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = "此段內找不到可切的間隔，已在長度上限處切開。";
      card.appendChild(note);
    }

    const mergeLabel = document.createElement("label");
    mergeLabel.className = "selectRow";

    const mergeCheckbox = createPartCheckbox(part, index);

    mergeLabel.append(mergeCheckbox, " 加入合併");
    card.appendChild(mergeLabel);

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.textContent = "下載此段長圖";

    downloadButton.addEventListener("click", async () => {
      downloadButton.disabled = true;
      downloadButton.textContent = "正在儲存……";

      const result = await runDownload(() =>
        downloadItems([{ label: partLabel(number), rects: rect }]));

      downloadButton.disabled = false;
      downloadButton.textContent = "下載此段長圖";

      if (result) {
        reportDownload(result, "段長圖", { button: downloadButton, buttonText: "下載此段長圖" });
      }
    });

    card.appendChild(buttonRow(downloadButton, createCopyButton(() => rect)));
    dom.resultsContainer.appendChild(card);

    try {
      const blob = await makeThumbnail(rect);

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

  refreshStitchControls();
}

// ---- 段落是否加入合併 ----

function partCenter(part) {
  return (part.startY + part.endY) / 2;
}

function isPartIncluded(part) {
  const center = partCenter(part);

  return !state.excludedPartRanges.some(
    (range) => center >= range.startY && center < range.endY
  );
}

function setPartIncluded(part, included) {
  const center = partCenter(part);

  state.excludedPartRanges = state.excludedPartRanges.filter(
    (range) => !(center >= range.startY && center < range.endY)
  );

  if (!included) {
    state.excludedPartRanges.push({ startY: part.startY, endY: part.endY });
  }
}

// 同一段落在上方清單與卡片上各有一個勾選框，任一個改變時同步另一個。
function syncPartCheckboxes() {
  document.querySelectorAll("input[data-part-index]").forEach((checkbox) => {
    const part = state.stitchParts[Number(checkbox.dataset.partIndex)];
    checkbox.checked = Boolean(part) && isPartIncluded(part);
  });
}

function createPartCheckbox(part, index) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.partIndex = String(index);
  checkbox.checked = isPartIncluded(part);

  checkbox.addEventListener("change", () => {
    setPartIncluded(part, checkbox.checked);
    syncPartCheckboxes();
    refreshStitchControls();
  });

  return checkbox;
}

// 上方「下載長圖」區的段落清單，方便快速勾選要合併的段落。
function renderPartList() {
  dom.partListContainer.replaceChildren();

  if (state.stitchParts.length === 0) return;

  const panel = document.createElement("div");
  panel.className = "gapPanel";

  state.stitchParts.forEach((part, index) => {
    const rect = partRect(part);
    const row = document.createElement("label");
    row.className = "selectRow";
    row.dataset.partRow = String(index);
    row.title = "勾選＝加入合併";
    row.append(
      createPartCheckbox(part, index),
      ` 第 ${index + 1} 段（${rect.width} × ${rect.height}px）`
    );
    panel.appendChild(row);
  });

  dom.partListContainer.appendChild(panel);
}

function setAllPartsIncluded(included) {
  state.excludedPartRanges = included
    ? []
    : state.stitchParts.map((part) => ({ startY: part.startY, endY: part.endY }));

  syncPartCheckboxes();
  refreshStitchControls();
}

// 勾選「加入合併」的段落（依由上到下的順序），以及它們的段落編號。
function includedParts() {
  return state.stitchParts
    .map((part, index) => ({ part, number: index + 1 }))
    .filter(({ part }) => isPartIncluded(part));
}

// 彈窗說明超出合併高度上限，回傳使用者是否同意分成多張下載。
function confirmSplitMerge(plan) {
  const format = outputFormat(state.settings).label;
  const heights = plan.chunks
    .map((rects) => rects.reduce((sum, rect) => sum + rect.height, 0).toLocaleString())
    .join("、");

  dom.mergeDialogMessage.textContent =
    `勾選的 ${plan.selected.length} 段合計 ${plan.totalHeight.toLocaleString()}px，` +
    `超過 ${format} 單張圖片的高度上限 ${plan.limit.toLocaleString()}px，無法合併成一張。`;

  dom.mergeDialogDetail.textContent =
    `繼續合併時會自動分成 ${plan.chunks.length} 張圖片下載（高度分別為 ${heights}px），` +
    "每張都會在段落的交界處切開。";

  dom.mergeDialogConfirm.textContent = `分成 ${plan.chunks.length} 張下載`;

  // 直接由按鈕回傳結果（不依賴 close 事件，在背景分頁中它可能延後觸發）；按 Esc 視為取消。
  return new Promise((resolve) => {
    const buttons = dom.mergeDialog.querySelectorAll("button[value]");

    const finish = (value) => {
      buttons.forEach((button) => button.removeEventListener("click", onClick));
      dom.mergeDialog.removeEventListener("cancel", onCancel);

      if (dom.mergeDialog.open) {
        dom.mergeDialog.close(value);
      }

      resolve(value === "split");
    };

    const onClick = (event) => {
      event.preventDefault();
      finish(event.currentTarget.value);
    };

    const onCancel = (event) => {
      event.preventDefault();
      finish("cancel");
    };

    buttons.forEach((button) => button.addEventListener("click", onClick));
    dom.mergeDialog.addEventListener("cancel", onCancel);
    dom.mergeDialog.showModal();
  });
}

// 合併勾選段落的規劃：總高度、目前格式的高度上限，以及超過上限時要分成幾張。
function planMerge() {
  const selected = includedParts();
  const rects = selected.map(({ part }) => partRect(part));
  const width = rects[0]?.width ?? outputXRange().width;
  const totalHeight = rects.reduce((sum, rect) => sum + rect.height, 0);
  const limit = mergeHeightLimit(width);
  const chunks = splitByHeight(rects, limit);

  return {
    selected,
    rects,
    width,
    totalHeight,
    limit,
    chunks,
    overLimit: totalHeight > limit
  };
}

// 勾選的段落合計超過上限時：已勾選的項目（清單與卡片）以紅色底色標示，並顯示提醒。
function updateMergeWarning(plan) {
  const included = new Set(plan.selected.map(({ number }) => number - 1));

  document.querySelectorAll("[data-part-row]").forEach((element) => {
    element.classList.toggle(
      "overLimit",
      plan.overLimit && included.has(Number(element.dataset.partRow))
    );
  });

  dom.mergeWarning.hidden = !plan.overLimit;

  if (plan.overLimit) {
    const format = outputFormat(state.settings).label;

    dom.mergeWarning.textContent =
      `勾選的段落合計 ${plan.totalHeight.toLocaleString()}px，` +
      `超過 ${format} 單張圖片的高度上限 ${plan.limit.toLocaleString()}px。` +
      `合併時會自動分成 ${plan.chunks.length} 張圖片下載；` +
      "也可以減少勾選的段落，或在「下載設定」改用其他格式。";
  }
}

export function refreshStitchControls() {
  const busy = state.busy || !state.loaded;
  const plan = planMerge();
  const includedCount = plan.selected.length;

  dom.downloadAllGroupsButton.textContent = `下載全部段落（${state.stitchParts.length}）`;
  dom.downloadAllGroupsButton.disabled = busy || state.stitchParts.length === 0;

  dom.mergeDownloadButton.textContent = plan.overLimit
    ? `合併勾選的段落（${includedCount}，將分為 ${plan.chunks.length} 張）`
    : `合併勾選的段落（${includedCount}）`;
  dom.mergeDownloadButton.disabled = busy || includedCount === 0;
  dom.mergeDownloadButton.classList.toggle("warning", plan.overLimit);

  updateMergeWarning(plan);

  dom.selectAllPartsButton.disabled = busy || state.stitchParts.length === 0;
  dom.deselectAllPartsButton.disabled = busy || state.stitchParts.length === 0;

  const isCurrent = state.session !== null && state.session.jobId === state.jobId;
  const hasNextBatch = isCurrent && state.nextStartY != null;

  dom.continueButton.textContent = hasNextBatch
    ? `繼續截圖（第 ${(state.stitchInfo?.batchIndex || 1) + 1} 批）`
    : (isCurrent ? "已擷取到頁面底部" : "無法繼續（已結束）");
  dom.continueButton.disabled = state.busy || !hasNextBatch;

  dom.finishButton.disabled = state.busy || !isCurrent;
}

// ---- 按鈕 ----

function removeCustomCut(index) {
  state.customCuts.splice(index, 1);

  if (state.activeCutIndex === index) {
    state.activeCutIndex = null;
  } else if (state.activeCutIndex > index) {
    state.activeCutIndex--;
  }

  updateStitchView();
}

// 刪除目前點選的自訂移除框（Delete 鍵）。回傳是否有刪除。
export function deleteActiveCut() {
  const index = state.activeCutIndex;

  if (index == null || !state.customCuts[index]) {
    return false;
  }

  removeCustomCut(index);
  setStatus(`已刪除自訂 ${index + 1}。可按 Ctrl＋Z 復原。`);

  return true;
}

export function resetCuts() {
  state.activeCutIndex = null;
  state.cutOverrides = new Map();
  state.customCuts = [];
  state.excludedPartRanges = [];
  state.addCutMode = false;
  updateAddCutButton();

  state.removedGapIds = defaultRemovedGapIds();
  resetSides();
  resetTrims();

  updateStitchView();
}

export function initStitchMode(refreshControls) {
  dom.selectAllPartsButton.addEventListener("click", () => {
    setAllPartsIncluded(true);
    setStatus(`已將全部 ${state.stitchParts.length} 段加入合併。`);
  });

  dom.deselectAllPartsButton.addEventListener("click", () => {
    setAllPartsIncluded(false);
    setStatus("已取消所有段落的「加入合併」。");
  });

  dom.addCutButton.addEventListener("click", () => {
    state.addCutMode = !state.addCutMode;
    updateAddCutButton();

    setStatus(state.addCutMode
      ? "請在預覽區拖曳，框出要移除的範圍。"
      : "已取消新增移除框。");
  });

  dom.selectAllCutsButton.addEventListener("click", () => {
    state.removedGapIds = new Set(state.stitchGaps.map((gap) => gap.id));
    state.customCuts.forEach((cut) => {
      cut.enabled = true;
    });

    for (const side of ["left", "right"]) {
      state.sides[side].removed = state.sides[side].width > 0;
    }

    for (const edge of ["top", "bottom"]) {
      state.trims[edge].removed = state.trims[edge].size > 0;
    }

    updateStitchView();

    setStatus(
      `已全部移除：${state.stitchGaps.length} 個間隔、${state.customCuts.length} 個自訂框與上下左右邊緣，` +
      `共 ${state.stitchCuts.length} 處移除，分為 ${state.stitchParts.length} 段輸出。`
    );
  });

  dom.deselectAllCutsButton.addEventListener("click", () => {
    state.removedGapIds = new Set();
    state.customCuts.forEach((cut) => {
      cut.enabled = false;
    });

    state.sides.left.removed = false;
    state.sides.right.removed = false;
    state.trims.top.removed = false;
    state.trims.bottom.removed = false;

    updateStitchView();
    setStatus("已保留所有區域（自訂框仍保留在清單中，可隨時重新啟用）。");
  });

  dom.resetCutsButton.addEventListener("click", () => {
    resetCuts();
    setStatus("已還原為自動偵測的移除範圍。");
  });

  dom.downloadAllGroupsButton.addEventListener("click", async () => {
    if (state.stitchParts.length === 0) return;

    state.busy = true;
    refreshControls();

    const result = await runDownload(() => downloadItems(
      state.stitchParts.map((part, index) => ({
        label: partLabel(index + 1),
        rects: partRect(part)
      })),
      (index, total) => setStatus(`正在儲存第 ${index + 1} ／ ${total} 段……`)
    ));

    state.busy = false;
    refreshControls();

    if (result) {
      reportDownload(result, "段長圖", {
        button: dom.downloadAllGroupsButton,
        buttonText: refreshControls
      });
    }
  });

  dom.mergeDownloadButton.addEventListener("click", async () => {
    const plan = planMerge();
    const { selected } = plan;

    if (selected.length === 0) {
      notify("請先在段落中勾選「加入合併」，再按合併。", "error");
      return;
    }

    // 超過高度上限：先彈窗說明，使用者確認後才自動分成多張。
    if (plan.overLimit && !(await confirmSplitMerge(plan))) {
      setStatus("已取消合併。可以減少勾選的段落，或在「下載設定」改用其他格式。");
      return;
    }

    state.busy = true;
    refreshControls();
    setStatus(`正在合併 ${selected.length} 段長圖……`);

    try {
      const allSelected = selected.length === state.stitchParts.length;

      // 全部合併時檔名為 merged；只合併部分段落時，檔名加上段落編號，例如 merged_p01-p03-p04。
      const base = allSelected
        ? `long_b${state.stitchInfo.batchIndex}_merged`
        : `long_b${state.stitchInfo.batchIndex}_merged_` +
          selected.map(({ number }) => `p${String(number).padStart(2, "0")}`).join("-");

      // 分成多張時，檔名加上「_1of3」等張數。
      const items = plan.chunks.map((rects, index) => ({
        label: plan.chunks.length > 1 ? `${base}_${index + 1}of${plan.chunks.length}` : base,
        rects
      }));

      const result = await runDownload(() => downloadItems(
        items,
        (index, total) => total > 1 && setStatus(`正在合併並儲存第 ${index + 1} ／ ${total} 張……`)
      ));

      state.busy = false;
      refreshControls();

      if (!result) return;

      const numbers = selected.map(({ number }) => number).join("、");

      if (result.failed > 0) {
        notify("合併下載失敗，請減少勾選的段落，或改用「下載全部段落」。", "error");
        return;
      }

      reportDownload(result, "張", {
        button: dom.mergeDownloadButton,
        buttonText: refreshControls,
        prefix: items.length > 1
          ? `已將第 ${numbers} 段合併，因超過高度上限分為 ${items.length} 張圖片。`
          : `已將第 ${numbers} 段合併為一張長圖（${plan.width} × ${plan.totalHeight}px）。`
      });
    } catch (error) {
      state.busy = false;
      refreshControls();
      notify(error.message || "合併下載失敗，請重試。", "error");
    }
  });

  // 繼續截圖：由背景程式切回目標頁面擷取下一批，完成後本頁會載入新的一批。
  dom.continueButton.addEventListener("click", async () => {
    state.busy = true;
    refreshControls();
    setStatus("正在切回目標頁面，繼續截圖中，請勿切換分頁或操作目標網頁……");

    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGES.continueStitch,
        jobId: state.jobId,
        nextStartY: state.nextStartY
      });

      if (!response?.ok) {
        throw new Error(response?.error || "繼續截圖失敗。");
      }
    } catch (error) {
      console.error(error);
      setStatus(error.message || "繼續截圖失敗。");
      state.busy = false;
      refreshControls();
    }
  });

  // 結束：清除本次長截圖的所有暫存。
  dom.finishButton.addEventListener("click", async () => {
    state.busy = true;
    refreshControls();

    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGES.finishStitch,
        jobId: state.jobId
      });

      if (!response?.ok) {
        throw new Error(response?.error || "清除暫存失敗。");
      }

      state.session = null;
      setStatus("已結束並清除截圖暫存。目前畫面上的長圖仍可下載，關閉本頁後就會消失。");
    } catch (error) {
      console.error(error);
      setStatus(error.message || "清除暫存失敗。");
    } finally {
      state.busy = false;
      refreshControls();
    }
  });
}
