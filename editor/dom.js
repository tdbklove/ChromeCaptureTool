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
