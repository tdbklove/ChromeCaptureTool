// 在頁面繪製前套用上次使用的色彩主題，避免先閃一下淺色再變成深色。
// （此檔以一般 script 同步載入；之後 lib/theme.js 會依最新設定再確認一次。）
(() => {
  try {
    const theme = localStorage.getItem("scc-theme");

    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  } catch (error) {
    // 無法讀取時沿用「跟隨瀏覽器」。
  }
})();
