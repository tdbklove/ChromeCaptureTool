// 目前進行中的截圖工作與停止要求。
//
// 同一時間只允許一項截圖工作，避免捲動與截圖互相干擾。
// 使用者要求停止長截圖或翻頁截圖時，擷取迴圈會在下一個檢查點結束，保留已擷取的部分。

let busyTask = null;
let stopRequested = false;

// "single"（單張截圖）、"stitch"（長截圖）、"pages"（翻頁截圖）或 null。
export function getBusyTask() {
  return busyTask;
}

export function isStopRequested() {
  return stopRequested;
}

export function beginTask(name) {
  if (busyTask) {
    throw new Error(
      busyTask === "stitch"
        ? "長截圖正在進行中，請等待完成後再試。"
        : busyTask === "pages"
        ? "翻頁截圖正在進行中，請等待完成後再試。"
        : "目前已有截圖工作正在執行。"
    );
  }

  busyTask = name;
  stopRequested = false;
}

export function endTask() {
  busyTask = null;
  stopRequested = false;
}

export function requestStop() {
  if (busyTask !== "stitch" && busyTask !== "pages") {
    throw new Error("目前沒有進行中的長截圖或翻頁截圖。");
  }

  stopRequested = true;
}
