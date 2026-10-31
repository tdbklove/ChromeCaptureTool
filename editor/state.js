// 編輯頁的共用狀態。各模組都讀寫同一個物件，避免狀態分散在多個檔案的區域變數中。

export const state = {
  loaded: false,
  busy: false,
  // "single"：單張截圖；"stitch"：長條截圖。
  mode: "single",

  // 截圖來源（Canvas），以及其像素尺寸。所有座標都以這個像素為單位。
  source: null,
  width: 0,
  height: 0,

  // 檔名使用的網站名稱與截圖時間。
  meta: { site: "page", time: Date.now() },

  // 下載設定（輸出格式會影響合併長圖的高度上限）；設定頁修改時會即時更新。
  settings: null,

  // 預覽縮放：null 表示符合預覽區寬度，數字表示相對於實際大小的比例（1 = 100%）。
  zoom: null,

  // ---- 手動選取 ----
  selection: null,
  startPoint: null,
  pointerDownClient: null,
  isDragging: false,

  // ---- 單張截圖 ----
  detectedImages: [],
  activeItemId: null,
  // 正在拖曳調整的框（偵測框或手動選取框）。
  editDrag: null,

  // ---- 長條截圖 ----
  session: null,
  jobId: null,
  // 下一批的起點（捲動目標座標）；null 表示已到底部。
  nextStartY: null,
  stitchLayout: null, // { layouts, originScrollY, scale }
  stitchInfo: null,
  removedGapIds: new Set(),
  // 使用者拖曳調整過的移除範圍（間隔編號 → { startY, endY }）與手動新增的移除框。
  cutOverrides: new Map(),
  customCuts: [],
  stitchGaps: [],
  stitchGroups: [],
  stitchCuts: [],
  stitchParts: [],
  stitchImageBoxes: [],
  stitchCutWarning: false,
  // 左右兩側的空白：width 為寬度（像素），removed 表示輸出時移除。detected 為自動偵測的結果。
  sides: {
    left: { width: 0, removed: false },
    right: { width: 0, removed: false },
    detected: { left: 0, right: 0 }
  },
  // 上下裁切：size 為從長圖最上方／最下方裁掉的高度（像素），removed 表示輸出時裁掉。
  // detected 為自動偵測的頂部、底部空間。
  trims: {
    top: { size: 0, removed: false },
    bottom: { size: 0, removed: false },
    detected: { top: 0, bottom: 0 }
  },
  // 不加入合併的段落範圍（{ startY, endY }）。段落會隨移除區域重新計算，
  // 因此記錄範圍而不是段落編號：新段落的中心落在這些範圍內，就維持「不加入合併」。
  excludedPartRanges: [],
  // 正在拖曳的移除框或側邊空白邊線。
  dragCut: null,
  addCutMode: false,

  // ---- 結果清單 ----
  previewUrls: [],
  // 結果清單的產生是非同步的（每張預覽都要等待圖片產生）。
  // 每次重新產生都遞增版本編號，舊的產生流程發現版本已過期就停止，避免卡片重複或錯亂。
  renderGeneration: 0
};
