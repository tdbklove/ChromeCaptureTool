const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");

const status = document.querySelector("#status");
const saveButton = document.querySelector("#saveButton");
const resetButton = document.querySelector("#resetButton");
const resetAllButton = document.querySelector("#resetAllButton");
const resultsContainer = document.querySelector("#results");
const resultsTitle = document.querySelector("#resultsTitle");
const resultsInstruction = document.querySelector("#resultsInstruction");
const imageBatchControls = document.querySelector("#imageBatchControls");
const stitchBatchControls = document.querySelector("#stitchBatchControls");
const modeBadge = document.querySelector("#modeBadge");
const cutListContainer = document.querySelector("#cutList");
const sessionControls = document.querySelector("#sessionControls");
const continueButton = document.querySelector("#continueButton");
const finishButton = document.querySelector("#finishButton");
const selectAllButton = document.querySelector("#selectAllButton");
const deselectAllButton = document.querySelector("#deselectAllButton");
const downloadSelectedButton = document.querySelector("#downloadSelectedButton");
const downloadAllGroupsButton = document.querySelector("#downloadAllGroupsButton");
const mergeDownloadButton = document.querySelector("#mergeDownloadButton");
const addCutButton = document.querySelector("#addCutButton");
const resetCutsButton = document.querySelector("#resetCutsButton");
const selectAllCutsButton = document.querySelector("#selectAllCutsButton");
const deselectAllCutsButton = document.querySelector("#deselectAllCutsButton");

const SESSION_KEY = "stitchSession";

// 單張長圖的最大高度（裝置像素）。超過時會在圖片間隔處切開。
const MAX_PART_PX = 10000;

const image = new Image();

let selection = null;
let startPoint = null;
let pointerDownClient = null;
let isDragging = false;
let loaded = false;
let busy = false;

let detectedImages = [];

// 長圖模式的狀態。
let stitchMode = false;
let currentSession = null;      // 目前的截圖工作階段（來自 storage）
let stitchLayout = null;        // { layouts, originScrollY, scale }
let stitchInfo = null;
let removedGapIds = new Set();
let stitchGaps = [];
let stitchGroups = [];
let stitchCuts = [];
let stitchParts = [];

// 移除範圍是否切入圖片（以及切入的圖片位置）。
let stitchImageBoxes = [];
let stitchTrimmed = false;
let stitchCutWarning = false;
const CUT_WARNING_TEXT = "此移除範圍已切入圖片";

// 使用者拖曳調整過的移除範圍（間隔編號 → { startY, endY }）與手動新增的移除框。
let cutOverrides = new Map();
let customCuts = [];
let dragCut = null;

// 單張模式：正在拖曳調整的截取框，以及目前作用中（被點選）的偵測框。
let editDrag = null;
let activeItemId = null;
let addCutMode = false;

const CUSTOM_CUT_COLOR = "rgba(109, 40, 217, 0.35)";

let previewUrls = [];
let stitchedObjectUrl = null;

// 結果清單的產生是非同步的（每張預覽都要等待圖片產生）。
// 每次重新產生都遞增版本編號，舊的產生流程發現版本已過期就停止，避免卡片重複或錯亂。
let renderGeneration = 0;

const DETECTED_COLOR = "#00a86b";
const UNSELECTED_COLOR = "#9ca3af";
const CUT_COLOR = "rgba(220, 38, 38, 0.35)";
const GAP_COLOR = "#d97706";
const GROUP_COLOR = "#2563eb";
const PART_COLOR = "#7c3aed";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function imageFilename(id) {
  return `image_${String(id).padStart(3, "0")}.png`;
}

function longFilename(batchIndex, number) {
  return `long_b${batchIndex}_${String(number).padStart(3, "0")}.png`;
}

// ---- 純計算函式（不接觸 DOM，方便獨立測試） ----

function buildDetections(capture, canvasWidth, canvasHeight) {
  const scaleX = canvasWidth / capture.viewportWidth;
  const scaleY = canvasHeight / capture.viewportHeight;

  return (capture.images || [])
    .map((item) => {
      const left = clamp(Math.round(item.x * scaleX), 0, canvasWidth);
      const top = clamp(Math.round(item.y * scaleY), 0, canvasHeight);
      const right = clamp(Math.round((item.x + item.width) * scaleX), 0, canvasWidth);
      const bottom = clamp(Math.round((item.y + item.height) * scaleY), 0, canvasHeight);

      return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        alt: item.alt || "",
        sourceWidth: item.sourceWidth,
        sourceHeight: item.sourceHeight
      };
    })
    .filter((item) => item.width >= 2 && item.height >= 2)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((item, index) => ({
      ...item,
      id: index + 1,
      selected: true,
      original: {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height
      }
    }));
}

// 決定每段截圖要取用的像素範圍。每段新增的內容位於當前截圖的最底部。
function computeStitchPlan(frames, frameHeightPx, scaleY, viewportHeight) {
  const segments = [];
  let totalHeight = 0;
  let gapCount = 0;

  if (frames.length === 0) {
    return { segments, totalHeight, gapCount };
  }

  segments.push({ frameIndex: 0, sourceY: 0, height: frameHeightPx });
  totalHeight = frameHeightPx;

  for (let i = 1; i < frames.length; i++) {
    const scrollDelta = frames[i].scrollY - frames[i - 1].scrollY;

    if (scrollDelta <= 0) {
      continue;
    }

    if (scrollDelta > viewportHeight) {
      gapCount++;
    }

    const newPixels = clamp(Math.round(scrollDelta * scaleY), 1, frameHeightPx);

    segments.push({
      frameIndex: i,
      sourceY: frameHeightPx - newPixels,
      height: newPixels
    });

    totalHeight += newPixels;
  }

  return { segments, totalHeight, gapCount };
}

function uniqueBoxes(list, isSame) {
  const result = [];

  for (const item of list) {
    if (!result.some((existing) => isSame(existing, item))) {
      result.push(item);
    }
  }

  return result;
}

function clipBox(box, top, bottom) {
  const clippedTop = Math.max(box.top, top);
  const clippedBottom = Math.min(box.bottom, bottom);

  if (clippedBottom <= clippedTop) {
    return null;
  }

  return { ...box, top: clippedTop, bottom: clippedBottom };
}

// 計算左右裁切範圍：取所有圖片的最左與最右邊界，去掉兩側的空白。
// 沒有圖片資訊時不裁切。回傳的 x／width 為截圖像素。
function computeHorizontalTrim(layouts, pxPerCssX, widthPx) {
  const boxes = layouts
    .flatMap((layout) => layout.images || [])
    .filter((box) => typeof box.left === "number" && typeof box.right === "number" && box.right > box.left);

  if (boxes.length === 0) {
    return { x: 0, width: widthPx };
  }

  const minLeft = Math.min(...boxes.map((box) => box.left));
  const maxRight = Math.max(...boxes.map((box) => box.right));

  const x = clamp(Math.floor(minLeft * pxPerCssX), 0, widthPx - 1);
  const right = clamp(Math.ceil(maxRight * pxPerCssX), x + 1, widthPx);

  return { x, width: right - x };
}

// 收集版面上的圖片、廣告候選與圖片之間的間隔（皆為整頁座標）。
function collectLayoutGaps({ layouts, pageTop, pageBottom }) {
  const TOLERANCE = 4;

  const images = uniqueBoxes(
    layouts.flatMap((layout) => layout.images || []),
    (a, b) =>
      a.src === b.src &&
      Math.abs(a.top - b.top) <= TOLERANCE &&
      Math.abs(a.bottom - b.bottom) <= TOLERANCE
  )
    .map((box) => clipBox(box, pageTop, pageBottom))
    .filter(Boolean)
    .sort((a, b) => a.top - b.top);

  const separators = uniqueBoxes(
    layouts.flatMap((layout) => layout.separators || []),
    (a, b) =>
      Math.abs(a.top - b.top) <= TOLERANCE &&
      Math.abs(a.bottom - b.bottom) <= TOLERANCE
  )
    .map((box) => clipBox(box, pageTop, pageBottom))
    .filter(Boolean);

  const rawGaps = [];
  let maxBottom = pageTop;

  images.forEach((image, index) => {
    if (index > 0 && image.top > maxBottom) {
      rawGaps.push({ top: maxBottom, bottom: image.top });
    }

    maxBottom = Math.max(maxBottom, image.bottom);
  });

  const gaps = rawGaps.map((rawGap, index) => {
    const separatorsInGap = separators.filter((separator) => {
      const center = (separator.top + separator.bottom) / 2;
      return center > rawGap.top && center < rawGap.bottom;
    });

    const adCandidate = separatorsInGap.length > 0;

    const cutTop = adCandidate
      ? Math.max(rawGap.top, Math.min(...separatorsInGap.map((s) => s.top)))
      : rawGap.top;

    const cutBottom = adCandidate
      ? Math.min(rawGap.bottom, Math.max(...separatorsInGap.map((s) => s.bottom)))
      : rawGap.bottom;

    return {
      id: index + 1,
      top: rawGap.top,
      bottom: rawGap.bottom,
      cutTop,
      cutBottom,
      adCandidate
    };
  });

  return { images, separators, gaps };
}

// 合併重疊或相接的範圍，回傳依位置排序的結果。
function mergeRanges(ranges) {
  const sorted = ranges
    .filter((range) => range.endY > range.startY)
    .map((range) => ({ startY: range.startY, endY: range.endY }))
    .sort((a, b) => a.startY - b.startY);

  const merged = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];

    if (last && range.startY <= last.endY) {
      last.endY = Math.max(last.endY, range.endY);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

// 收集圖片上方（頂部）與下方（底部）的區域。
// 這些區域不在兩張圖片之間，但可能是導覽列、頁首或頁尾廣告，因此也列為可移除的位置。
// 預設保留；使用者可以切換、拖曳邊緣，或用「全選」一次移除。
function collectEdgeGaps({ images, separators, pageTop, pageBottom }) {
  const TOLERANCE = 0.5;
  const edges = [];

  if (images.length === 0) {
    return edges;
  }

  const describe = (top, bottom) => {
    const inside = separators.filter((separator) => {
      const center = (separator.top + separator.bottom) / 2;
      return center > top && center < bottom;
    });

    if (inside.length === 0) {
      return { adCandidate: false, cutTop: top, cutBottom: bottom };
    }

    return {
      adCandidate: true,
      cutTop: Math.max(top, Math.min(...inside.map((s) => s.top))),
      cutBottom: Math.min(bottom, Math.max(...inside.map((s) => s.bottom)))
    };
  };

  const firstTop = Math.min(...images.map((image) => image.top));

  if (firstTop - pageTop > TOLERANCE) {
    edges.push({
      id: "top",
      isEdge: true,
      top: pageTop,
      bottom: firstTop,
      ...describe(pageTop, firstTop)
    });
  }

  const lastBottom = Math.max(...images.map((image) => image.bottom));

  if (pageBottom - lastBottom > TOLERANCE) {
    edges.push({
      id: "bottom",
      isEdge: true,
      top: lastBottom,
      bottom: pageBottom,
      ...describe(lastBottom, pageBottom)
    });
  }

  return edges;
}

// 依間隔與使用者的移除範圍切分長圖。
//
// removedGapIds：要移除的位置（間隔編號，或 "top" / "bottom"）；未提供時，
// 圖片間偵測到廣告的預設移除，頂部與底部區域預設保留。
// cutOverrides：拖曳調整過的移除範圍（Map：位置編號 → { startY, endY }，截圖像素）。
// customCuts：手動新增的移除框（{ startY, endY, enabled }，截圖像素）；enabled 為 false 時不套用。
function computeStitchGroups({
  layouts,
  originScrollY,
  scale,
  heightPx,
  removedGapIds,
  cutOverrides,
  customCuts
}) {
  const pageTop = originScrollY;
  const pageBottom = originScrollY + heightPx / scale;

  const toPixel = (y) =>
    clamp(Math.round((y - originScrollY) * scale), 0, heightPx);

  const { images, separators, gaps: pageGaps } = collectLayoutGaps({
    layouts,
    pageTop,
    pageBottom
  });

  const edgeGaps = collectEdgeGaps({ images, separators, pageTop, pageBottom });
  const topGap = edgeGaps.find((gap) => gap.id === "top");
  const bottomGap = edgeGaps.find((gap) => gap.id === "bottom");

  const allPageGaps = [
    ...(topGap ? [topGap] : []),
    ...pageGaps.map((gap) => ({ ...gap, isEdge: false })),
    ...(bottomGap ? [bottomGap] : [])
  ];

  const gaps = allPageGaps
    .map((gap) => {
      const startY = toPixel(gap.top);
      const endY = toPixel(gap.bottom);
      const override = cutOverrides ? cutOverrides.get(gap.id) : undefined;

      return {
        id: gap.id,
        isEdge: gap.isEdge === true,
        startY,
        endY,
        cutStartY: override
          ? clamp(override.startY, 0, heightPx)
          : toPixel(gap.cutTop),
        cutEndY: override
          ? clamp(override.endY, 0, heightPx)
          : toPixel(gap.cutBottom),
        adCandidate: gap.adCandidate,
        removed: removedGapIds
          ? removedGapIds.has(gap.id)
          : (gap.isEdge ? false : gap.adCandidate)
      };
    })
    .filter((gap) => gap.endY > gap.startY);

  const linkedCuts = gaps
    .filter((gap) => gap.removed && gap.cutEndY > gap.cutStartY)
    .map((gap) => ({ startY: gap.cutStartY, endY: gap.cutEndY }));

  const manualCuts = (customCuts || [])
    .filter((cut) => cut.enabled !== false)
    .map((cut) => ({
      startY: clamp(cut.startY, 0, heightPx),
      endY: clamp(cut.endY, 0, heightPx)
    }));

  const cuts = mergeRanges([...linkedCuts, ...manualCuts]);

  const groupRanges = [];
  let groupStart = 0;

  for (const cut of cuts) {
    groupRanges.push({ startY: groupStart, endY: cut.startY });
    groupStart = cut.endY;
  }

  groupRanges.push({ startY: groupStart, endY: heightPx });

  const imageBoxesPx = images.map((image) => ({
    startY: toPixel(image.top),
    endY: toPixel(image.bottom)
  }));

  const groups = groupRanges
    .filter((range) => range.endY > range.startY)
    .map((range) => ({
      startY: range.startY,
      endY: range.endY,
      imageCount: imageBoxesPx.filter((box) => {
        const center = (box.startY + box.endY) / 2;
        return center >= range.startY && center < range.endY;
      }).length
    }));

  return {
    gaps,
    groups,
    cuts,
    imageBoxes: imageBoxesPx,
    imageCount: images.length,
    separatorCount: separators.length
  };
}

// 決定本批次的結束位置。
//
// 優先在「完整落在截圖範圍內」的間隔處結束，避免在文字或圖片中間切斷。
// 若是廣告間隔，結束於廣告開始處，下一批從廣告結束處開始；一般間隔則取中點。
// 找不到合適的間隔時（forced = true），才以截圖範圍的底部為結束點。
// 若已到達頁面底部（reachedBottom），則輸出全部內容。
function chooseBatchEnd({ layouts, originScrollY, capturedBottomPage, reachedBottom }) {
  if (reachedBottom) {
    return { endPage: capturedBottomPage, nextStartPage: null, forced: false };
  }

  const { gaps } = collectLayoutGaps({
    layouts,
    pageTop: originScrollY,
    pageBottom: capturedBottomPage
  });

  const span = capturedBottomPage - originScrollY;

  // 依序放寬條件：先要求落在後半段，找不到再放寬到任意位置。
  for (const fraction of [0.5, 0.2, 0]) {
    const minTop = originScrollY + span * fraction;

    const candidates = gaps.filter(
      (gap) => gap.top >= minTop && gap.bottom <= capturedBottomPage
    );

    if (candidates.length > 0) {
      const gap = candidates[candidates.length - 1];

      if (gap.adCandidate) {
        return {
          endPage: gap.cutTop,
          nextStartPage: gap.cutBottom,
          forced: false
        };
      }

      return {
        endPage: (gap.top + gap.bottom) / 2,
        nextStartPage: gap.bottom,
        forced: false
      };
    }
  }

  return {
    endPage: capturedBottomPage,
    nextStartPage: capturedBottomPage,
    forced: true
  };
}

// 將各組長圖切成不超過 maxPx 的段落。切點優先選在保留的間隔中點。
// forced = true 表示該段範圍內找不到間隔，只能在長度上限處切開。
function splitIntoParts({ groups, keptGaps, maxPx }) {
  const parts = [];

  for (const group of groups) {
    const candidates = keptGaps
      .map((gap) => Math.round((gap.startY + gap.endY) / 2))
      .filter((cut) => cut > group.startY && cut < group.endY)
      .sort((a, b) => a - b);

    let start = group.startY;

    while (group.endY - start > maxPx) {
      const lower = start + maxPx * 0.4;
      const upper = start + maxPx;

      const inRange = candidates.filter((cut) => cut > lower && cut <= upper);
      const cut = inRange.length > 0 ? inRange[inRange.length - 1] : upper;

      parts.push({
        startY: start,
        endY: cut,
        forced: inRange.length === 0
      });

      start = cut;
    }

    parts.push({
      startY: start,
      endY: group.endY,
      forced: false
    });
  }

  return parts;
}

// ---- 載入流程 ----

async function loadScreenshot() {
  try {
    const result = await chrome.storage.local.get([
      "pendingCapture",
      "pendingStitchJob",
      SESSION_KEY
    ]);

    currentSession = result[SESSION_KEY] || null;

    let capture = result.pendingCapture;

    if (result.pendingStitchJob) {
      status.textContent = "正在拼接長圖……";

      const built = await createStitchedCanvas(result.pendingStitchJob);

      const reachedBottom = currentSession?.done === true;

      const end = chooseBatchEnd({
        layouts: built.layouts,
        originScrollY: built.originScrollY,
        capturedBottomPage: built.capturedBottomPage,
        reachedBottom
      });

      const endPx = clamp(
        Math.round((end.endPage - built.originScrollY) * built.scale),
        1,
        built.canvas.height
      );

      const trim = computeHorizontalTrim(
        built.layouts,
        built.pxPerCssX,
        built.canvas.width
      );

      stitchTrimmed = trim.x > 0 || trim.width < built.canvas.width;

      const outputCanvas = cropCanvas(built.canvas, {
        x: trim.x,
        width: trim.width,
        height: endPx
      });
      const blob = await canvasToBlob(outputCanvas);

      stitchedObjectUrl = URL.createObjectURL(blob);

      stitchLayout = {
        layouts: built.layouts,
        originScrollY: built.originScrollY,
        scale: built.scale
      };

      stitchInfo = {
        frameCount: built.frameCount,
        gapCount: built.gapCount,
        hiddenCount: currentSession?.hiddenCount ?? 0,
        loadTimeouts: currentSession?.loadTimeouts ?? 0,
        batchIndex: currentSession?.batchIndex ?? 1,
        reachedBottom,
        forcedEnd: end.forced
      };

      // 記錄下一批的起點，供「繼續截圖」使用。
      if (currentSession) {
        currentSession.nextStartY = reachedBottom ? null : end.nextStartPage;
        await chrome.storage.local.set({ [SESSION_KEY]: currentSession });
      }

      capture = {
        screenshot: stitchedObjectUrl,
        viewportWidth: outputCanvas.width,
        viewportHeight: outputCanvas.height,
        images: []
      };
    }

    if (!capture?.screenshot) {
      status.textContent = "找不到截圖，請重新擷取。";
      resultsContainer.textContent = "目前沒有偵測結果。";
      return;
    }

    image.onload = async () => {
      try {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;

        loaded = true;

        if (stitchLayout) {
          stitchMode = true;
          applyMode();

          const initial = computeStitchGroups({
            ...stitchLayout,
            heightPx: canvas.height
          });

          cutOverrides = new Map();
          customCuts = [];

          removedGapIds = new Set(
            initial.gaps.filter((gap) => gap.removed).map((gap) => gap.id)
          );

          recomputeStitch();

          drawCanvas();
          await renderStitchGroups();

          status.textContent = buildStitchStatus();
        } else {
          stitchMode = false;
          applyMode();

          detectedImages = buildDetections(capture, canvas.width, canvas.height);

          drawCanvas();
          await renderResults();

          status.textContent =
            `截圖尺寸：${canvas.width} × ${canvas.height}；` +
            `偵測到 ${detectedImages.length} 張圖片。` +
            (capture.aligned === false
              ? "注意：網頁在截圖時持續捲動，偵測框可能有些偏移，請確認後再下載。"
              : "");
        }

        saveButton.disabled = false;
        refreshControls();

        await chrome.storage.local.remove("pendingCapture");
      } catch (error) {
        console.error(error);
        status.textContent = error.message || "無法完成圖片預覽。";
      }
    };

    image.onerror = () => {
      status.textContent = "圖片載入失敗，請重新截圖。";
    };

    image.src = capture.screenshot;
  } catch (error) {
    console.error(error);
    status.textContent = error.message || "無法載入或拼接截圖。";
  }
}

// 依目前的移除設定重新計算分組、切點、段落。
function recomputeStitch() {
  const plan = computeStitchGroups({
    ...stitchLayout,
    heightPx: canvas.height,
    removedGapIds,
    cutOverrides,
    customCuts
  });

  stitchGaps = plan.gaps;
  stitchGroups = plan.groups;
  stitchCuts = plan.cuts;
  stitchImageBoxes = plan.imageBoxes;
  stitchCutWarning = stitchCuts.some((cut) =>
    stitchImageBoxes.some((box) => cut.startY < box.endY && cut.endY > box.startY)
  );

  const keptGaps = stitchGaps.filter((gap) => !gap.removed);

  stitchParts = splitIntoParts({
    groups: stitchGroups,
    keptGaps,
    maxPx: MAX_PART_PX
  });

  stitchInfo.imageCount = plan.imageCount;
  stitchInfo.separatorCount = plan.separatorCount;
}

function buildStitchStatus() {
  const adGapCount = stitchGaps.filter((gap) => gap.adCandidate).length;
  const forcedParts = stitchParts.filter((part) => part.forced).length;

  const parts = [
    `第 ${stitchInfo.batchIndex} 批`,
    `長圖尺寸 ${canvas.width} × ${canvas.height}px`,
    `拼接 ${stitchInfo.frameCount} 段截圖`,
    `偵測到 ${stitchInfo.imageCount} 張圖片、` +
      `${stitchInfo.separatorCount} 個廣告候選、` +
      `${stitchGaps.length} 處間隔（其中 ${adGapCount} 處含廣告）`
  ];

  if (stitchCuts.length > 0) {
    parts.push(`移除 ${stitchCuts.length} 處，分為 ${stitchGroups.length} 組`);
  } else {
    parts.push("未移除任何間隔");
  }

  parts.push(`共 ${stitchParts.length} 段輸出`);

  if (stitchTrimmed) {
    parts.push("已去除左右空白");
  }

  if (stitchInfo.hiddenCount > 0) {
    parts.push(`已暫時隱藏 ${stitchInfo.hiddenCount} 個固定元素（已還原）`);
  }

  let text = parts.join("，") + "。";

  if (stitchInfo.reachedBottom) {
    text += "已擷取到頁面底部，這是最後一批。";
  } else if (currentSession?.nextStartY != null) {
    text += "尚未到頁面底部。下載完成後，可按「繼續截圖」擷取下一批。";
  }

  if (stitchCutWarning) {
    text += `注意：${CUT_WARNING_TEXT}，請確認。`;
  }

  if ((stitchInfo.loadTimeouts || 0) > 0) {
    text += `注意：有 ${stitchInfo.loadTimeouts} 次等待圖片載入逾時，部分圖片可能尚未完整載入。`;
  }

  if (stitchInfo.forcedEnd) {
    text += "注意：本批在找不到分隔處的情況下結束，結尾可能落在內容中間。";
  }

  if (forcedParts > 0) {
    text += `注意：有 ${forcedParts} 段找不到可切的間隔，已在長度上限處切開。`;
  }

  if (stitchInfo.gapCount > 0) {
    text += `注意：有 ${stitchInfo.gapCount} 處捲動距離超過視窗高度，接縫處可能缺漏。`;
  }

  return text;
}

function applyMode() {
  modeBadge.textContent = stitchMode ? "長條截圖" : "單張截圖";

  // 還原按鈕的名稱與提示隨模式改變，讓使用者知道會還原什麼。
  resetAllButton.textContent = stitchMode ? "還原移除區域" : "還原偵測框";
  resetAllButton.title = stitchMode
    ? "把拖曳過的移除區域恢復為自動偵測的結果，並刪除手動新增的區域"
    : "把所有偵測框還原到自動偵測時的位置，並清除手動選取";
  imageBatchControls.hidden = stitchMode;
  stitchBatchControls.hidden = !stitchMode;
  sessionControls.hidden = !stitchMode;

  if (stitchMode) {
    resultsTitle.textContent = "長圖段落結果";
    resultsInstruction.textContent =
      "紅色區域為會被移除的廣告間隔，黃色虛線為保留的間隔。" +
      "點擊預覽區的間隔，或在下方勾選，即可切換移除與保留。" +
      "紫色標記為段落起點，段落的結束點會優先落在分隔處。";
  } else {
    resultsTitle.textContent = "自動偵測結果";
    resultsInstruction.textContent =
      "圖片依網頁由上到下、由左到右排序，預設全部勾選。" +
      "可以單獨下載，或勾選後批次下載；若瀏覽器詢問是否允許下載多個檔案，請選擇允許。" +
      "只會偵測目前畫面可見的圖片部分。";
  }
}

// ---- 畫布繪製 ----

function drawCanvas() {
  if (!loaded) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);

  if (stitchMode) {
    drawStitchOverlay();
  } else {
    drawDetectionBoxes();
  }

  if (selection) {
    const { x, y, width, height } = selection;

    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.drawImage(image, 0, 0);
    ctx.restore();

    ctx.strokeStyle = "#00a8ff";
    ctx.lineWidth = Math.max(2, Math.round(canvas.width / 800));
    ctx.strokeRect(x, y, width, height);
  }

  if (!stitchMode) {
    if (selection && selection.width > 0 && selection.height > 0) {
      drawEditHandles(selection, "#00a8ff");
    }

    const active = detectedImages.find((item) => item.id === activeItemId);

    if (active) {
      ctx.save();
      ctx.strokeStyle = DETECTED_COLOR;
      ctx.lineWidth = Math.max(3, Math.round(canvas.width / 600));
      ctx.strokeRect(active.x, active.y, active.width, active.height);
      ctx.restore();

      drawEditHandles(active, DETECTED_COLOR);
    }
  }
}

function drawDetectionBoxes() {
  detectedImages.forEach((item) => {
    const color = item.selected ? DETECTED_COLOR : UNSELECTED_COLOR;

    ctx.save();

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, Math.round(canvas.width / 1000));
    ctx.strokeRect(item.x, item.y, item.width, item.height);

    ctx.fillStyle = color;
    ctx.font = `${Math.max(14, Math.round(canvas.width / 100))}px sans-serif`;
    ctx.fillText(
      String(item.id),
      item.x + 4,
      item.y + Math.max(16, Math.round(canvas.width / 100))
    );

    ctx.restore();
  });
}

function drawStitchOverlay() {
  const labelSize = Math.max(14, Math.round(canvas.width / 80));
  // 拖曳拉條以 CSS 像素計算，縮放後仍然清楚可見，位於邊線中央。
  const pxPerCss = canvasPxPerCssPx();
  const barLength = Math.max(24, Math.round(60 * pxPerCss));
  const barThickness = Math.max(6, Math.round(8 * pxPerCss));

  const drawHandles = (startY, endY, color) => {
    const x = Math.round((canvas.width - barLength) / 2);

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(2, Math.round(2 * pxPerCss));
    ctx.fillRect(x, startY - barThickness / 2, barLength, barThickness);
    ctx.strokeRect(x, startY - barThickness / 2, barLength, barThickness);
    ctx.fillRect(x, endY - barThickness / 2, barLength, barThickness);
    ctx.strokeRect(x, endY - barThickness / 2, barLength, barThickness);
    ctx.restore();
  };

  stitchGaps.forEach((gap) => {
    const label = gapLabelById(gap.id);

    if (gap.removed) {
      if (gap.cutEndY > gap.cutStartY) {
        ctx.fillStyle = CUT_COLOR;
        ctx.fillRect(0, gap.cutStartY, canvas.width, gap.cutEndY - gap.cutStartY);
        drawHandles(gap.cutStartY, gap.cutEndY, "#b91c1c");
      }

      ctx.fillStyle = "#b91c1c";
      ctx.font = `${labelSize}px sans-serif`;
      ctx.fillText(`${label}：移除`, 8, gap.cutStartY + labelSize + 4);
    } else {
      ctx.save();
      ctx.strokeStyle = GAP_COLOR;
      ctx.lineWidth = Math.max(2, Math.round(canvas.width / 800));
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(1, gap.startY + 1, canvas.width - 2, gap.endY - gap.startY - 2);
      ctx.restore();

      ctx.fillStyle = GAP_COLOR;
      ctx.font = `${labelSize}px sans-serif`;
      ctx.fillText(`${label}：保留`, 8, gap.startY + labelSize + 4);
    }
  });

  customCuts.forEach((cut, index) => {
    if (cut.endY <= cut.startY) return;

    if (cut.enabled === false) {
      ctx.save();
      ctx.strokeStyle = "#6d28d9";
      ctx.lineWidth = Math.max(2, Math.round(canvas.width / 800));
      ctx.setLineDash([10, 6]);
      ctx.strokeRect(1, cut.startY + 1, canvas.width - 2, cut.endY - cut.startY - 2);
      ctx.restore();

      ctx.fillStyle = "#6d28d9";
      ctx.font = `${labelSize}px sans-serif`;
      ctx.fillText(`自訂 ${index + 1}：停用`, 8, cut.startY + labelSize + 4);
      return;
    }

    ctx.fillStyle = CUSTOM_CUT_COLOR;
    ctx.fillRect(0, cut.startY, canvas.width, cut.endY - cut.startY);
    drawHandles(cut.startY, cut.endY, "#6d28d9");

    ctx.fillStyle = "#6d28d9";
    ctx.font = `${labelSize}px sans-serif`;
    ctx.fillText(`自訂 ${index + 1}：移除`, 8, cut.startY + labelSize + 4);
  });

  stitchGroups.forEach((group, index) => {
    const lineWidth = Math.max(3, Math.round(canvas.width / 600));

    ctx.fillStyle = GROUP_COLOR;
    ctx.fillRect(0, group.startY, canvas.width, lineWidth);

    ctx.font = `${labelSize}px sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(`第 ${index + 1} 組`, canvas.width - 8, group.startY + lineWidth + labelSize + 2);
    ctx.textAlign = "left";
  });

  stitchParts.forEach((part, index) => {
    if (index === 0) return;

    const lineWidth = Math.max(2, Math.round(canvas.width / 900));

    ctx.fillStyle = PART_COLOR;
    ctx.fillRect(0, part.startY, canvas.width, lineWidth);
  });
}

// ---- 手動框選與座標 ----

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();

  const x = (event.clientX - rect.left) * canvas.width / rect.width;
  const y = (event.clientY - rect.top) * canvas.height / rect.height;

  return {
    x: clamp(x, 0, canvas.width),
    y: clamp(y, 0, canvas.height)
  };
}

function makeSelection(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.abs(end.x - start.x)),
    height: Math.round(Math.abs(end.y - start.y))
  };
}

// ---- 輸出 ----

function cropImage(rect) {
  const outputCanvas = document.createElement("canvas");

  outputCanvas.width = rect.width;
  outputCanvas.height = rect.height;

  outputCanvas.getContext("2d").drawImage(
    image,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height
  );

  return canvasToBlob(outputCanvas);
}

function canvasToBlob(targetCanvas) {
  return new Promise((resolve, reject) => {
    targetCanvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("無法產生圖片。"));
      }
    }, "image/png");
  });
}

// 裁切 Canvas 的指定範圍：x 為左側起點，width／height 為輸出尺寸。
function cropCanvas(source, { x = 0, width = source.width, height = source.height }) {
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;

  output.getContext("2d").drawImage(
    source,
    x,
    0,
    width,
    height,
    0,
    0,
    width,
    height
  );

  return output;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadCrop(rect, filename) {
  const blob = await cropImage(rect);
  triggerDownload(blob, filename);
}

function revokePreviewUrls() {
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls = [];
}

// ---- 單張模式 ----

async function renderResults() {
  const generation = ++renderGeneration;

  revokePreviewUrls();
  resultsContainer.replaceChildren();

  if (detectedImages.length === 0) {
    const message = document.createElement("p");
    message.textContent = "沒有找到符合條件的圖片。你仍然可以使用手動框選。";
    resultsContainer.appendChild(message);
    return;
  }

  for (const item of detectedImages) {
    const card = document.createElement("article");
    card.className = "resultCard";

    const heading = document.createElement("h3");
    heading.textContent = item.alt
      ? `圖片 ${item.id}：${item.alt}`
      : `圖片 ${item.id}`;

    const preview = document.createElement("img");
    preview.alt = `圖片 ${item.id} 的裁切預覽`;
    preview.loading = "lazy";

    const dimensions = document.createElement("p");
    dimensions.textContent = `裁切尺寸：${item.width} × ${item.height}px`;

    const selectLabel = document.createElement("label");
    selectLabel.className = "selectRow";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.selected;

    checkbox.addEventListener("change", () => {
      item.selected = checkbox.checked;
      drawCanvas();
      refreshControls();
    });

    selectLabel.append(checkbox, " 加入批次下載");

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.textContent = "下載這張圖片";

    downloadButton.addEventListener("click", async () => {
      downloadButton.disabled = true;
      downloadButton.textContent = "正在產生圖片……";

      try {
        await downloadCrop(item, imageFilename(item.id));
        status.textContent = `已下載 ${imageFilename(item.id)}。`;
      } catch (error) {
        console.error(error);
        status.textContent = error.message || `圖片 ${item.id} 下載失敗。`;
      } finally {
        downloadButton.disabled = false;
        downloadButton.textContent = "下載這張圖片";
      }
    });

    card.append(heading, preview, dimensions, selectLabel, downloadButton);
    resultsContainer.appendChild(card);

    try {
      const blob = await cropImage(item);

      if (generation !== renderGeneration) return;

      const url = URL.createObjectURL(blob);

      previewUrls.push(url);
      preview.src = url;
    } catch (error) {
      if (generation !== renderGeneration) return;

      console.error("預覽產生失敗：", error);
      preview.alt = "無法產生預覽";
    }
  }
}

function setAllSelected(value) {
  detectedImages.forEach((item) => {
    item.selected = value;
  });

  document
    .querySelectorAll(".resultCard input[type='checkbox']")
    .forEach((checkbox) => {
      checkbox.checked = value;
    });

  drawCanvas();
  refreshControls();
}

selectAllButton.addEventListener("click", () => setAllSelected(true));
deselectAllButton.addEventListener("click", () => setAllSelected(false));

downloadSelectedButton.addEventListener("click", async () => {
  const targets = detectedImages.filter((item) => item.selected);

  if (targets.length === 0) {
    status.textContent = "請先勾選至少一張圖片。";
    return;
  }

  busy = true;
  refreshControls();

  let failedCount = 0;

  try {
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];

      status.textContent = `正在下載第 ${i + 1} ／ ${targets.length} 張……`;

      try {
        await downloadCrop(item, imageFilename(item.id));
      } catch (error) {
        failedCount++;
        console.error(`圖片 ${item.id} 下載失敗：`, error);
      }

      await wait(300);
    }

    status.textContent = failedCount === 0
      ? `已下載 ${targets.length} 張圖片。`
      : `已下載 ${targets.length - failedCount} 張，${failedCount} 張失敗，請重試。`;
  } finally {
    busy = false;
    refreshControls();
  }
});

// ---- 長圖模式 ----

function gapLabelById(id) {
  if (id === "top") return "頂部區域";
  if (id === "bottom") return "底部區域";
  return `間隔 ${id}`;
}

function toggleGap(gapId) {
  if (removedGapIds.has(gapId)) {
    removedGapIds.delete(gapId);
  } else {
    removedGapIds.add(gapId);
  }

  recomputeStitch();
  drawCanvas();
  renderStitchGroups();

  status.textContent =
    `${gapLabelById(gapId)} 已${removedGapIds.has(gapId) ? "移除" : "保留"}。` +
    `目前共移除 ${stitchCuts.length} 處，分為 ${stitchParts.length} 段輸出。`;
}

async function renderStitchGroups() {
  const generation = ++renderGeneration;

  revokePreviewUrls();
  resultsContainer.replaceChildren();
  cutListContainer.replaceChildren();

  if (stitchGaps.length > 0) {
    const panel = document.createElement("div");
    panel.className = "gapPanel";

    const title = document.createElement("h3");
    title.textContent = "移除區域（圖片之間的間隔）";
    panel.appendChild(title);

    for (const gap of stitchGaps) {
      const row = document.createElement("label");
      row.className = "selectRow";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = gap.removed;
      checkbox.addEventListener("change", () => toggleGap(gap.id));

      const height = gap.endY - gap.startY;
      const detail = gap.adCandidate ? "偵測到廣告" : "未偵測到廣告";

      checkbox.title = "勾選＝移除此區域；取消勾選＝保留";
      row.title = checkbox.title;

      row.append(checkbox, ` ${gapLabelById(gap.id)}（${height}px，${detail}）`);
      panel.appendChild(row);
    }

    cutListContainer.appendChild(panel);
  }

  if (customCuts.length > 0) {
    const customPanel = document.createElement("div");
    customPanel.className = "gapPanel";

    const customTitle = document.createElement("h3");
    customTitle.textContent = "手動新增的移除區域";
    customPanel.appendChild(customTitle);

    customCuts.forEach((cut, index) => {
      const row = document.createElement("label");
      row.className = "selectRow";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = cut.enabled !== false;

      checkbox.addEventListener("change", () => {
        cut.enabled = checkbox.checked;
        recomputeStitch();
        drawCanvas();
        renderStitchGroups();
      });

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "刪除";

      removeButton.addEventListener("click", (event) => {
        event.preventDefault();
        customCuts.splice(index, 1);
        recomputeStitch();
        drawCanvas();
        renderStitchGroups();
      });

      checkbox.title = "勾選＝啟用移除；取消勾選＝暫時停用";

      row.append(checkbox, ` 自訂 ${index + 1}（${cut.endY - cut.startY}px）`, removeButton);
      customPanel.appendChild(row);
    });

    cutListContainer.appendChild(customPanel);
  }

  if (stitchParts.length === 0) {
    const message = document.createElement("p");
    message.textContent = "沒有可輸出的段落。";
    resultsContainer.appendChild(message);
    refreshControls();
    return;
  }

  const batchIndex = stitchInfo.batchIndex;

  for (const [index, part] of stitchParts.entries()) {
    const number = index + 1;
    const rect = {
      x: 0,
      y: part.startY,
      width: canvas.width,
      height: part.endY - part.startY
    };

    const card = document.createElement("article");
    card.className = "resultCard";

    const heading = document.createElement("h3");
    heading.textContent = `第 ${number} 段`;

    const preview = document.createElement("img");
    preview.alt = `第 ${number} 段的長圖預覽`;
    preview.loading = "lazy";

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

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.textContent = "下載此段長圖";

    downloadButton.addEventListener("click", async () => {
      downloadButton.disabled = true;
      downloadButton.textContent = "正在產生圖片……";

      try {
        await downloadCrop(rect, longFilename(batchIndex, number));
        status.textContent = `已下載 ${longFilename(batchIndex, number)}。`;
      } catch (error) {
        console.error(error);
        status.textContent = error.message || `第 ${number} 段下載失敗。`;
      } finally {
        downloadButton.disabled = false;
        downloadButton.textContent = "下載此段長圖";
      }
    });

    card.appendChild(downloadButton);
    resultsContainer.appendChild(card);

    try {
      const blob = await cropImage(rect);

      if (generation !== renderGeneration) return;

      const url = URL.createObjectURL(blob);

      previewUrls.push(url);
      preview.src = url;
    } catch (error) {
      if (generation !== renderGeneration) return;

      console.error("預覽產生失敗：", error);
      preview.alt = "無法產生預覽";
    }
  }

  refreshControls();
}

downloadAllGroupsButton.addEventListener("click", async () => {
  if (stitchParts.length === 0) return;

  busy = true;
  refreshControls();

  let failedCount = 0;
  const batchIndex = stitchInfo.batchIndex;

  try {
    for (const [index, part] of stitchParts.entries()) {
      status.textContent =
        `正在下載第 ${index + 1} ／ ${stitchParts.length} 段……`;

      try {
        await downloadCrop(
          {
            x: 0,
            y: part.startY,
            width: canvas.width,
            height: part.endY - part.startY
          },
          longFilename(batchIndex, index + 1)
        );
      } catch (error) {
        failedCount++;
        console.error(`第 ${index + 1} 段下載失敗：`, error);
      }

      await wait(300);
    }

    status.textContent = failedCount === 0
      ? `已下載 ${stitchParts.length} 段長圖。`
      : `已下載 ${stitchParts.length - failedCount} 段，${failedCount} 段失敗，請重試。`;
  } finally {
    busy = false;
    refreshControls();
  }
});

mergeDownloadButton.addEventListener("click", async () => {
  if (stitchGroups.length === 0) return;

  busy = true;
  refreshControls();

  try {
    status.textContent = "正在合併長圖……";

    const totalHeight = stitchGroups.reduce(
      (sum, group) => sum + (group.endY - group.startY),
      0
    );

    const mergedCanvas = document.createElement("canvas");
    mergedCanvas.width = canvas.width;
    mergedCanvas.height = totalHeight;

    const mergedCtx = mergedCanvas.getContext("2d");

    if (!mergedCtx) {
      throw new Error("無法建立合併畫布。");
    }

    let destinationY = 0;

    for (const group of stitchGroups) {
      const sourceHeight = group.endY - group.startY;

      mergedCtx.drawImage(
        image,
        0,
        group.startY,
        canvas.width,
        sourceHeight,
        0,
        destinationY,
        canvas.width,
        sourceHeight
      );

      destinationY += sourceHeight;
    }

    const blob = await canvasToBlob(mergedCanvas);
    triggerDownload(blob, `long_b${stitchInfo.batchIndex}_merged_${Date.now()}.png`);

    status.textContent =
      `已合併下載一整條長圖（${canvas.width} × ${totalHeight}px），` +
      `已移除 ${stitchCuts.length} 處間隔。`;
  } catch (error) {
    console.error(error);
    status.textContent = error.message || "合併下載失敗。";
  } finally {
    busy = false;
    refreshControls();
  }
});

// 繼續截圖：由背景切回目標頁面擷取下一批，完成後背景會重新整理本頁。
continueButton.addEventListener("click", async () => {
  busy = true;
  refreshControls();
  status.textContent = "正在切回目標頁面，繼續截圖中，請勿操作目標分頁……";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "CONTINUE_STITCH"
    });

    if (!response?.ok) {
      throw new Error(response?.error || "繼續截圖失敗。");
    }
  } catch (error) {
    console.error(error);
    status.textContent = error.message || "繼續截圖失敗。";
    busy = false;
    refreshControls();
  }
});

// 完成：清除本次截圖的所有暫存。
finishButton.addEventListener("click", async () => {
  busy = true;
  refreshControls();

  try {
    const jobId = currentSession?.jobId;

    await chrome.storage.local.remove([SESSION_KEY, "pendingStitchJob"]);

    if (jobId) {
      await removeStitchFrames(jobId);
    }

    currentSession = null;
    status.textContent = "已完成並清除截圖暫存。之後可以再開始新的長圖擷取。";
  } catch (error) {
    console.error(error);
    status.textContent = error.message || "清除暫存失敗。";
  } finally {
    busy = false;
    refreshControls();
  }
});

function refreshControls() {
  const selectedCount = detectedImages.filter((item) => item.selected).length;
  const hasImages = detectedImages.length > 0;

  downloadSelectedButton.textContent = `下載選取的圖片（${selectedCount}）`;
  downloadSelectedButton.disabled = busy || !loaded || selectedCount === 0;

  selectAllButton.disabled = busy || !hasImages;
  deselectAllButton.disabled = busy || !hasImages;

  downloadAllGroupsButton.textContent = `下載全部段落（${stitchParts.length}）`;
  downloadAllGroupsButton.disabled = busy || !loaded || stitchParts.length === 0;

  mergeDownloadButton.textContent =
    `合併成一張長圖下載`;
  mergeDownloadButton.disabled = busy || !loaded || stitchGroups.length === 0;

  const hasNextBatch =
    currentSession !== null &&
    currentSession.done !== true &&
    currentSession.nextStartY != null;

  continueButton.textContent = hasNextBatch
    ? `繼續截圖（第 ${(currentSession.batchIndex || 1) + 1} 批）`
    : "已擷取到頁面底部";
  continueButton.disabled = busy || !hasNextBatch;

  finishButton.disabled = busy || currentSession === null;
}

// ---- 畫布互動 ----

const HANDLE_CSS_PX = 14;
const MIN_CUT_PX = 4;

function canvasPxPerCssPx() {
  const rect = canvas.getBoundingClientRect();
  return rect.height > 0 ? canvas.height / rect.height : 1;
}

// 判斷滑鼠位置是否在某個移除框的上緣、下緣或內部。
// 邊線的觸發範圍可能互相重疊（框很薄或畫面縮小時），因此選擇距離最近的一條邊。
function hitTestCut(point) {
  const threshold = HANDLE_CSS_PX * canvasPxPerCssPx();
  const entries = [];

  for (const gap of stitchGaps) {
    if (gap.removed && gap.cutEndY > gap.cutStartY) {
      entries.push({
        kind: "gap",
        id: gap.id,
        startY: gap.cutStartY,
        endY: gap.cutEndY,
        bounds: { startY: 0, endY: canvas.height }
      });
    }
  }

  customCuts.forEach((cut, index) => {
    if (cut.endY > cut.startY) {
      entries.push({
        kind: "custom",
        index,
        startY: cut.startY,
        endY: cut.endY,
        bounds: { startY: 0, endY: canvas.height }
      });
    }
  });

  // 第一步：找出所有在觸發範圍內的邊線，取距離最近者。
  let nearest = null;

  for (const entry of entries) {
    const candidates = [
      { mode: "top", distance: Math.abs(point.y - entry.startY) },
      { mode: "bottom", distance: Math.abs(point.y - entry.endY) }
    ];

    for (const candidate of candidates) {
      if (candidate.distance > threshold) continue;

      if (!nearest || candidate.distance < nearest.distance) {
        nearest = { ...entry, mode: candidate.mode, distance: candidate.distance };
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

// 依拖曳距離更新移除範圍，並限制在可用範圍內。
function applyCutDrag(point) {
  const { hit, origin, startPointY } = dragCut;
  const dy = point.y - startPointY;

  let startY = origin.startY;
  let endY = origin.endY;

  if (hit.mode === "top") {
    startY = clamp(origin.startY + dy, hit.bounds.startY, endY - MIN_CUT_PX);
  } else if (hit.mode === "bottom") {
    endY = clamp(origin.endY + dy, startY + MIN_CUT_PX, hit.bounds.endY);
  } else {
    const length = origin.endY - origin.startY;

    startY = clamp(
      origin.startY + dy,
      hit.bounds.startY,
      hit.bounds.endY - length
    );
    endY = startY + length;
  }

  const rounded = { startY: Math.round(startY), endY: Math.round(endY) };

  if (hit.kind === "gap") {
    cutOverrides.set(hit.id, rounded);
  } else {
    customCuts[hit.index] = { ...rounded, enabled: customCuts[hit.index].enabled };
  }
}

function updateAddCutButton() {
  addCutButton.textContent = addCutMode ? "完成新增" : "手動新增移除區域";
  addCutButton.setAttribute("aria-pressed", String(addCutMode));
}

// ---- 單張模式：拖曳調整截取框（類似 Photoshop 的選取框） ----

const EDIT_MIN_PX = 4;
// 只保留四邊的控制點，與長圖移除框一致：拖曳邊即可增減範圍，框內拖曳則整體移動。
const HANDLE_NAMES = ["n", "e", "s", "w"];

const HANDLE_CURSORS = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  move: "move"
};

// 四個控制點：上、右、下、左四邊的中點。
function handlePositions(rect) {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  return {
    n: { x: centerX, y: rect.y },
    e: { x: right, y: centerY },
    s: { x: centerX, y: bottom },
    w: { x: rect.x, y: centerY }
  };
}

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

// 所有可編輯的框：手動選取範圍與偵測到的圖片框。
function editableTargets() {
  const targets = [];

  if (selection && selection.width > 0 && selection.height > 0) {
    targets.push({ kind: "selection", rect: selection, active: true });
  }

  detectedImages.forEach((item) => {
    targets.push({
      kind: "detected",
      item,
      rect: item,
      active: item.id === activeItemId
    });
  });

  return targets;
}

// 只判斷邊線（控制點）。框內部不會觸發移動，只會選取該框。
function hitTestEditable(point) {
  const threshold = HANDLE_CSS_PX * canvasPxPerCssPx();

  for (const target of editableTargets()) {
    if (!target.active) continue;

    const handle = hitTestHandle(target.rect, point, threshold);

    if (handle) {
      return { ...target, mode: handle };
    }
  }

  return null;
}

// 找出包含該點的偵測框（面積較小者優先），用於點選時選取該框。
function findBoxAt(point) {
  let best = null;

  for (const item of detectedImages) {
    if (!isInsideRect(item, point)) continue;

    const area = item.width * item.height;

    if (!best || area < best.area) {
      best = { item, area };
    }
  }

  return best ? best.item : null;
}

function beginEdit(hit, point) {
  if (hit.kind === "detected") {
    activeItemId = hit.item.id;
  }

  editDrag = {
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

  drawCanvas();
}

// 依拖曳距離計算新的範圍。控制點決定拖曳哪些邊。
function applyEdit(point) {
  const origin = editDrag.origin;
  const dx = point.x - editDrag.startPoint.x;
  const dy = point.y - editDrag.startPoint.y;
  const mode = editDrag.mode;

  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;

  if (mode === "w") {
    left = clamp(origin.x + dx, 0, right - EDIT_MIN_PX);
  } else if (mode === "e") {
    right = clamp(right + dx, left + EDIT_MIN_PX, canvas.width);
  } else if (mode === "n") {
    top = clamp(origin.y + dy, 0, bottom - EDIT_MIN_PX);
  } else if (mode === "s") {
    bottom = clamp(bottom + dy, top + EDIT_MIN_PX, canvas.height);
  }

  let rect = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };

  rect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };

  if (editDrag.item) {
    Object.assign(editDrag.item, rect);
  } else {
    selection = rect;
  }

  if (Math.abs(dx) + Math.abs(dy) > 1) {
    editDrag.moved = true;
  }

  status.textContent = `調整中：${rect.width} × ${rect.height}px`;
}

function finishEdit() {
  const drag = editDrag;
  editDrag = null;

  if (drag.kind === "detected") {
    const item = drag.item;

    if (drag.moved) {
      // 偵測框的預覽與尺寸需要更新，重新產生卡片。
      renderResults();
      status.textContent =
        `已調整圖片 ${item.id} 的範圍（${item.width} × ${item.height}px）。`;
    } else {
      status.textContent = `已選取圖片 ${item.id}。`;
    }
  } else if (drag.moved) {
    status.textContent =
      `已調整手動選取範圍（${selection.width} × ${selection.height}px）。`;
  }

  drawCanvas();
}

// 在作用中的框的四條邊中央畫出粗色拉條，顯示可以拖曳的位置。
// 尺寸以 CSS 像素計算，不論截圖解析度多高都能清楚看見、容易點到。
function drawEditHandles(rect, color) {
  const pxPerCss = canvasPxPerCssPx();
  const thickness = Math.max(6, Math.round(8 * pxPerCss));
  const maxBarLength = Math.max(24, Math.round(60 * pxPerCss));

  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  const horizontalLength = Math.min(
    maxBarLength,
    Math.max(thickness * 2, rect.width * 0.5)
  );
  const verticalLength = Math.min(
    maxBarLength,
    Math.max(thickness * 2, rect.height * 0.5)
  );

  const bars = {
    n: {
      x: centerX - horizontalLength / 2,
      y: rect.y - thickness / 2,
      w: horizontalLength,
      h: thickness
    },
    s: {
      x: centerX - horizontalLength / 2,
      y: bottom - thickness / 2,
      w: horizontalLength,
      h: thickness
    },
    w: {
      x: rect.x - thickness / 2,
      y: centerY - verticalLength / 2,
      w: thickness,
      h: verticalLength
    },
    e: {
      x: right - thickness / 2,
      y: centerY - verticalLength / 2,
      w: thickness,
      h: verticalLength
    }
  };

  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(2, Math.round(2 * pxPerCss));

  for (const name of HANDLE_NAMES) {
    const bar = bars[name];

    ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    ctx.strokeRect(bar.x, bar.y, bar.w, bar.h);
  }

  ctx.restore();
}

canvas.addEventListener("pointerdown", (event) => {
  if (!loaded) return;

  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);

  pointerDownClient = { x: event.clientX, y: event.clientY };
  const point = getCanvasPoint(event);

  // 新增移除框模式：拖曳出一個新的範圍。
  if (stitchMode && addCutMode) {
    customCuts.push({ startY: point.y, endY: point.y, enabled: true });

    dragCut = {
      adding: true,
      hit: { kind: "custom", index: customCuts.length - 1, mode: "add" },
      startPointY: point.y,
      origin: { startY: point.y, endY: point.y }
    };
    return;
  }

  // 按在既有移除框的邊緣或內部：調整或移動。
  if (stitchMode) {
    const hit = hitTestCut(point);

    if (hit) {
      dragCut = {
        adding: false,
        hit,
        startPointY: point.y,
        origin: { startY: hit.startY, endY: hit.endY }
      };
      return;
    }
  }

  // 單張模式：點到邊線時開始拉動邊框；其他位置則選取所在的框，並可開始新的手動選取。
  if (!stitchMode) {
    const hit = hitTestEditable(point);

    if (hit) {
      beginEdit(hit, point);
      return;
    }

    const inside = findBoxAt(point);
    activeItemId = inside ? inside.id : null;
  }

  // 其他位置：原本的手動框選。
  startPoint = point;
  selection = { x: point.x, y: point.y, width: 0, height: 0 };

  isDragging = true;
  drawCanvas();
});

canvas.addEventListener("pointermove", (event) => {
  const point = getCanvasPoint(event);

  if (editDrag) {
    applyEdit(point);
    drawCanvas();
    return;
  }

  // 游標提示：控制點顯示調整方向，框內顯示可移動。
  if (!stitchMode && !isDragging) {
    const hit = hitTestEditable(point);
    canvas.style.cursor = hit ? HANDLE_CURSORS[hit.mode] : "crosshair";
  }

  if (dragCut) {
    if (dragCut.adding) {
      const cut = customCuts[dragCut.hit.index];
      cut.startY = Math.round(Math.min(dragCut.startPointY, point.y));
      cut.endY = Math.round(Math.max(dragCut.startPointY, point.y));
    } else {
      applyCutDrag(point);
    }

    recomputeStitch();
    drawCanvas();
    status.textContent = stitchCutWarning
      ? `${CUT_WARNING_TEXT}，請確認。`
      : "調整移除範圍中。";
    return;
  }

  // 游標提示：邊緣為上下調整，內部為移動。
  if (stitchMode && !isDragging) {
    const hit = addCutMode ? null : hitTestCut(point);

    canvas.style.cursor = hit
      ? (hit.mode === "move" ? "move" : "ns-resize")
      : (addCutMode ? "crosshair" : "default");
  }

  if (!isDragging || !startPoint) return;

  selection = makeSelection(startPoint, point);
  drawCanvas();

  status.textContent = `手動選取：${selection.width} × ${selection.height}px`;
});

canvas.addEventListener("pointerup", (event) => {
  const moved = pointerDownClient
    ? Math.hypot(
        event.clientX - pointerDownClient.x,
        event.clientY - pointerDownClient.y
      ) >= 5
    : false;

  pointerDownClient = null;

  if (editDrag) {
    finishEdit();
    return;
  }

  if (dragCut) {
    const drag = dragCut;
    dragCut = null;

    if (drag.adding) {
      const index = drag.hit.index;
      const cut = customCuts[index];
      const tooSmall = !cut || cut.endY - cut.startY < MIN_CUT_PX;

      if (tooSmall) {
        customCuts.splice(index, 1);
      }

      addCutMode = false;
      updateAddCutButton();

      recomputeStitch();
      drawCanvas();
      renderStitchGroups();

      status.textContent = tooSmall
        ? "移除框太小，已取消。"
        : "已新增移除框。";
      return;
    }

    // 沒有移動：點擊間隔切換移除，點擊自訂框則刪除。
    if (!moved) {
      if (drag.hit.kind === "gap") {
        toggleGap(drag.hit.id);
      } else {
        const cut = customCuts[drag.hit.index];
        cut.enabled = !(cut.enabled !== false);
        recomputeStitch();
        drawCanvas();
        renderStitchGroups();
        status.textContent = cut.enabled
          ? "已啟用自訂移除框。"
          : "已停用自訂移除框（仍保留在清單中）。";
      }
      return;
    }

    recomputeStitch();
    drawCanvas();
    renderStitchGroups();
    status.textContent = stitchCutWarning
      ? `已調整移除範圍。注意：${CUT_WARNING_TEXT}，請確認後再下載。`
      : "已調整移除範圍。";
    return;
  }

  if (!isDragging) return;

  isDragging = false;

  if (stitchMode && !moved) {
    selection = null;
    startPoint = null;

    const point = getCanvasPoint(event);
    const gap = stitchGaps.find(
      (item) => point.y >= item.startY && point.y < item.endY
    );

    if (gap) {
      toggleGap(gap.id);
    } else {
      drawCanvas();
      status.textContent = "點擊的位置不在圖片之間的間隔內。";
    }

    return;
  }

  selection = makeSelection(startPoint, getCanvasPoint(event));
  startPoint = null;

  drawCanvas();

  if (selection.width < 2 || selection.height < 2) {
    selection = null;
    drawCanvas();

    const active = detectedImages.find((item) => item.id === activeItemId);

    status.textContent = active
      ? `已選取圖片 ${active.id}。拖曳邊線可調整範圍。`
      : "選取範圍太小，請重新拖曳。";
    return;
  }

  status.textContent = `已手動選取 ${selection.width} × ${selection.height}px。`;
});

canvas.addEventListener("pointercancel", () => {
  editDrag = null;
  dragCut = null;
  isDragging = false;
  startPoint = null;
  pointerDownClient = null;
  selection = null;
  drawCanvas();
});

addCutButton.addEventListener("click", () => {
  addCutMode = !addCutMode;
  updateAddCutButton();

  status.textContent = addCutMode
    ? "請在預覽區拖曳，框出要移除的範圍。"
    : "已取消新增移除框。";
});

selectAllCutsButton.addEventListener("click", () => {
  removedGapIds = new Set(stitchGaps.map((gap) => gap.id));
  customCuts.forEach((cut) => {
    cut.enabled = true;
  });

  recomputeStitch();
  drawCanvas();
  renderStitchGroups();

  status.textContent =
    `已全選移除位置：${stitchGaps.length} 個區域、${customCuts.length} 個自訂框，` +
    `共 ${stitchCuts.length} 處移除，分為 ${stitchParts.length} 段輸出。`;
});

deselectAllCutsButton.addEventListener("click", () => {
  removedGapIds = new Set();
  customCuts.forEach((cut) => {
    cut.enabled = false;
  });

  recomputeStitch();
  drawCanvas();
  renderStitchGroups();

  status.textContent = "已取消所有移除位置（自訂框仍保留，可隨時重新啟用）。";
});

resetCutsButton.addEventListener("click", () => {
  cutOverrides = new Map();
  customCuts = [];
  addCutMode = false;
  updateAddCutButton();

  removedGapIds = new Set(
    stitchGaps
      .filter((gap) => !gap.isEdge && gap.adCandidate)
      .map((gap) => gap.id)
  );

  recomputeStitch();
  drawCanvas();
  renderStitchGroups();

  status.textContent = "已還原為預設的移除範圍。";
});

// 重置選區：還原所有偵測框到原本的位置，並清除手動選區。
resetAllButton.addEventListener("click", () => {
  // 長條模式：還原移除區域（拖曳過的範圍、手動新增的區域都會恢復為預設）。
  if (stitchMode) {
    resetCutsButton.click();
    return;
  }

  detectedImages.forEach((item) => {
    Object.assign(item, item.original);
  });

  selection = null;
  startPoint = null;
  isDragging = false;
  editDrag = null;
  activeItemId = null;

  drawCanvas();
  renderResults();

  status.textContent = "已重置所有選區，還原為偵測到的原始位置。";
});

resetButton.addEventListener("click", () => {
  selection = null;
  startPoint = null;
  isDragging = false;

  drawCanvas();
  status.textContent = "已重設手動選取框。";
});

saveButton.addEventListener("click", async () => {
  if (!loaded || !selection) {
    status.textContent = "請先在截圖上手動選取範圍。";
    return;
  }

  saveButton.disabled = true;

  try {
    await downloadCrop(selection, `manual_capture_${Date.now()}.png`);
    status.textContent = "已產生手動裁切圖片。";
  } catch (error) {
    console.error(error);
    status.textContent = error.message || "手動裁切下載失敗。";
  } finally {
    saveButton.disabled = false;
  }
});

window.addEventListener("pagehide", () => {
  revokePreviewUrls();

  if (stitchedObjectUrl) {
    URL.revokeObjectURL(stitchedObjectUrl);
    stitchedObjectUrl = null;
  }
});

// ---- IndexedDB ----

const STITCH_DB_NAME = "ScreenshotStitchDB";
// 必須與 background.js 的 DB_VERSION 一致，否則較低版本的一方會無法開啟資料庫。
const STITCH_DB_VERSION = 2;
const STITCH_STORE_NAME = "frames";

function openStitchDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STITCH_DB_NAME, STITCH_DB_VERSION);

    // 編輯頁也可能比背景程式先建立資料庫，因此同樣要建立資料表，
    // 否則資料庫會在沒有資料表的狀態下被建立，之後每次讀寫都會失敗。
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STITCH_STORE_NAME)) {
        const store = db.createObjectStore(STITCH_STORE_NAME, {
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

async function getStitchFrames(jobId) {
  const db = await openStitchDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STITCH_STORE_NAME, "readonly");

    const index = transaction.objectStore(STITCH_STORE_NAME).index("jobId");
    const request = index.getAll(IDBKeyRange.only(jobId));

    request.onsuccess = () => {
      const frames = request.result.sort((a, b) => a.index - b.index);

      db.close();
      resolve(frames);
    };

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

async function removeStitchFrames(jobId) {
  const db = await openStitchDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STITCH_STORE_NAME, "readwrite");

    const index = transaction.objectStore(STITCH_STORE_NAME).index("jobId");
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

function loadFrameImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const frameImage = new Image();

    frameImage.onload = () => resolve(frameImage);
    frameImage.onerror = () => {
      reject(new Error("有一段截圖無法載入。"));
    };

    frameImage.src = dataUrl;
  });
}

// 將一批截圖依捲動位置拼成一張長圖（含捲軸的部分已裁去）。
// 回傳 Canvas 與版面資訊，並包含本批最後一段截圖的底部整頁座標。
async function createStitchedCanvas(jobId) {
  const frames = await getStitchFrames(jobId);

  if (frames.length === 0) {
    throw new Error("找不到長圖的截圖片段，請重新擷取。");
  }

  const loadedFrames = [];

  for (const frame of frames) {
    const frameImage = await loadFrameImage(frame.dataUrl);

    loadedFrames.push({ ...frame, image: frameImage });
  }

  const first = loadedFrames[0];
  const fullWidth = first.image.naturalWidth;
  const fullHeight = first.image.naturalHeight;

  for (const frame of loadedFrames) {
    if (
      frame.image.naturalWidth !== fullWidth ||
      frame.image.naturalHeight !== fullHeight
    ) {
      throw new Error("截圖尺寸不一致，無法安全拼接。");
    }
  }

  const pxPerCssX = first.innerWidth ? fullWidth / first.innerWidth : 1;
  const pxPerCssY = first.innerHeight ? fullHeight / first.innerHeight : 1;

  const contentCssWidth =
    first.contentWidth || first.innerWidth || fullWidth / pxPerCssX;
  const contentCssHeight = first.viewportHeight;

  const cropWidth = clamp(Math.round(contentCssWidth * pxPerCssX), 1, fullWidth);
  const cropHeight = clamp(Math.round(contentCssHeight * pxPerCssY), 1, fullHeight);

  const scaleY = cropHeight / contentCssHeight;

  const plan = computeStitchPlan(
    loadedFrames,
    cropHeight,
    scaleY,
    contentCssHeight
  );

  if (plan.totalHeight > 30000 || plan.totalHeight * cropWidth > 120_000_000) {
    throw new Error("本批長圖尺寸過大。請重新開始擷取，或縮小頁面範圍。");
  }

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = cropWidth;
  outputCanvas.height = plan.totalHeight;

  const outputCtx = outputCanvas.getContext("2d");

  if (!outputCtx) {
    throw new Error("無法建立長圖畫布。");
  }

  let destinationY = 0;

  for (const segment of plan.segments) {
    const frame = loadedFrames[segment.frameIndex];

    outputCtx.drawImage(
      frame.image,
      0,
      segment.sourceY,
      cropWidth,
      segment.height,
      0,
      destinationY,
      cropWidth,
      segment.height
    );

    destinationY += segment.height;
  }

  const last = loadedFrames[loadedFrames.length - 1];

  return {
    canvas: outputCanvas,
    frameCount: frames.length,
    gapCount: plan.gapCount,
    layouts: loadedFrames.map((frame) => frame.layout || { images: [], separators: [] }),
    originScrollY: first.scrollY,
    scale: scaleY,
    capturedBottomPage: last.scrollY + contentCssHeight,
    pxPerCssX: cropWidth / contentCssWidth
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.stitchProgress) return;

  const text = changes.stitchProgress.newValue?.text;

  if (busy && text) {
    status.textContent = text;
  }
});

loadScreenshot();
