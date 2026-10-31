// IndexedDB：暫存截圖（Blob）與下載資料夾的權限。
// 背景程式（Service Worker）與編輯頁、設定頁共用這一份程式，確保資料庫結構一致。

const DB_NAME = "ScreenshotStitchDB";

// 版本 1：frames（長截圖片段）。
// 版本 2：補建可能缺少的資料表。
// 版本 3：新增 captures（單張截圖）與 handles（下載資料夾）。
const DB_VERSION = 3;

const FRAMES = "frames";
const CAPTURES = "captures";
const HANDLES = "handles";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // 不論從哪一個版本升級（或全新建立），都只補建缺少的資料表，保留既有資料。
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(FRAMES)) {
        const store = db.createObjectStore(FRAMES, { keyPath: "id" });
        store.createIndex("jobId", "jobId", { unique: false });
      }

      if (!db.objectStoreNames.contains(CAPTURES)) {
        db.createObjectStore(CAPTURES, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(HANDLES)) {
        db.createObjectStore(HANDLES);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 在單一交易中執行 work(store)，交易完成後回傳 work 設定的結果。
async function withStore(storeName, mode, work) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const box = { result: undefined };

    work(store, box);

    transaction.oncomplete = () => {
      db.close();
      resolve(box.result);
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };

    transaction.onabort = () => {
      db.close();
      reject(transaction.error || new Error("資料庫交易已中止。"));
    };
  });
}

function deleteByCursor(request) {
  request.onsuccess = () => {
    const cursor = request.result;

    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
}

// ---- 長截圖片段 ----

export function saveFrame(frame) {
  return withStore(FRAMES, "readwrite", (store) => {
    store.put(frame);
  });
}

export function getFrames(jobId) {
  return withStore(FRAMES, "readonly", (store, box) => {
    const request = store.index("jobId").getAll(IDBKeyRange.only(jobId));

    request.onsuccess = () => {
      box.result = request.result.sort((a, b) => a.index - b.index);
    };
  });
}

export function deleteFrames(jobId) {
  return withStore(FRAMES, "readwrite", (store) => {
    deleteByCursor(store.index("jobId").openCursor(IDBKeyRange.only(jobId)));
  });
}

// ---- 單張截圖 ----

export function saveCapture(capture) {
  return withStore(CAPTURES, "readwrite", (store) => {
    store.put(capture);
  });
}

export function getCapture(id) {
  return withStore(CAPTURES, "readonly", (store, box) => {
    const request = store.get(id);

    request.onsuccess = () => {
      box.result = request.result || null;
    };
  });
}

export function deleteCapture(id) {
  return withStore(CAPTURES, "readwrite", (store) => {
    store.delete(id);
  });
}

// 清除所有暫存截圖（瀏覽器重新啟動時使用，此時不會有編輯頁還開著）。
export async function clearAllCaptures() {
  await withStore(FRAMES, "readwrite", (store) => {
    store.clear();
  });

  await withStore(CAPTURES, "readwrite", (store) => {
    store.clear();
  });
}

// ---- 下載資料夾（File System Access API 的資料夾代號） ----

export function saveHandle(key, handle) {
  return withStore(HANDLES, "readwrite", (store) => {
    store.put(handle, key);
  });
}

export function getHandle(key) {
  return withStore(HANDLES, "readonly", (store, box) => {
    const request = store.get(key);

    request.onsuccess = () => {
      box.result = request.result || null;
    };
  });
}

export function deleteHandle(key) {
  return withStore(HANDLES, "readwrite", (store) => {
    store.delete(key);
  });
}
