// 色彩主題：依設定套用「跟隨瀏覽器」「淺色」「深色」，設定改變時所有開著的頁面即時更新。

import { STORAGE_KEYS } from "./constants.js";
import { getDownloadSettings } from "./settings.js";

export const THEMES = ["system", "light", "dark"];

export function applyTheme(theme) {
  const root = document.documentElement;

  if (theme === "light" || theme === "dark") {
    root.dataset.theme = theme;
  } else {
    delete root.dataset.theme;
  }

  // 記住目前的主題，下次開啟頁面時由 theme-init.js 在繪製前先套用。
  try {
    localStorage.setItem("scc-theme", theme === "light" || theme === "dark" ? theme : "system");
  } catch (error) {
    // 無法儲存時不影響使用。
  }
}

export async function initTheme() {
  try {
    const settings = await getDownloadSettings();
    applyTheme(settings.theme);
  } catch (error) {
    applyTheme("system");
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEYS.downloadSettings]) {
      applyTheme(changes[STORAGE_KEYS.downloadSettings].newValue?.theme);
    }
  });
}
