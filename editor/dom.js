// 編輯頁的 DOM 元素。

const $ = (selector) => document.querySelector(selector);

export const dom = {
  stage: $("#canvasStage"),
  overlay: $("#overlay"),

  status: $("#status"),
  previewHint: $("#previewHint"),
  modeBadge: $("#modeBadge"),
  settingsButton: $("#settingsButton"),

  saveButton: $("#saveButton"),
  copySelectionButton: $("#copySelectionButton"),
  undoButton: $("#undoButton"),
  redoButton: $("#redoButton"),
  resetButton: $("#resetButton"),
  resetAllButton: $("#resetAllButton"),

  resultsContainer: $("#results"),
  resultsTitle: $("#resultsTitle"),
  resultsInstruction: $("#resultsInstruction"),

  // 單張截圖
  imageBatchControls: $("#imageBatchControls"),
  selectAllButton: $("#selectAllButton"),
  deselectAllButton: $("#deselectAllButton"),
  downloadSelectedButton: $("#downloadSelectedButton"),

  // 長條截圖
  stitchBatchControls: $("#stitchBatchControls"),
  stitchDownloadControls: $("#stitchDownloadControls"),
  cutListContainer: $("#cutList"),
  partListContainer: $("#partList"),
  selectAllCutsButton: $("#selectAllCutsButton"),
  deselectAllCutsButton: $("#deselectAllCutsButton"),
  resetCutsButton: $("#resetCutsButton"),
  addCutButton: $("#addCutButton"),
  downloadAllGroupsButton: $("#downloadAllGroupsButton"),
  mergeDownloadButton: $("#mergeDownloadButton"),
  mergeWarning: $("#mergeWarning"),
  mergeDialog: $("#mergeDialog"),
  mergeDialogMessage: $("#mergeDialogMessage"),
  mergeDialogDetail: $("#mergeDialogDetail"),
  mergeDialogConfirm: $("#mergeDialogConfirm"),

  // 預覽縮放
  zoomOutButton: $("#zoomOutButton"),
  zoomInButton: $("#zoomInButton"),
  zoomLabel: $("#zoomLabel"),
  zoomFitButton: $("#zoomFitButton"),
  zoomActualButton: $("#zoomActualButton"),

  selectAllPartsButton: $("#selectAllPartsButton"),
  deselectAllPartsButton: $("#deselectAllPartsButton"),

  sessionControls: $("#sessionControls"),
  continueButton: $("#continueButton"),
  finishButton: $("#finishButton")
};

export function setStatus(text) {
  dom.status.textContent = text;
}

// ---- 醒目的操作結果通知 ----
// 下載、複製完成或失敗時，在畫面上方中央顯示彩色通知（成功為綠色、失敗為紅色），
// 避免使用者沒注意到而重複按下。點一下通知可以立即關閉。

const toast = document.createElement("div");
toast.className = "toast";
toast.setAttribute("role", "status");
toast.setAttribute("aria-live", "polite");
document.body.appendChild(toast);

let toastTimer = null;

function hideToast() {
  toast.classList.remove("show");
}

toast.addEventListener("click", hideToast);

// kind："success" 或 "error"。狀態列也會同步顯示相同文字。
export function notify(text, kind = "success") {
  setStatus(text);

  toast.replaceChildren();

  const icon = document.createElement("span");
  icon.className = "toastIcon";
  icon.textContent = kind === "error" ? "✕" : "✓";

  const message = document.createElement("span");
  message.textContent = text;

  toast.append(icon, message);
  toast.className = `toast ${kind}`;

  // 重新觸發動畫：先移除再加上 show。
  void toast.offsetWidth;
  toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, kind === "error" ? 8000 : 4500);
}

// 按鈕暫時顯示「✓ 已儲存」等完成狀態，2.5 秒後恢復原本的文字（或執行傳入的函式重新設定）。
export function flashButton(button, text, originalText) {
  button.textContent = text;
  button.classList.add("done");

  clearTimeout(button.flashTimer);
  button.flashTimer = setTimeout(() => {
    button.classList.remove("done");

    if (typeof originalText === "function") {
      originalText();
    } else {
      button.textContent = originalText;
    }
  }, 2500);
}
