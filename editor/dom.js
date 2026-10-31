// 編輯頁的 DOM 元素。

const $ = (selector) => document.querySelector(selector);

export const dom = {
  stage: $("#canvasStage"),
  overlay: $("#overlay"),

  status: $("#status"),
  modeBadge: $("#modeBadge"),
  settingsButton: $("#settingsButton"),

  saveButton: $("#saveButton"),
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
  cutListContainer: $("#cutList"),
  selectAllCutsButton: $("#selectAllCutsButton"),
  deselectAllCutsButton: $("#deselectAllCutsButton"),
  resetCutsButton: $("#resetCutsButton"),
  addCutButton: $("#addCutButton"),
  downloadAllGroupsButton: $("#downloadAllGroupsButton"),
  mergeDownloadButton: $("#mergeDownloadButton"),

  sessionControls: $("#sessionControls"),
  continueButton: $("#continueButton"),
  finishButton: $("#finishButton")
};

export function setStatus(text) {
  dom.status.textContent = text;
}
