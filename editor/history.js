// 復原／重做：記錄可以編輯的狀態（偵測框、手動選取、移除區域、上下左右邊緣、合併勾選）。
//
// 每次操作結束後呼叫 recordHistory()，與目前這一筆相同時不會重複記錄。
// 拖曳進行中不記錄，等放開滑鼠後才記錄一次。

import { dom } from "./dom.js";
import { state } from "./state.js";

const LIMIT = 100;

let entries = [];
let index = -1;
let afterRestore = () => {};

function snapshot() {
  return JSON.stringify({
    selection: state.selection,
    detected: state.detectedImages.map(({ id, x, y, width, height, selected }) =>
      ({ id, x, y, width, height, selected })),
    removedGapIds: [...state.removedGapIds],
    cutOverrides: [...state.cutOverrides],
    customCuts: state.customCuts,
    sides: state.sides,
    trims: state.trims,
    excludedPartRanges: state.excludedPartRanges
  });
}

function apply(entry) {
  const data = JSON.parse(entry);

  state.selection = data.selection;

  for (const saved of data.detected) {
    const item = state.detectedImages.find((detected) => detected.id === saved.id);

    if (item) {
      Object.assign(item, saved);
    }
  }

  state.removedGapIds = new Set(data.removedGapIds);
  state.cutOverrides = new Map(data.cutOverrides);
  state.customCuts = data.customCuts;
  state.sides = data.sides;
  state.trims = data.trims;
  state.excludedPartRanges = data.excludedPartRanges;

  afterRestore();
}

function updateButtons() {
  dom.undoButton.disabled = index <= 0;
  dom.redoButton.disabled = index < 0 || index >= entries.length - 1;
}

// restore：還原狀態後要執行的畫面更新。
export function initHistory(restore) {
  afterRestore = restore;
  updateButtons();
}

// 載入截圖後，以目前狀態作為第一筆紀錄。
export function resetHistory() {
  entries = [snapshot()];
  index = 0;
  updateButtons();
}

export function recordHistory() {
  if (!state.loaded || index < 0) return;

  // 拖曳中的狀態還沒確定，放開滑鼠後才記錄。
  if (state.dragCut || state.editDrag || state.isDragging) return;

  const entry = snapshot();

  if (entry === entries[index]) return;

  entries = entries.slice(0, index + 1);
  entries.push(entry);

  if (entries.length > LIMIT) {
    entries.shift();
  }

  index = entries.length - 1;
  updateButtons();
}

export function undo() {
  if (index <= 0) return false;

  index--;
  apply(entries[index]);
  updateButtons();

  return true;
}

export function redo() {
  if (index >= entries.length - 1) return false;

  index++;
  apply(entries[index]);
  updateButtons();

  return true;
}
