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

// 找出彈窗中的主圖：畫面上「沒有被其他東西蓋住」的圖片類元素中，可見面積最大的一個。
// 找到後在該元素加上 data-scc-main 標記，翻頁時的按鍵事件會從它送出。
//
// 回傳：
//   signature  圖片的識別字串（網址），用來判斷翻頁後是否換了一張圖
//   rect       目前畫面中可見的範圍（CSS 像素）
//   complete   圖片是否已載入完成
//   opacity    含所有上層元素的實際不透明度（淡入動畫中會小於 1）
//   lowRes     是否像是放大顯示的低解析度預覽圖（高解析度版本可能還在載入）
export function findMainImageInPage(minSize) {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;

  const IMAGE_TAGS = new Set(["IMG", "CANVAS", "VIDEO"]);

  const backgroundUrl = (element) => {
    const match = window.getComputedStyle(element).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
    return match ? match[1] : "";
  };

  const isImageLike = (element) =>
    IMAGE_TAGS.has(element.tagName) || Boolean(backgroundUrl(element));

  // 含所有上層元素的不透明度；任何一層隱藏時回傳 0。
  const effectiveOpacity = (element) => {
    let opacity = 1;
    let node = element;

    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const style = window.getComputedStyle(node);

      if (style.display === "none" || style.visibility === "hidden") {
        return 0;
      }

      opacity *= Number(style.opacity);
      node = node.parentElement;
    }

    return opacity;
  };

  // 元素的背景色是否不透明到足以遮住下方內容（例如彈窗的深色遮罩）。
  const isCovering = (element) => {
    const color = window.getComputedStyle(element).backgroundColor;
    const match = color.match(/rgba?\(([^)]+)\)/);

    if (!match) return false;

    const parts = match[1].split(/[\s,/]+/).filter(Boolean);
    const alpha = parts.length >= 4 ? Number(parts[3]) : 1;

    return alpha >= 0.5;
  };

  // 是否為畫面上最上層的圖片：在它可見範圍內取幾個點，從最上層往下找，
  // 必須先遇到它自己，中間不能有其他圖片或不透明的遮罩。
  // （彈窗後方的大圖會被遮罩蓋住，因此會被排除。）
  const isTopmostImage = (element, rect) => {
    const points = [
      [rect.x + rect.width / 2, rect.y + rect.height / 2],
      [rect.x + rect.width * 0.25, rect.y + rect.height * 0.25],
      [rect.x + rect.width * 0.75, rect.y + rect.height * 0.75]
    ];

    let hits = 0;

    for (const [x, y] of points) {
      for (const item of document.elementsFromPoint(x, y)) {
        if (item === element) {
          hits++;
          break;
        }

        // 圖片自己的外框（包含它的元素）不算遮住它。
        if (item.contains(element)) {
          continue;
        }

        if (isImageLike(item) || isCovering(item)) {
          break;
        }
      }
    }

    return hits >= 2;
  };

  const candidates = [];

  for (const element of document.querySelectorAll("img, canvas, video, [style*='background']")) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const width = Math.min(vw, rect.right) - left;
    const height = Math.min(vh, rect.bottom) - top;

    if (width < minSize || height < minSize) {
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
      source = backgroundUrl(element);

      if (!source) continue;
    }

    candidates.push({
      element,
      source,
      area: width * height,
      rect: { x: left, y: top, width, height }
    });
  }

  candidates.sort((a, b) => b.area - a.area);

  const visible = candidates.filter((candidate) => effectiveOpacity(candidate.element) > 0);

  // 設定了 pointer-events: none 的圖片不會出現在 elementsFromPoint 的結果中，無法判斷是否在最上層；
  // 只有在找不到最上層的圖片時，才退回使用這類圖片。
  // （不能直接退回「面積最大的圖片」：彈窗圖片還在淡入、完全透明時，會誤選到彈窗後方的大圖。）
  const best =
    visible.find((candidate) => isTopmostImage(candidate.element, candidate.rect)) ||
    visible.find((candidate) => window.getComputedStyle(candidate.element).pointerEvents === "none");

  for (const old of document.querySelectorAll("[data-scc-main]")) {
    old.removeAttribute("data-scc-main");
  }

  if (!best) {
    return null;
  }

  const element = best.element;
  element.setAttribute("data-scc-main", "");

  const isImg = element.tagName === "IMG";
  const complete = isImg ? element.complete && element.naturalWidth > 0 : true;

  // 實際像素遠小於顯示大小：通常是先顯示的模糊預覽圖，高解析度版本稍後才會換上。
  const dpr = window.devicePixelRatio || 1;
  const lowRes = isImg && complete &&
    element.naturalWidth * dpr < best.rect.width * 0.5 &&
    element.naturalHeight * dpr < best.rect.height * 0.5;

  return {
    signature: best.source || `${element.tagName}:${Math.round(best.rect.x)},${Math.round(best.rect.y)}`,
    rect: best.rect,
    complete,
    lowRes,
    opacity: effectiveOpacity(element),
    alt: element.getAttribute("alt") || element.getAttribute("aria-label") || "",
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  };
}

// 模擬按下鍵盤「→」鍵（多數看圖彈窗以此切換到下一張）。
//
// 第一次（attempt 為 0）從主圖（data-scc-main）送出，會依序冒泡經過彈窗、document 與 window，
// 不論看圖程式把按鍵監聽放在彈窗的哪一層都收得到。
// 重按時（attempt 為 1）改從目前取得焦點的元素送出，處理監聽放在其他已聚焦元素上的看圖程式。
// 舊式程式會讀取 keyCode／which，但用程式建立的事件這兩個值固定為 0，因此另外補上。
export function pressArrowRightInPage(attempt = 0) {
  const focused = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : null;

  const main = document.querySelector("[data-scc-main]");

  const target = (attempt === 0 ? main || focused : focused || main) ||
    document.body ||
    document.documentElement;

  const send = (type) => {
    const event = new KeyboardEvent(type, {
      key: "ArrowRight",
      code: "ArrowRight",
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    });

    Object.defineProperty(event, "keyCode", { get: () => 39 });
    Object.defineProperty(event, "which", { get: () => 39 });
    Object.defineProperty(event, "charCode", { get: () => 0 });

    target.dispatchEvent(event);
  };

  send("keydown");
  send("keyup");
}
