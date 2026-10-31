// 這個檔案中的函式會透過 chrome.scripting.executeScript 序列化後注入目標網頁執行。
// 因此每個函式都必須完全自給自足：不能引用外部變數、常數或其他函式，需要的設定一律用參數傳入。
//
// 捲動目標：大部分網頁由整個視窗捲動；Gmail、Notion 等網頁則是頁面內某個區塊在捲動。
// prepareScrollTargetInPage() 會選出捲動目標，若是區塊就在該元素加上 data-scc-scroller 標記，
// 之後的掃描、捲動、隱藏固定元素都以這個標記為準。

// 選出長截圖要捲動的目標。視窗可以捲動時優先使用視窗，否則選可見面積最大的可捲動區塊。
export function prepareScrollTargetInPage() {
  const ATTR = "data-scc-scroller";

  for (const old of document.querySelectorAll(`[${ATTR}]`)) {
    old.removeAttribute(ATTR);
  }

  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const root = document.scrollingElement || document.documentElement;

  // 實際試著捲動 1px，判斷視窗是否真的可以捲動（overflow: hidden 時不會動）。
  let windowScrollable = window.scrollY > 0;

  if (!windowScrollable && root.scrollHeight - window.innerHeight > 50) {
    const before = window.scrollY;
    window.scrollTo({ top: before + 1, behavior: "instant" });
    windowScrollable = window.scrollY !== before;
    window.scrollTo({ top: before, behavior: "instant" });
  }

  if (windowScrollable) {
    return { mode: "window" };
  }

  let best = null;

  for (const element of document.querySelectorAll("body *")) {
    // 先用便宜的版面數值篩選，再讀取樣式。
    if (element.scrollHeight - element.clientHeight <= 50) {
      continue;
    }

    const overflowY = window.getComputedStyle(element).overflowY;

    if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") {
      continue;
    }

    const rect = element.getBoundingClientRect();
    const visibleWidth = Math.min(vw, rect.right) - Math.max(0, rect.left);
    const visibleHeight = Math.min(vh, rect.bottom) - Math.max(0, rect.top);

    if (visibleWidth < vw * 0.3 || visibleHeight < vh * 0.3) {
      continue;
    }

    const area = visibleWidth * visibleHeight;

    if (!best || area > best.area) {
      best = { element, area };
    }
  }

  if (!best) {
    return { mode: "window" };
  }

  best.element.setAttribute(ATTR, "");

  return { mode: "element" };
}

export function releaseScrollTargetInPage() {
  for (const element of document.querySelectorAll("[data-scc-scroller]")) {
    element.removeAttribute("data-scc-scroller");
  }
}

// 捲動到指定位置（捲動目標座標，CSS 像素），回傳實際位置。
export function scrollToInPage(top) {
  const scroller = document.querySelector("[data-scc-scroller]");

  if (scroller) {
    scroller.scrollTop = top;
    return scroller.scrollTop;
  }

  window.scrollTo({ top, behavior: "instant" });
  return window.scrollY;
}

// 向下捲動一段距離，回傳捲動後的位置。
export function scrollByInPage(distance) {
  const scroller = document.querySelector("[data-scc-scroller]");

  if (scroller) {
    scroller.scrollTop += distance;
    return scroller.scrollTop;
  }

  window.scrollTo({ top: window.scrollY + distance, behavior: "instant" });
  return window.scrollY;
}

// 讀取目前的捲動位置與視窗尺寸，用來確認截圖時畫面與偵測時一致。
export function readViewportStateInPage() {
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  };
}

// 掃描網頁中的圖片類元素（img、video、canvas，可選 svg 與 CSS 背景圖）與廣告區塊。
//
// options：
//   minSize            最小尺寸（CSS 像素）
//   includeExtras      是否包含 svg 與 CSS 背景圖（單張截圖使用）
//   visibleOnly        只保留目前畫面上可見部分夠大的項目（單張截圖使用）
//   includeSeparators  是否掃描廣告等分隔區塊（長截圖使用）
//
// 每個項目同時回傳兩種座標：
//   x / y / width / height     目前視窗中可見的部分（單張截圖裁切使用）
//   top / bottom / left / right 相對於捲動目標內容的整頁座標（長截圖拼接使用）
export function scanPageInPage(options) {
  const minSize = options.minSize;
  const scroller = document.querySelector("[data-scc-scroller]");

  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;

  // 截圖中要使用的範圍（clip）：視窗內容區域，或捲動區塊的可見內容區域（不含捲軸）。
  let clip;
  let scrollTop;
  let scrollLeft;

  if (scroller) {
    const rect = scroller.getBoundingClientRect();
    const left = Math.max(0, rect.left + scroller.clientLeft);
    const top = Math.max(0, rect.top + scroller.clientTop);
    const right = Math.min(vw, rect.left + scroller.clientLeft + scroller.clientWidth);
    const bottom = Math.min(vh, rect.top + scroller.clientTop + scroller.clientHeight);

    clip = { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
    scrollTop = scroller.scrollTop;
    scrollLeft = scroller.scrollLeft;
  } else {
    clip = { left: 0, top: 0, width: vw, height: vh };
    scrollTop = window.scrollY;
    scrollLeft = window.scrollX;
  }

  const isRendered = (element) => {
    let node = element;

    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const style = window.getComputedStyle(node);

      if (style.display === "none" || Number(style.opacity) === 0) {
        return false;
      }

      node = node.parentElement;
    }

    return window.getComputedStyle(element).visibility !== "hidden";
  };

  const inScrollTarget = (element) => !scroller || scroller.contains(element);

  const toPage = (rect) => ({
    top: rect.top - clip.top + scrollTop,
    bottom: rect.bottom - clip.top + scrollTop,
    left: rect.left - clip.left + scrollLeft,
    right: rect.right - clip.left + scrollLeft
  });

  const items = [];

  const addItem = (element, kind, extra) => {
    const rect = element.getBoundingClientRect();

    if (rect.width < minSize || rect.height < minSize) {
      return;
    }

    // 同一個位置已有項目（例如 <picture> 內的圖片與外框的背景圖）時不重複加入。
    const duplicate = items.some((item) =>
      Math.abs(item.rect.left - rect.left) <= 2 &&
      Math.abs(item.rect.top - rect.top) <= 2 &&
      Math.abs(item.rect.right - rect.right) <= 2 &&
      Math.abs(item.rect.bottom - rect.bottom) <= 2
    );

    if (duplicate) {
      return;
    }

    items.push({ rect, kind, ...extra });
  };

  for (const img of document.images) {
    if (!img.complete || img.naturalWidth < minSize || img.naturalHeight < minSize) {
      continue;
    }

    if (!inScrollTarget(img) || !isRendered(img)) {
      continue;
    }

    addItem(img, "image", {
      src: img.currentSrc || img.src,
      alt: img.alt || "",
      sourceWidth: img.naturalWidth,
      sourceHeight: img.naturalHeight
    });
  }

  for (const video of document.querySelectorAll("video")) {
    if (!inScrollTarget(video) || !isRendered(video)) {
      continue;
    }

    addItem(video, "video", {
      src: video.currentSrc || video.src || "",
      alt: video.getAttribute("title") || "",
      sourceWidth: video.videoWidth || undefined,
      sourceHeight: video.videoHeight || undefined
    });
  }

  for (const canvasElement of document.querySelectorAll("canvas")) {
    if (!inScrollTarget(canvasElement) || !isRendered(canvasElement)) {
      continue;
    }

    addItem(canvasElement, "canvas", {
      src: "",
      alt: canvasElement.getAttribute("aria-label") || "",
      sourceWidth: canvasElement.width,
      sourceHeight: canvasElement.height
    });
  }

  if (options.includeExtras) {
    for (const svg of document.querySelectorAll("svg")) {
      // 只取最外層的 svg，內層的 svg 屬於同一張向量圖。
      if (svg.parentElement && svg.parentElement.closest("svg")) {
        continue;
      }

      if (!inScrollTarget(svg) || !isRendered(svg)) {
        continue;
      }

      addItem(svg, "svg", {
        src: "",
        alt: svg.getAttribute("aria-label") || ""
      });
    }

    for (const element of document.querySelectorAll("body *")) {
      // 先用位置篩選，只檢查目前畫面上的元素，減少讀取樣式的次數。
      const rect = element.getBoundingClientRect();

      if (
        rect.width < minSize ||
        rect.height < minSize ||
        rect.bottom <= 0 ||
        rect.top >= vh ||
        rect.right <= 0 ||
        rect.left >= vw
      ) {
        continue;
      }

      const background = window.getComputedStyle(element).backgroundImage;

      // 只處理圖片網址；漸層（linear-gradient 等）不是圖片。
      const match = background && background.match(/url\(["']?([^"')]+)["']?\)/);

      if (!match || !inScrollTarget(element) || !isRendered(element)) {
        continue;
      }

      addItem(element, "background", {
        src: match[1],
        alt: element.getAttribute("aria-label") || element.getAttribute("title") || ""
      });
    }
  }

  const images = [];

  for (const item of items) {
    const rect = item.rect;

    // 目前視窗中可見的部分。
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(vw, rect.right);
    const bottom = Math.min(vh, rect.bottom);

    // 單張截圖只需要畫面上看得到（且可見部分夠大）的項目。
    if (options.visibleOnly && (right - left < minSize || bottom - top < minSize)) {
      continue;
    }

    images.push({
      kind: item.kind,
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      ...toPage(rect),
      src: item.src,
      alt: item.alt,
      sourceWidth: item.sourceWidth,
      sourceHeight: item.sourceHeight
    });
  }

  const separators = [];

  if (options.includeSeparators) {
    const AD_PATTERN =
      /(^|[^a-z])(ad|ads|advert|advertisement|advertising|sponsor|sponsored|banner|adsbygoogle|doubleclick|googlesyndication)([^a-z]|$)/i;

    const VIDEO_PATTERN = /youtube|youtu\.be|vimeo|bilibili|player/i;

    for (const element of document.querySelectorAll("iframe, ins, [id], [class]")) {
      if (element.tagName === "IMG" || !inScrollTarget(element)) {
        continue;
      }

      const attributeText =
        `${element.id || ""} ${element.getAttribute("class") || ""} ` +
        `${element.getAttribute("name") || ""}`;

      const sourceText =
        element.tagName === "IFRAME" ? element.getAttribute("src") || "" : "";

      const isVideoEmbed = VIDEO_PATTERN.test(sourceText);

      const isAdLike =
        element.classList.contains("adsbygoogle") ||
        AD_PATTERN.test(attributeText) ||
        AD_PATTERN.test(sourceText) ||
        (element.tagName === "IFRAME" && !isVideoEmbed);

      if (!isAdLike) {
        continue;
      }

      if (window.getComputedStyle(element).position === "fixed") {
        continue;
      }

      if (!isRendered(element)) {
        continue;
      }

      const rect = element.getBoundingClientRect();

      if (rect.width < 200 || rect.height < 50 || rect.height > clip.height * 1.5) {
        continue;
      }

      const box = toPage(rect);

      separators.push({ top: box.top, bottom: box.bottom });
    }
  }

  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollTop,
    clip,
    viewportWidth: vw,
    viewportHeight: vh,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    images,
    separators
  };
}

// 隱藏固定定位與吸附在邊緣的 sticky 元素（visibility: hidden，保留版面），避免在每一段截圖中重複出現。
// 原始樣式記錄在 window.__sccHidden，供還原使用。每次呼叫都會先還原再重新隱藏，
// 因此截圖途中才出現的浮動元素（Cookie 提示、客服視窗）也會被隱藏。回傳隱藏的元素數量。
export function hideFixedElementsInPage() {
  const leftover = window.__sccHidden || [];

  for (const entry of leftover) {
    entry.el.style.setProperty("visibility", entry.value, entry.priority);
  }

  const scroller = document.querySelector("[data-scc-scroller]");
  const vw = window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;

  // sticky 元素是否吸附，要以捲動目標的可見範圍判斷。
  let clipTop = 0;
  let clipBottom = vh;

  if (scroller) {
    const rect = scroller.getBoundingClientRect();
    clipTop = Math.max(0, rect.top + scroller.clientTop);
    clipBottom = Math.min(vh, rect.top + scroller.clientTop + scroller.clientHeight);
  }

  const viewportArea = vw * vh;

  const containsLargeMedia = (element) => {
    for (const item of element.querySelectorAll("img, video, canvas")) {
      const rect = item.getBoundingClientRect();

      if (rect.width * rect.height >= viewportArea * 0.4) {
        return true;
      }
    }

    return false;
  };

  const hidden = [];

  for (const element of document.querySelectorAll("body *")) {
    const style = window.getComputedStyle(element);

    if (style.position !== "fixed" && style.position !== "sticky") {
      continue;
    }

    if (style.visibility === "hidden") {
      continue;
    }

    // 捲動區塊本身或包住它的外框（常見於單頁應用程式的固定版面）不能隱藏。
    if (scroller && element.contains(scroller)) {
      continue;
    }

    const rect = element.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      continue;
    }

    if (style.position === "sticky") {
      const stuck = rect.top <= clipTop + 1 || rect.bottom >= clipBottom - 1;

      if (!stuck) {
        continue;
      }
    }

    if (rect.width * rect.height >= viewportArea * 0.5 && containsLargeMedia(element)) {
      continue;
    }

    hidden.push({
      el: element,
      value: element.style.getPropertyValue("visibility"),
      priority: element.style.getPropertyPriority("visibility")
    });

    element.style.setProperty("visibility", "hidden", "important");
  }

  window.__sccHidden = hidden;

  return hidden.length;
}

export function restoreFixedElementsInPage() {
  const hidden = window.__sccHidden || [];

  for (const entry of hidden) {
    entry.el.style.setProperty("visibility", entry.value, entry.priority);
  }

  window.__sccHidden = [];

  return hidden.length;
}

// 檢查視窗附近的圖片是否都已載入完成。scope 為 "viewport" 時只看視窗附近的圖片，
// 因為遠處的 lazy-load 圖片在捲動到之前本來就不會載入。
export function checkPageReadyInPage(scope) {
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const margin = 300;

  let pending = 0;

  for (const img of document.images) {
    const style = window.getComputedStyle(img);
    const rect = img.getBoundingClientRect();

    if (style.display === "none" || style.visibility === "hidden") {
      continue;
    }

    if (rect.width < 2 || rect.height < 2) {
      continue;
    }

    const nearViewport = rect.bottom > -margin && rect.top < vh + margin;

    if (scope === "viewport" && !nearViewport) {
      continue;
    }

    if (!img.complete) {
      pending++;
    }
  }

  return {
    complete: document.readyState === "complete",
    pending,
    count: document.images.length
  };
}

// ---- 翻頁截圖（彈窗看圖） ----

// 找出目前畫面中可見面積最大的圖片類元素（彈窗中的主圖），回傳其可見範圍與識別字串。
// signature 用來判斷翻頁後是否換了一張圖；complete 表示圖片已載入完成。
export function findMainImageInPage(minSize) {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;

  const isRendered = (element) => {
    let node = element;

    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const style = window.getComputedStyle(node);

      if (style.display === "none" || Number(style.opacity) === 0) {
        return false;
      }

      node = node.parentElement;
    }

    return window.getComputedStyle(element).visibility !== "hidden";
  };

  let best = null;

  for (const element of document.querySelectorAll("img, canvas, video, picture, [style*='background']")) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const width = Math.min(vw, rect.right) - left;
    const height = Math.min(vh, rect.bottom) - top;

    if (width < minSize || height < minSize || !isRendered(element)) {
      continue;
    }

    let source = "";

    if (element.tagName === "IMG") {
      source = element.currentSrc || element.src;
    } else if (element.tagName === "VIDEO") {
      source = element.currentSrc || element.src || element.poster || "";
    } else if (element.tagName === "CANVAS") {
      source = `canvas:${element.width}x${element.height}`;
    } else {
      const match = window.getComputedStyle(element).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);

      if (!match) continue;

      source = match[1];
    }

    const area = width * height;

    if (!best || area > best.area) {
      best = {
        area,
        element,
        source,
        rect: { x: left, y: top, width, height }
      };
    }
  }

  if (!best) {
    return null;
  }

  const element = best.element;
  const complete = element.tagName === "IMG"
    ? element.complete && element.naturalWidth > 0
    : true;

  return {
    signature: best.source || `${element.tagName}:${Math.round(best.rect.x)},${Math.round(best.rect.y)}`,
    rect: best.rect,
    complete,
    alt: element.getAttribute("alt") || element.getAttribute("aria-label") || "",
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  };
}

// 模擬按下鍵盤「→」鍵（多數看圖彈窗以此切換到下一張）。
// 事件從目前焦點所在的元素送出，會一路冒泡到 document 與 window。
export function pressArrowRightInPage() {
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document.body || document.documentElement;

  const options = {
    key: "ArrowRight",
    code: "ArrowRight",
    keyCode: 39,
    which: 39,
    bubbles: true,
    cancelable: true,
    composed: true
  };

  target.dispatchEvent(new KeyboardEvent("keydown", options));
  target.dispatchEvent(new KeyboardEvent("keyup", options));
}
