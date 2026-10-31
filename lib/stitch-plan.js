// 純計算函式：偵測框換算、長圖拼接規劃、移除區域與分段。
// 不接觸 DOM 與 chrome API，輸入相同就得到相同結果。

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// 將網頁座標（CSS 像素）的偵測結果換算成截圖像素，並依位置排序、編號。
export function buildDetections(capture, canvasWidth, canvasHeight) {
  const scaleX = canvasWidth / capture.viewportWidth;
  const scaleY = canvasHeight / capture.viewportHeight;

  return (capture.images || [])
    .map((item) => {
      const left = clamp(Math.round(item.x * scaleX), 0, canvasWidth);
      const top = clamp(Math.round(item.y * scaleY), 0, canvasHeight);
      const right = clamp(Math.round((item.x + item.width) * scaleX), 0, canvasWidth);
      const bottom = clamp(Math.round((item.y + item.height) * scaleY), 0, canvasHeight);

      return {
        kind: item.kind || "image",
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
export function computeStitchPlan(frames, frameHeightPx, scaleY, viewportHeight) {
  const segments = [];
  let totalHeight = 0;
  let gapCount = 0;

  if (frames.length === 0) {
    return { segments, totalHeight, gapCount };
  }

  segments.push({ frameIndex: 0, sourceY: 0, height: frameHeightPx });
  totalHeight = frameHeightPx;

  for (let i = 1; i < frames.length; i++) {
    const scrollDelta = frames[i].scrollTop - frames[i - 1].scrollTop;

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

// 收集版面上的圖片、廣告候選與圖片之間的間隔（皆為整頁座標）。
export function collectLayoutGaps({ layouts, pageTop, pageBottom }) {
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
export function mergeRanges(ranges) {
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

// 圖片上方（頂部）與下方（底部）的空間大小（整頁座標）。
// 沒有偵測到圖片時兩者都是 0；使用者仍可拖曳上下邊緣的拉條自行裁掉高度。
function measureEdges({ images, pageTop, pageBottom }) {
  if (images.length === 0) {
    return { top: 0, bottom: 0 };
  }

  const firstTop = Math.min(...images.map((image) => image.top));
  const lastBottom = Math.max(...images.map((image) => image.bottom));

  return {
    top: Math.max(0, firstTop - pageTop),
    bottom: Math.max(0, pageBottom - lastBottom)
  };
}

// 依間隔與使用者的移除範圍切分長圖。
//
// removedGapIds：要移除的間隔編號；未提供時全部移除（預設全選，使用者再取消勾選要保留的區域）。
// cutOverrides：拖曳調整過的移除範圍（Map：間隔編號 → { startY, endY }，截圖像素）。
// customCuts：手動新增的移除框（{ startY, endY, enabled }，截圖像素）；enabled 為 false 時不套用。
// edgeTrims：從長圖最上方與最下方裁掉的高度（{ top, bottom }，截圖像素）。
//
// 回傳值的 edges 為自動偵測的頂部、底部空間（截圖像素），作為上下裁切的預設值。
export function computeStitchGroups({
  layouts,
  originScrollY,
  scale,
  heightPx,
  removedGapIds,
  cutOverrides,
  customCuts,
  edgeTrims
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

  const edgesPage = measureEdges({ images, pageTop, pageBottom });
  const edges = {
    top: clamp(Math.round(edgesPage.top * scale), 0, heightPx),
    bottom: clamp(Math.round(edgesPage.bottom * scale), 0, heightPx)
  };

  const gaps = pageGaps
    .map((gap) => {
      const startY = toPixel(gap.top);
      const endY = toPixel(gap.bottom);
      const override = cutOverrides ? cutOverrides.get(gap.id) : undefined;

      return {
        id: gap.id,
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
          : true
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

  const trimCuts = [];

  if (edgeTrims?.top > 0) {
    trimCuts.push({ startY: 0, endY: clamp(edgeTrims.top, 0, heightPx) });
  }

  if (edgeTrims?.bottom > 0) {
    trimCuts.push({ startY: clamp(heightPx - edgeTrims.bottom, 0, heightPx), endY: heightPx });
  }

  const cuts = mergeRanges([...linkedCuts, ...manualCuts, ...trimCuts]);

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
    separatorCount: separators.length,
    edges
  };
}

// 決定本批次的結束位置。
//
// 優先在「完整落在截圖範圍內」的間隔處結束，避免在文字或圖片中間切斷。
// 若是廣告間隔，結束於廣告開始處，下一批從廣告結束處開始；一般間隔則取中點。
// 找不到合適的間隔時（forced = true），才以截圖範圍的底部為結束點。
// 若已到達頁面底部（reachedBottom），則輸出全部內容。
export function chooseBatchEnd({ layouts, originScrollY, capturedBottomPage, reachedBottom }) {
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
export function splitIntoParts({ groups, keptGaps, maxPx }) {
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

// 從像素資料偵測左右兩側的空白。
//
// pixels 為 RGBA 陣列（ImageData.data），width／height 為取樣圖的尺寸。
// 做法：
//   1. 以最外側一欄最常見的顏色作為「空白的顏色」。
//   2. 逐列找出內容從哪裡開始（第一個與空白顏色不同的像素）。
//      最外側像素不是空白顏色的列（例如滿版的頁首、頁尾），以及整列都是空白的列，都不列入計算。
//   3. 取所有列中內容最靠外的位置，但忽略最外側的少數列（outlierRatio），
//      避免頁首的小圖示等少量內容讓整條空白都無法移除。
// 回傳 { left, right }：兩側空白的寬度（取樣圖像素）。
export function detectSideMargins(pixels, width, height, tolerance = 18, outlierRatio = 0.03) {
  if (width < 4 || height < 1) {
    return { left: 0, right: 0 };
  }

  const colorAt = (x, y) => {
    const offset = (y * width + x) * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  };

  const similar = (a, b) =>
    Math.abs(a[0] - b[0]) <= tolerance &&
    Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance;

  // 最外側一欄最常見的顏色（每個色版以 16 為一級統計）。
  const dominantEdgeColor = (x) => {
    const counts = new Map();
    let best = null;

    for (let y = 0; y < height; y++) {
      const color = colorAt(x, y);
      const key = color.map((value) => value >> 4).join(",");
      const entry = counts.get(key) || { count: 0, color };

      entry.count++;
      counts.set(key, entry);

      if (!best || entry.count > best.count) {
        best = entry;
      }
    }

    return best.color;
  };

  // 最多只把寬度的 45% 視為單側空白，避免整張是純色時左右互相吃掉。
  const limit = Math.floor(width * 0.45);

  const measure = (fromLeft) => {
    const edgeX = fromLeft ? 0 : width - 1;
    const step = fromLeft ? 1 : -1;
    const reference = dominantEdgeColor(edgeX);
    const extents = [];

    for (let y = 0; y < height; y++) {
      if (!similar(colorAt(edgeX, y), reference)) {
        continue;
      }

      let distance = 0;

      while (distance < width && similar(colorAt(edgeX + step * distance, y), reference)) {
        distance++;
      }

      // 整列都是空白顏色：沒有內容，不列入計算。
      if (distance < width) {
        extents.push(distance);
      }
    }

    if (extents.length === 0) {
      return 0;
    }

    extents.sort((a, b) => a - b);

    const index = Math.min(extents.length - 1, Math.floor(extents.length * outlierRatio));
    return Math.min(limit, extents[index]);
  };

  return { left: measure(true), right: measure(false) };
}
