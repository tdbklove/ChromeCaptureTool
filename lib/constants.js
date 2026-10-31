// 背景程式、彈出視窗、編輯頁與設定頁共用的常數。

// chrome.storage.local 的鍵值。
export const STORAGE_KEYS = {
  // 目前的長截圖工作階段（分批擷取的進度）。
  session: "stitchSession",
  // 長截圖的進度文字，彈出視窗與編輯頁會監聽並顯示。
  progress: "stitchProgress",
  // 單張截圖對應的編輯頁分頁（分頁 id → 截圖 id），用於關閉分頁時清除暫存。
  captureTabs: "captureTabs",
  // 下載設定。
  downloadSettings: "downloadSettings"
};

// 背景程式接受的訊息類型。
export const MESSAGES = {
  captureVisible: "CAPTURE_VISIBLE",
  capturePages: "CAPTURE_PAGES",
  startStitch: "START_STITCH",
  continueStitch: "CONTINUE_STITCH",
  finishStitch: "FINISH_STITCH",
  stopCapture: "STOP_CAPTURE",
  getStatus: "GET_STATUS"
};

// 圖片偵測最小尺寸的預設值（CSS 像素），排除圖示與裝飾小圖；使用者可在設定頁調整。
export const MIN_MEDIA_SIZE = 40;

export const EDITOR_PAGE = "editor.html";
