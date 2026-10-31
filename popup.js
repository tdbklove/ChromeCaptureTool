const captureButton = document.querySelector("#captureButton");

// 截圖包含捲軸（Windows 常見），這裡只保留網頁內容區域，去掉右側與底部的捲軸。
// innerW／innerH 為瀏覽器視窗尺寸（CSS px），contentW／contentH 為內容區域尺寸（CSS px）。
async function cropToContent(dataUrl, innerW, innerH, contentW, contentH) {
  if (!innerW || !innerH) {
    return dataUrl;
  }

  const source = new Image();
  source.src = dataUrl;
  await source.decode();

  const scaleX = source.naturalWidth / innerW;
  const scaleY = source.naturalHeight / innerH;

  const width = Math.min(source.naturalWidth, Math.round(contentW * scaleX));
  const height = Math.min(source.naturalHeight, Math.round(contentH * scaleY));

  if (width === source.naturalWidth && height === source.naturalHeight) {
    return dataUrl;
  }

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = width;
  cropCanvas.height = height;

  cropCanvas.getContext("2d").drawImage(
    source, 0, 0, width, height, 0, 0, width, height
  );

  return cropCanvas.toDataURL("image/png");
}
const stitchButton = document.querySelector("#stitchButton");
const status = document.querySelector("#status");

// 在目標網頁中偵測可見的 <img>。
// 此函式會被 chrome.scripting.executeScript 序列化後注入網頁執行，
// 因此必須完全自給自足，不能引用外部變數或函式。
function detectVisibleImagesInPage() {
  // clientWidth／clientHeight 不含捲軸，與截圖裁切後的內容範圍一致。
  const viewportWidth =
    document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight =
    document.documentElement.clientHeight || window.innerHeight;

  // 檢查元素本身或任一祖先是否會讓它不可見。
  // visibility 是繼承屬性，已由元素本身的 computed style 反映，因此這裡只需檢查
  // display: none 與 opacity: 0（不透明度會沿著祖先鏈相乘）。
  const isHiddenByAncestors = (element) => {
    let node = element;

    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const style = window.getComputedStyle(node);

      if (style.display === "none" || Number(style.opacity) === 0) {
        return true;
      }

      node = node.parentElement;
    }

    return false;
  };

  const images = Array.from(document.images)
    .map((img) => {
      const style = window.getComputedStyle(img);

      // 排除隱藏、尚未載入完成的圖片。
      if (
        style.visibility === "hidden" ||
        isHiddenByAncestors(img) ||
        !img.complete
      ) {
        return null;
      }

      // 排除原始圖片過小的元素（圖示、裝飾小圖）。
      if (img.naturalWidth < 40 || img.naturalHeight < 40) {
        return null;
      }

      // 只保留目前可視範圍內的部分。
      const rect = img.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(viewportWidth, rect.right);
      const bottom = Math.min(viewportHeight, rect.bottom);

      const width = right - left;
      const height = bottom - top;

      // 排除畫面上可見範圍太小的元素。
      if (width < 40 || height < 40) {
        return null;
      }

      return {
        x: left,
        y: top,
        width,
        height,
        sourceWidth: img.naturalWidth,
        sourceHeight: img.naturalHeight,
        alt: img.alt || ""
      };
    })
    .filter(Boolean);

  return {
    viewportWidth,
    viewportHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    images
  };
}

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  status.textContent = "正在偵測圖片並擷取畫面……";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id || !tab.windowId) {
      throw new Error("找不到目前的分頁。");
    }

    let results;

    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: detectVisibleImagesInPage
      });
    } catch (error) {
      console.error("無法在此頁面執行偵測：", error);
      throw new Error(
        "無法讀取此頁面，請確認目前分頁是允許擷取的網頁（瀏覽器內建頁面無法擷取）。"
      );
    }

    const pageInfo = results?.[0]?.result;

    if (!pageInfo) {
      throw new Error("無法取得網頁圖片資訊。");
    }

    // 擷取目前可見的分頁。
    const rawScreenshot = await chrome.tabs.captureVisibleTab(
      tab.windowId,
      { format: "png" }
    );

    const screenshot = await cropToContent(
      rawScreenshot,
      pageInfo.innerWidth,
      pageInfo.innerHeight,
      pageInfo.viewportWidth,
      pageInfo.viewportHeight
    );

    // 清除尚未完成的長圖結果，避免編輯頁優先顯示舊的長圖。
    const discard = await chrome.runtime.sendMessage({
      type: "DISCARD_STITCH"
    });

    if (!discard?.ok) {
      throw new Error(discard?.error || "無法清除長圖暫存，請稍後再試。");
    }

    // 將截圖和偵測結果交給裁切頁面。
    await chrome.storage.local.set({
      pendingCapture: {
        screenshot,
        viewportWidth: pageInfo.viewportWidth,
        viewportHeight: pageInfo.viewportHeight,
        images: pageInfo.images
      }
    });

    await chrome.tabs.create({
      url: chrome.runtime.getURL("editor.html")
    });

    status.textContent = "截圖完成。";
  } catch (error) {
    console.error("截圖或偵測失敗：", error);

    status.textContent =
      error.message ||
      "操作失敗，請確認目前分頁是否允許截圖。";
  } finally {
    captureButton.disabled = false;
  }
});

stitchButton.addEventListener("click", async () => {
  stitchButton.disabled = true;
  isStitchRunning = true;
  status.textContent =
    "頁面載入中，完成後會自動開始截圖，請勿操作網頁。";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id || tab.windowId == null) {
      throw new Error("找不到目前的分頁。");
    }

    status.textContent =
      "等待頁面載入完成後自動截圖，請保持目標分頁開啟，勿切換分頁。";

    // 背景 Service Worker 會在整個工作結束後才回覆。
    // 回覆可能是成功，也可能是失敗（例如已有工作執行中、分頁不在前景）。
    const response = await chrome.runtime.sendMessage({
      type: "START_STITCH",
      tabId: tab.id,
      windowId: tab.windowId
    });

    if (response?.ok) {
      status.textContent = "長圖擷取完成，已開啟預覽頁。";
    } else {
      status.textContent =
        response?.error || "長圖擷取失敗，請重新嘗試。";
    }
  } catch (error) {
    console.error(error);
    status.textContent =
      error.message || "無法啟動長圖擷取。";
  } finally {
    stitchButton.disabled = false;
    isStitchRunning = false;
  }
});

// 背景工作的進度文字即時顯示在彈出視窗中。
let isStitchRunning = false;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.stitchProgress) return;

  const text = changes.stitchProgress.newValue?.text;

  if (isStitchRunning && text) {
    status.textContent = text;
  }
});
