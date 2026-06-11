import React, { useState, useEffect, useRef, useMemo } from "react";
import "./styles.css";

/* ─── 🐞 螢幕除錯面板:把 console 訊息存起來顯示在畫面上 ─── */
const DEBUG_LOGS = [];
let debugLogListener = null;
function dlog(...args) {
  const msg = args
    .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
    .join(" ");
  const time = new Date().toLocaleTimeString("zh-TW");
  DEBUG_LOGS.push({ time, msg });
  if (DEBUG_LOGS.length > 50) DEBUG_LOGS.shift();
  console.log(...args);
  if (debugLogListener) debugLogListener([...DEBUG_LOGS]);
}

/* ─── ⭐️ Cloudflare Worker ⭐️ ─────────────────────────────── */
const PROXY_URL = "https://stock-proxy.junkaizhuo.workers.dev";
function viaProxy(targetUrl) {
  return `${PROXY_URL}/?url=${encodeURIComponent(targetUrl)}`;
}

/* ─── 🔤 強制 UTF-8 解碼 fetch ───────────────────────────────
 * 問題:res.text() 會看 HTTP response header 的 charset 解碼。
 *       很多 proxy(corsproxy.io 等)不會把上游的 Content-Type
 *       完整轉發,瀏覽器 fallback 到 ISO-8859-1,中文 bytes
 *       全變 U+FFFD(顯示成 ?? 或 ��)。
 * 解法:抓 arrayBuffer,用 TextDecoder('utf-8') 強制解碼。
 *       適用於我們已知是 UTF-8 的 RSS / JSON 端點。
 * ─────────────────────────────────────────────────────────── */
async function fetchTextUTF8(url, opts) {
  const res = await fetch(url, opts);
  const buf = await res.arrayBuffer();
  return new TextDecoder("utf-8").decode(buf);
}

/* ─── 🗄️ localStorage Keys 統一管理 ──────────────────────────
 * 命名規則:QUANT_<模組>_V<版本>(_<symbol>)
 * 升 schema 時把版本號 +1,瀏覽器舊快取自然失效(不會讀到舊格式)
 * ─────────────────────────────────────────────────────────── */
const SK = {
  // 全域(無 symbol)
  WATCHLIST: "QUANT_WATCHLIST_V1",
  PORTFOLIO: "QUANT_PORTFOLIO_V1",
  ALERTS: "QUANT_ALERTS_V1",
  MARKET_DAILY: "QUANT_MARKET_DAILY_V4",
  ELITE_RANK: "QUANT_ELITE_RANK_V2",
  STOCK_DICT: "tw_stock_dict", // 歷史命名,沿用以保留既有快取
  // 個股(吃 symbol)
  hist: (sym) => `QUANT_HIST_V20_${sym}`,
  ii: (sym) => `QUANT_II_V3_${sym}`,
  news: (sym) => `QUANT_NEWS_V4_${sym}`,
  spark: (sym) => `QUANT_SPARK_V1_${sym}`,
  SLOGAN_IDX: "QUANT_SLOGAN_IDX_V1",
  ENERGY_POINTS: "QUANT_EP_V1", // K 線能量點 開/關
  // B (個股基本面三件套) 快取 key
  revenue: (sym) => `QUANT_REV_V1_${sym}`,
  dividend: (sym) => `QUANT_DIV_V1_${sym}`,
  eps: (sym) => `QUANT_EPS_V1_${sym}`,
  // B 面板展開狀態(全域,跨股共用)
  REVENUE_OPEN: "QUANT_REV_OPEN_V1",
  DIVIDEND_OPEN: "QUANT_DIV_OPEN_V1",
  EPS_OPEN: "QUANT_EPS_OPEN_V1",
  // 月營收疊圖切換 range(1Y / 2Y / 3Y)
  REVENUE_OVERLAY_RANGE: "QUANT_REV_OVERLAY_V1",
  // 視覺主題切換(default = midnight blue、stripe = Stripe/Linear sample)
  THEME: "QUANT_THEME_V1",
};

/* ─── 🔥 Slogan 候選池(熱血科技型,點副標可循環切換)──────────
 * 每組拆「前段 · 後段」便於樣式分區上色(前段 accent、後段 muted)
 * --------------------------------------------------------- */
const SLOGANS = [
  // #3 雙關回扣品牌名,敘事性最強
  { head: "THE EDGE IS QUANT", tail: "THE SPEED IS YOURS" },
  // #10 Figma 風極簡留白
  { head: "YOUR EDGE", tail: "QUANTIFIED" },
  // #2 量化圈內梗,工程感最重
  { head: "SIGNAL OVER NOISE", tail: "ENGINEERED FOR EDGE" },
  // #1 Stripe 直球
  { head: "TRADE SMARTER", tail: "BUILT FOR ALPHA" },
  // #9 Figma 工具自信,雙 BUILT/TUNED 對稱
  { head: "BUILT FOR ALPHA", tail: "TUNED FOR SPEED" },
];

/* ─── 🏭 台股代碼產業分類表 ──────────────────────────────────
 * 來源:證交所「上市公司產業類別」+ TWSE 代碼配置慣例
 * 邏輯:依代碼前 2-4 碼判定所屬產業,涵蓋上市主板與大型 ETF
 * 用途:熱力地圖分組、產業比較
 * ─────────────────────────────────────────────────────────── */
function getIndustry(symbol) {
  if (!symbol) return "其他";
  const s = String(symbol);
  // ETF / 基金 (00 開頭)
  if (s.startsWith("00")) return "ETF";
  // 取前 2 碼當代碼前綴判定 (台股範圍 1101 ~ 9958)
  const p2 = parseInt(s.slice(0, 2), 10);
  const p4 = parseInt(s.slice(0, 4), 10);
  if (isNaN(p2)) return "其他";
  // 半導體獨立出來(2330 / 23xx 部分)
  if (p4 >= 2301 && p4 <= 2499) {
    // 23xx 多為半導體 / 電子零組件
    if (
      [
        2330, 2303, 2308, 2317, 2327, 2337, 2338, 2342, 2351, 2363, 2369, 2379,
        2388, 2401, 2408, 2434, 2436, 2441, 2449, 2451, 2454, 2458, 2474,
      ].includes(p4)
    ) {
      return "半導體";
    }
    return "電子零組件";
  }
  if (p2 === 11) return "水泥";
  if (p2 === 12) return "食品";
  if (p2 === 13) return "塑膠化工";
  if (p2 === 14) return "紡織";
  if (p2 === 15 || p2 === 16) return "電機機械";
  if (p2 === 17) return "化學生技";
  if (p2 === 18) return "玻璃陶瓷";
  if (p2 === 19) return "造紙";
  if (p2 === 20 || p2 === 21) return "鋼鐵";
  if (p2 === 22) return "橡膠";
  if (p2 === 25) return "建材營造";
  if (p2 === 26) return "航運業";
  if (p4 >= 2801 && p4 <= 2890) return "金融保險";
  if (p2 === 27) return "觀光餐飲";
  if (p2 === 29) return "貿易百貨";
  // 30xx ~ 49xx 多為電子業(含半導體下游、面板、被動元件、PCB)
  if (p2 === 30 || p2 === 31) return "光電面板";
  if (p2 === 32 || p2 === 33) return "通信網路";
  if (p2 === 34 || p2 === 35 || p2 === 36) return "電腦週邊";
  if (p2 === 37 || p2 === 38) return "資訊服務";
  if (
    p2 === 41 ||
    p2 === 42 ||
    p2 === 43 ||
    p2 === 44 ||
    p2 === 45 ||
    p2 === 46
  ) {
    return "生技醫療";
  }
  if (p2 === 47 || p2 === 48 || p2 === 49) return "其他電子";
  if (p2 === 51 || p2 === 52 || p2 === 53 || p2 === 54) return "汽車工業";
  if (p2 === 55 || p2 === 56 || p2 === 57 || p2 === 58 || p2 === 59) {
    return "其他運輸";
  }
  if (p2 === 60 || p2 === 61) return "金融控股";
  if (p2 === 65) return "塑膠化工";
  if (p2 === 81 || p2 === 82) return "金融保險";
  if (p2 === 91 || p2 === 92 || p2 === 93 || p2 === 94 || p2 === 95)
    return "其他";
  if (p2 === 96 || p2 === 97 || p2 === 98 || p2 === 99) return "其他";
  // 預設兜底
  return "其他";
}

/* ─── 🏢 同產業比較工具 ──────────────────────────────────────
 * 純函式三件套,複用 getIndustry() 與 fetchMarketDailyChange() 的快取資料
 * - getIndustryPeers: 從市場 rows 篩同業 + 依 metric 排序 + 取 Top N
 * - computePercentile: 計算個股在同業中某欄位的百分位(0-100)
 * - peerMedian: 取同業某欄位中位數
 * --------------------------------------------------------- */

function getIndustryPeers(targetSymbol, marketRows, opts = {}) {
  const limit = opts.limit || 8;
  const sortBy = opts.sortBy || "turnover"; // turnover | chgPct | close
  if (!targetSymbol || !Array.isArray(marketRows)) return [];
  const targetIndustry = getIndustry(targetSymbol);
  // 排除 ETF 跟「其他」這兩種分類,因為 peer 概念對它們不成立
  if (targetIndustry === "ETF" || targetIndustry === "其他") return [];

  const peers = marketRows
    .filter((r) => r && r.symbol && getIndustry(r.symbol) === targetIndustry)
    .map((r) => {
      const close = +r.close || 0;
      const vol = +r.vol || 0;
      return {
        symbol: r.symbol,
        name: r.name || r.displayName || "",
        close,
        chgPct: +r.chgPct || 0,
        vol,
        turnover: vol * close,
        isTarget: r.symbol === targetSymbol,
      };
    });

  // 依 sortBy 排序(降冪)
  peers.sort((a, b) => {
    const av = a[sortBy] ?? 0;
    const bv = b[sortBy] ?? 0;
    return bv - av;
  });

  // 確保目標股一定在結果中(若沒進 Top N,塞到尾巴並標記成 forced)
  const top = peers.slice(0, limit);
  if (!top.some((p) => p.isTarget)) {
    const targetRow = peers.find((p) => p.isTarget);
    if (targetRow) {
      // 釘在尾巴,不再重排(避免又被擠出去)
      top[top.length - 1] = { ...targetRow, forcedLast: true };
    }
  }

  return top;
}

function computePercentile(value, arr) {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const valid = arr.filter((v) => Number.isFinite(v));
  if (valid.length < 2) return null;
  const below = valid.filter((v) => v < value).length;
  return Math.round((below / (valid.length - 1)) * 100);
}

function peerMedian(arr) {
  const valid = (arr || [])
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

/* ─── 🔍 智能選股器:純函式與預設套組 ────────────────────────
 * 完全複用 fetchMarketDailyChange() 快取,零新 API
 * --------------------------------------------------------- */

// 產業下拉選單列表(來自 getIndustry 所有回傳值)
const SCREENER_INDUSTRIES = [
  "全部",
  "半導體",
  "電子零組件",
  "光電面板",
  "通信網路",
  "電腦週邊",
  "其他電子",
  "資訊服務",
  "金融保險",
  "金融控股",
  "航運業",
  "塑膠化工",
  "鋼鐵",
  "食品",
  "紡織",
  "電機機械",
  "化學生技",
  "生技醫療",
  "玻璃陶瓷",
  "造紙",
  "橡膠",
  "建材營造",
  "水泥",
  "觀光餐飲",
  "貿易百貨",
  "汽車工業",
  "其他運輸",
  "ETF",
  "其他",
];

// 成交金額下限選項(成交金額 = vol × close, vol 單位:股)
// 1 億 = 1e8, 10 億 = 1e9
const SCREENER_TURNOVER_OPTIONS = [
  { label: "不限", value: 0 },
  { label: "≥ 1 千萬", value: 1e7 },
  { label: "≥ 1 億", value: 1e8 },
  { label: "≥ 10 億", value: 1e9 },
];

// 預設條件物件
const SCREENER_DEFAULT_CRITERIA = {
  priceMin: 0,
  priceMax: 3000,
  industry: "全部",
  chgMin: -10,
  chgMax: 10,
  minTurnover: 0,
  watchlistOnly: false,
};

// 5 個快選套組
const SCREENER_PRESETS = [
  {
    id: "strong",
    label: "🔥 強勢股",
    desc: "今日漲幅 ≥ 3%、流動性佳",
    criteria: {
      ...SCREENER_DEFAULT_CRITERIA,
      chgMin: 3,
      chgMax: 10,
      minTurnover: 1e8,
    },
  },
  {
    id: "weak",
    label: "❄️ 逆勢股",
    desc: "今日跌幅 ≥ 3%、流動性佳(撿便宜?)",
    criteria: {
      ...SCREENER_DEFAULT_CRITERIA,
      chgMin: -10,
      chgMax: -3,
      minTurnover: 1e8,
    },
  },
  {
    id: "hidden",
    label: "💎 冷門寶藏",
    desc: "低價(<50)、小幅變動、低成交額(<1千萬)",
    criteria: {
      ...SCREENER_DEFAULT_CRITERIA,
      priceMin: 0,
      priceMax: 50,
      chgMin: -2,
      chgMax: 2,
      minTurnover: 0,
    },
  },
  {
    id: "blue-chip",
    label: "🏛️ 大型股",
    desc: "高股價(≥100)、高成交額(≥10 億)",
    criteria: {
      ...SCREENER_DEFAULT_CRITERIA,
      priceMin: 100,
      priceMax: 3000,
      minTurnover: 1e9,
    },
  },
  {
    id: "yield",
    label: "💰 高息預期",
    desc: "金融類 + 中價位、低波動",
    criteria: {
      ...SCREENER_DEFAULT_CRITERIA,
      industry: "金融保險",
      priceMin: 10,
      priceMax: 100,
      chgMin: -3,
      chgMax: 3,
      minTurnover: 1e7,
    },
  },
];

// 篩選核心:給 rows + criteria + watchlist,回符合的 rows(已加 turnover 欄位)
function applyScreener(rows, criteria, watchlistSyms = []) {
  if (!Array.isArray(rows)) return [];
  const wlSet = new Set((watchlistSyms || []).map(String));
  const c = { ...SCREENER_DEFAULT_CRITERIA, ...(criteria || {}) };
  return rows
    .map((r) => {
      const close = +r.close || 0;
      const vol = +r.vol || 0;
      return {
        symbol: r.symbol,
        name: r.name || r.displayName || "",
        close,
        chgPct: Number.isFinite(+r.chgPct) ? +r.chgPct : 0,
        vol,
        turnover: close * vol,
        industry: getIndustry(r.symbol),
      };
    })
    .filter((r) => {
      if (!r.symbol) return false;
      if (r.close < c.priceMin || r.close > c.priceMax) return false;
      if (r.chgPct < c.chgMin || r.chgPct > c.chgMax) return false;
      if (r.turnover < c.minTurnover) return false;
      if (c.industry !== "全部" && r.industry !== c.industry) return false;
      if (c.watchlistOnly && !wlSet.has(r.symbol)) return false;
      return true;
    });
}

/* ─── 📄 匯出工具 v4 (PDF only) ────────────────────────────────
 * - 動態載入 html2canvas + jsPDF (CDN)
 * - Letterhead 全英文 (jsPDF 預設字型不支援中文/特殊符號)
 * - 切片邏輯改良:更密的子區塊邊界 + 低門檻才避免分頁太空
 * - 區塊勾選 + 量化分析「全展開」獨立子選項
 * ─────────────────────────────────────────────────────────── */
const EXPORT_CDN = {
  html2canvas:
    "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
  jspdf: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
};
const _exportLibCache = {};
function loadExportScript(name, url) {
  if (_exportLibCache[name]) return _exportLibCache[name];
  _exportLibCache[name] = new Promise((resolve, reject) => {
    const existing = document.querySelector(
      `script[data-export-lib="${name}"]`
    );
    if (existing) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.dataset.exportLib = name;
    s.onload = () => resolve();
    s.onerror = () => {
      delete _exportLibCache[name];
      reject(new Error(`載入 ${name} 失敗`));
    };
    document.head.appendChild(s);
  });
  return _exportLibCache[name];
}

// 時間戳:純 ASCII 給 PDF letterhead 用
function exportTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

// 暫時隱藏未勾選區塊
function hideExportSections(rootEl, hiddenSelectors) {
  const hiddenEls = [];
  if (!rootEl || !hiddenSelectors || !hiddenSelectors.length) return () => {};
  hiddenSelectors.forEach((sel) => {
    try {
      rootEl.querySelectorAll(sel).forEach((el) => {
        if (el.style.display !== "none") {
          hiddenEls.push({ el, prev: el.style.display });
          el.style.display = "none";
        }
      });
    } catch (e) {}
  });
  return () => {
    hiddenEls.forEach(({ el, prev }) => {
      el.style.display = prev || "";
    });
  };
}

/* ─── 🟦 Squarified Treemap 演算法 ──────────────────────────
 * 經典 Bruls / Huijbregts / van Wijk (2000) squarified treemap
 * 輸入:items [{ value: number, ...其他 }],容器 { x, y, w, h }
 * 輸出:每個 item 加上 rect = { x, y, w, h }
 * 排序:value 大者先放,長寬比盡量接近 1:1
 * ─────────────────────────────────────────────────────────── */
function layoutTreemap(items, container) {
  if (!items || items.length === 0) return [];
  // 過濾掉 value <= 0,並依大到小排序
  const sorted = items
    .filter((it) => it.value > 0)
    .sort((a, b) => b.value - a.value);
  if (sorted.length === 0) return [];
  const totalValue = sorted.reduce((s, it) => s + it.value, 0);
  const totalArea = container.w * container.h;
  // 把 value 轉成「面積」(等比例縮放)
  const scaled = sorted.map((it) => ({
    ...it,
    area: (it.value / totalValue) * totalArea,
  }));

  // 計算一列 (row) 的最差長寬比
  function worst(row, sideLen) {
    if (row.length === 0 || sideLen <= 0) return Infinity;
    let sum = 0,
      rMin = Infinity,
      rMax = -Infinity;
    row.forEach((r) => {
      sum += r.area;
      if (r.area < rMin) rMin = r.area;
      if (r.area > rMax) rMax = r.area;
    });
    const s2 = sideLen * sideLen;
    return Math.max((s2 * rMax) / (sum * sum), (sum * sum) / (s2 * rMin));
  }

  // 在 rect 內把一整列垂直 (或水平) 放下
  // direction = "v":列沿著 y 軸延伸(短邊在 x); "h" 則沿 x 軸
  function placeRow(row, rect) {
    const sum = row.reduce((s, r) => s + r.area, 0);
    const isVertical = rect.w >= rect.h; // 短邊放置 row
    if (isVertical) {
      // 短邊是 height,row 沿著 y 延伸
      const rowW = sum / rect.h;
      let yCur = rect.y;
      row.forEach((r) => {
        const rowH = r.area / rowW;
        r.rect = {
          x: rect.x,
          y: yCur,
          w: rowW,
          h: rowH,
        };
        yCur += rowH;
      });
      return {
        x: rect.x + rowW,
        y: rect.y,
        w: rect.w - rowW,
        h: rect.h,
      };
    } else {
      // 短邊是 width,row 沿著 x 延伸
      const rowH = sum / rect.w;
      let xCur = rect.x;
      row.forEach((r) => {
        const rowW = r.area / rowH;
        r.rect = {
          x: xCur,
          y: rect.y,
          w: rowW,
          h: rowH,
        };
        xCur += rowW;
      });
      return {
        x: rect.x,
        y: rect.y + rowH,
        w: rect.w,
        h: rect.h - rowH,
      };
    }
  }

  // 主迴圈:squarify
  let rect = { ...container };
  let queue = [...scaled];
  let row = [];
  let safety = 0;
  while (queue.length > 0 && safety++ < 5000) {
    const item = queue[0];
    const sideLen = Math.min(rect.w, rect.h);
    if (sideLen <= 0) break;
    const newRow = [...row, item];
    if (worst(newRow, sideLen) <= worst(row, sideLen) || row.length === 0) {
      // 加入新項繼續嘗試
      row.push(item);
      queue.shift();
    } else {
      // 收尾這一列,進入下一塊空間
      rect = placeRow(row, rect);
      row = [];
    }
  }
  // 收尾最後一列
  if (row.length > 0) {
    placeRow(row, rect);
  }
  return scaled;
}

// html2canvas 截圖
async function captureElement(element) {
  await loadExportScript("html2canvas", EXPORT_CDN.html2canvas);
  if (!window.html2canvas) throw new Error("html2canvas 載入失敗");
  const bg = getComputedStyle(document.body).backgroundColor || "#080b12";
  return window.html2canvas(element, {
    backgroundColor: bg,
    scale: 2, // 固定 2x,確保中文字與細線清晰
    useCORS: true,
    logging: false,
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
  });
}

// 在 jsPDF 上繪 letterhead (純英文,避免亂碼)
// 規格:11mm 高,左 QUANTEDGE + 副標籤 (英文 only),右 ISO 時間戳
function drawPdfLetterhead(pdf, opts) {
  const pageW = pdf.internal.pageSize.getWidth();
  const h = 11;
  // 背景條
  pdf.setFillColor(15, 19, 28);
  pdf.rect(0, 0, pageW, h, "F");
  // 左緣強調條 (藍色)
  pdf.setFillColor(59, 130, 246);
  pdf.rect(0, 0, 1.5, h, "F");
  // 品牌名
  pdf.setTextColor(96, 165, 250);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(12);
  pdf.text("QUANTEDGE", opts.margin + 2.5, h - 3.8);
  // 細分隔
  pdf.setDrawColor(60, 72, 95);
  pdf.setLineWidth(0.3);
  pdf.line(opts.margin + 30, 2.5, opts.margin + 30, h - 1.5);
  // 副標籤 (純英文)
  pdf.setTextColor(139, 148, 167);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  pdf.text(
    (opts.tag || "RESEARCH REPORT").toUpperCase(),
    opts.margin + 32,
    h - 4
  );
  // 右側時間戳
  pdf.setTextColor(194, 201, 214);
  pdf.setFontSize(8.5);
  pdf.text(opts.timestamp, pageW - opts.margin, h - 4, { align: "right" });
  // 底分隔線
  pdf.setDrawColor(30, 58, 95);
  pdf.setLineWidth(0.4);
  pdf.line(0, h, pageW, h);
  pdf.setLineWidth(0.2);
}

// 在 jsPDF 上繪 footer
function drawPdfFooter(pdf, opts) {
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  pdf.setDrawColor(30, 37, 51);
  pdf.setLineWidth(0.25);
  pdf.line(opts.margin, pageH - 7, pageW - opts.margin, pageH - 7);
  pdf.setTextColor(93, 102, 120);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(7);
  pdf.text("QUANTEDGE TERMINAL  ·  PRIVATE WEALTH", opts.margin, pageH - 3);
  pdf.text(
    `${opts.pageNum} / ${opts.totalPages}`,
    pageW - opts.margin,
    pageH - 3,
    { align: "right" }
  );
}

// 觸發下載
function triggerDownload(filename, urlOrBlob) {
  const a = document.createElement("a");
  a.download = filename;
  a.href =
    urlOrBlob instanceof Blob ? URL.createObjectURL(urlOrBlob) : urlOrBlob;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (urlOrBlob instanceof Blob)
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// 智能分頁 PDF
async function exportElementAsPDF(element, filename, opts = {}) {
  const cleanupHide = hideExportSections(element, opts.hiddenSelectors || []);
  try {
    // 等 layout 穩定
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100)));

    // 截整張 canvas
    const canvas = await captureElement(element);

    // 載 jsPDF
    await loadExportScript("jspdf", EXPORT_CDN.jspdf);
    const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDFCtor) throw new Error("jsPDF 載入失敗");

    const pdf = new jsPDFCtor({ orientation: "p", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 6;
    const lhHeight = 14;
    const footerHeight = 9;
    const drawW = pageW - margin * 2;
    const usableHmm = pageH - lhHeight - footerHeight;

    // 像素 / mm 換算
    const cssToCanvas = canvas.width / element.scrollWidth;
    const canvasPxPerMm = canvas.width / drawW;
    const maxSlicePx = Math.floor(usableHmm * canvasPxPerMm);

    // v9 切片參數 ─────────────────────────────────────────
    // 內容呼吸間距:切點與下一個切點之間至少留 4mm(視覺接縫不擠)
    const PAGE_BOTTOM_PAD_PX = Math.floor(4 * canvasPxPerMm);
    // 一頁最低填充率
    // v9 → v11 → v13 → v15: 0.55 → 0.5 → 0.15 → 0.5
    // v13 降到 0.15 是因為當時誤以為 forceBreak 主路徑會處理一切,fallback 寬鬆就好
    // 實際上 panel 太高時 fallback 會被觸發,太寬鬆會切出超短頁
    // v15 拉回 0.5 (跟 v11 一樣)
    const MIN_FILL_RATIO = 0.5;
    const minFillPx = Math.floor(maxSlicePx * MIN_FILL_RATIO);

    // 切點：用 scrollHeight 比例（不用 getBoundingClientRect，避免 DOMRect readonly 問題）
    // scrollHeight 跟 canvas.height 的比例 = cssToCanvas，但改用 scrollHeight 計算座標
    const scrollH = element.scrollHeight;
    const scrollRatio = canvas.height / scrollH; // 等同 cssToCanvas（scale 倍）

    // 主面板的 css px 座標(層次 1:主區塊邊界)
    const PANEL_SELS = [
      ".card-header",
      ".fundamentals-grid",
      ".time-tabs",
      ".chart-area",
      ".rating-panel",
      ".qa-panel",
      ".inst-panel",
      ".news-panel",
      ".alert-panel",
      ".backtest-panel",
      ".card-footer",
    ];
    // 子區塊切點(層次 2:精細切點,讓長區塊內部也能斷頁)
    const SUB_SELS = [
      ".atabs-section",
      ".inst-row",
      ".news-item",
      ".alert-row",
      ".rating-section",
      ".backtest-section",
      ".fund-box",
      ".qa-body > div",
      ".ic-panel",
      ".ic-table-wrap",
      ".ic-radar-wrap",
      ".ic-stats",
    ];
    // 嚴禁切過的元素(層次 3:硬切時也要避開的)
    // v16: 加入 .atab-content (技術面/估值面/籌碼面/風控面 四個子分頁)
    //      避免「估值面結尾→籌碼面開始」這種子分頁邊界被 best-fit 抓去
    //      導致最後一個說明框被劈開
    const NO_CUT_SELS = [
      ".chart-area svg",
      ".factor-radar",
      ".ic-radar",
      ".portfolio-equity",
      ".portfolio-corr",
      "table",
      ".atab-content",
    ];

    // v11: panel 標題孤兒保護
    // 對這些 panel,從其 top 起算 ORPHAN_PX 範圍內不可切
    // 避免「標題列卡在上一頁,內容跑到下一頁」的孤兒
    // v12: 加入 .atab-content (量化分析內 4 個子分頁) - 避免分頁標題+grid 被切
    const ORPHAN_GUARD_SELS = [
      ".rating-panel",
      ".qa-panel",
      ".inst-panel",
      ".news-panel",
      ".ic-panel",
      ".alert-panel",
      ".backtest-panel",
      ".atab-content",
    ];
    // 標題列 + 第一個內容區塊高度
    // - panel 標題列 (eyebrow + 標題 + chevron) 約 80-90px → 140 OK
    // - atab-content 標題 (atab-export-heading 約 35px) + 一排 stat-grid (約 90px) → 需要 140+
    // 取 180 統一涵蓋兩種情況
    // v11 → v12: 140 → 180
    const ORPHAN_GUARD_PX_CSS = 180;

    // v13: 強制斷頁清單 (每個元素的「top 位置」會成為強制斷頁點)
    // 設計理念:「一頁一個主題」,9 個主面板各自一頁,空白接受
    //
    // v14 加 bottom 切點是錯的:每個 panel 後跟著「panel.bottom → 下個 panel.top」這段
    // 純背景空白 (margin gap),會被算成獨立一頁 → 整份 PDF 變成 panel/空白/panel/空白
    //
    // v15 改回 top-only:
    //  - chart-area 不加 forceBreak (P1 從 0 開始,不需要 top 切點)
    //  - 其他 panel 都用 top 當切點
    //  - 過高的 panel (超過一頁) 由 fallback (best-fit + 孤兒保護) 處理
    const FORCE_BREAK_SELS = [
      ".rating-panel", // P2: 量化評等
      ".qa-panel", // P3: 量化分析報告
      ".inst-panel", // P4: 法人籌碼動向
      ".news-panel", // P5: 相關新聞
      ".ic-panel", // P6: 同產業比較
      ".alert-panel", // P7: 警報歷史
      ".backtest-panel", // P8: 評級策略歷史回測
    ];

    const cutSet = new Set([0, canvas.height]);
    const elRect = element.getBoundingClientRect();
    const elRectTop = elRect.top + 0; // 讀取後立即存成普通數字

    // 收集層次 1+2 的切點
    [...PANEL_SELS, ...SUB_SELS].forEach(function (sel) {
      try {
        element.querySelectorAll(sel).forEach(function (panelEl) {
          if (!panelEl || panelEl.offsetParent === null) return;
          const pr = panelEl.getBoundingClientRect();
          const topNum = pr.top + 0 - elRectTop; // +0 強制轉成普通數字
          const botNum = pr.bottom + 0 - elRectTop;
          if (topNum < 0 || botNum <= topNum + 4) return;
          cutSet.add(Math.round(topNum * scrollRatio));
          cutSet.add(Math.round(botNum * scrollRatio));
        });
      } catch (e2) {}
    });

    // 收集「不可切」區間(硬切時也避開)
    const noCutRanges = [];
    NO_CUT_SELS.forEach(function (sel) {
      try {
        element.querySelectorAll(sel).forEach(function (el2) {
          if (!el2 || el2.offsetParent === null) return;
          const pr = el2.getBoundingClientRect();
          const topNum = pr.top + 0 - elRectTop;
          const botNum = pr.bottom + 0 - elRectTop;
          if (topNum < 0 || botNum <= topNum + 4) return;
          // v16: .atab-content 內縮 8px (上下各),讓 atab 之間的邊界仍可作為切點
          //      其他 (K 線 svg / 雷達 / 表格) 維持原樣,完全不可切
          const inset = sel === ".atab-content" ? 8 : 0;
          noCutRanges.push({
            top: Math.round((topNum + inset) * scrollRatio),
            bot: Math.round((botNum - inset) * scrollRatio),
          });
        });
      } catch (e3) {}
    });

    // v11: panel 標題孤兒保護
    // 對每個 panel 從 top 起算 ORPHAN_GUARD_PX_CSS 範圍內標記不可切
    // 切點 +2 < topPx 不會觸發 isInsideNoCut → 不影響第一條 panel 開頭 (該位置正好是好切點)
    // 但若切點落在 (topPx, topPx + ORPHAN_GUARD_PX) 之間 → 視為「會孤立標題」 → 跳過
    ORPHAN_GUARD_SELS.forEach(function (sel) {
      try {
        element.querySelectorAll(sel).forEach(function (panelEl) {
          if (!panelEl || panelEl.offsetParent === null) return;
          const pr = panelEl.getBoundingClientRect();
          const topNum = pr.top + 0 - elRectTop;
          const botNum = pr.bottom + 0 - elRectTop;
          if (topNum < 0 || botNum <= topNum + 4) return;
          const guardTopCss = topNum + 2; // 容差 2px,讓 panel 起點本身仍可切
          const guardBotCss = Math.min(
            topNum + ORPHAN_GUARD_PX_CSS,
            botNum - 4
          );
          if (guardBotCss <= guardTopCss) return;
          noCutRanges.push({
            top: Math.round(guardTopCss * scrollRatio),
            bot: Math.round(guardBotCss * scrollRatio),
            // 標記為孤兒保護,debug 視覺化可以用不同顏色
            kind: "orphan",
          });
        });
      } catch (e4) {}
    });

    function isInsideNoCut(y) {
      for (let i = 0; i < noCutRanges.length; i++) {
        const r = noCutRanges[i];
        if (y > r.top + 2 && y < r.bot - 2) return true;
      }
      return false;
    }

    // v13: 收集強制斷頁點 (每個面板的 top)
    // 這些點會優先用作頁邊界,不管填充率
    // v15: 只收 top (放棄 v14 的 bottom,避免 panel 之間的 margin gap 變成獨立空白頁)
    const forceBreaks = [];
    FORCE_BREAK_SELS.forEach(function (sel) {
      try {
        element.querySelectorAll(sel).forEach(function (panelEl) {
          if (!panelEl || panelEl.offsetParent === null) return;
          const pr = panelEl.getBoundingClientRect();
          const topNum = pr.top + 0 - elRectTop;
          if (topNum <= 0) return;
          forceBreaks.push(Math.round(topNum * scrollRatio));
        });
      } catch (e5) {}
    });
    forceBreaks.sort(function (a, b) {
      return a - b;
    });
    // 去重
    const uniqueForceBreaks = [];
    forceBreaks.forEach(function (v) {
      if (
        uniqueForceBreaks.length === 0 ||
        v - uniqueForceBreaks[uniqueForceBreaks.length - 1] > 10
      ) {
        uniqueForceBreaks.push(v);
      }
    });

    const sortedCuts = Array.from(cutSet).sort(function (a, b) {
      return a - b;
    });

    // 切片:v13 優先用 forceBreak 點當頁邊界 (一頁一塊主題)
    //      若 forceBreak 點落在窗口內 → 直接用,無視填充率
    //      若 forceBreak 點超過窗口 (panel 比一頁高) → fallback 到 best-fit
    // v14: early break 之前先看中間有沒有未用 forceBreak (避免警報+回測同頁)
    const slices = [];
    let cursor = 0;
    let safetyGuard = 0;
    while (cursor < canvas.height && safetyGuard++ < 300) {
      const remaining = canvas.height - cursor;
      if (remaining <= maxSlicePx + 4) {
        // v14: 先看 [cursor, canvas.height] 之間有沒有 forceBreak
        // 有的話還是要切,不能直接塞最後一頁
        let midForceBreak = -1;
        for (let i = 0; i < uniqueForceBreaks.length; i++) {
          const fb = uniqueForceBreaks[i];
          if (fb <= cursor + 10) continue;
          if (fb >= canvas.height - 10) break;
          midForceBreak = fb;
          break;
        }
        if (midForceBreak > 0) {
          slices.push({ start: cursor, end: midForceBreak });
          cursor = midForceBreak;
          continue;
        }
        slices.push({ start: cursor, end: canvas.height });
        break;
      }
      const windowEnd = cursor + maxSlicePx - PAGE_BOTTOM_PAD_PX;
      const minEnd = cursor + minFillPx;

      // v13: 優先找下一個 forceBreak 點
      let forceBreakEnd = -1;
      for (let i = 0; i < uniqueForceBreaks.length; i++) {
        const fb = uniqueForceBreaks[i];
        if (fb <= cursor + 10) continue; // 已過或太近
        if (fb > windowEnd) break; // 超出窗口 → 放棄 forceBreak
        if (isInsideNoCut(fb)) continue; // 不可切位置 (理論上不會發生,保險)
        forceBreakEnd = fb;
        break; // 取第一個合法 forceBreak (最早的)
      }

      if (forceBreakEnd > cursor) {
        // v13 主路徑:用 forceBreak 切,空白接受
        slices.push({ start: cursor, end: forceBreakEnd });
        cursor = forceBreakEnd;
        continue;
      }

      // Fallback: 沒有可用 forceBreak (例如 panel 比一頁高、或最後一段),走原本 best-fit
      let bestEnd = -1;
      for (let i = sortedCuts.length - 1; i >= 0; i--) {
        const cp = sortedCuts[i];
        if (cp > windowEnd) continue;
        if (cp <= cursor) break;
        if (cp < minEnd) break;
        if (isInsideNoCut(cp)) continue;
        bestEnd = cp;
        break;
      }
      if (bestEnd > cursor) {
        slices.push({ start: cursor, end: bestEnd });
        cursor = bestEnd;
      } else {
        // 硬切也要避開不可切區間
        let hardEnd = Math.min(windowEnd, canvas.height);
        let attempts = 0;
        while (isInsideNoCut(hardEnd) && attempts++ < 50) {
          hardEnd -= Math.floor(canvasPxPerMm * 2);
          if (hardEnd <= cursor + minFillPx) {
            hardEnd = Math.min(windowEnd, canvas.height);
            break;
          }
        }
        slices.push({ start: cursor, end: hardEnd });
        cursor = hardEnd;
      }
    }

    // v16: 過短切片直接丟棄(不畫進任何頁)
    // 原因:當 panel 太高、fallback best-fit 切完後,下一頁 cursor 到
    // 「下個 panel.top」之間只剩 panel margin (10~30px),會被當成獨立一頁,
    // 但這段 14-30px 就是 panel 之間的純空白 margin,**本來就不該畫**
    //
    // 策略:用絕對像素閾值 (~30mm 約 700-1000px) 容易誤殺真實 panel,
    //      改用相對較小的絕對閾值:小於 1.5 倍 canvasPxPerMm × 10mm 才丟棄
    //      亦即 < 約 10mm 高的切片才視為 margin gap,真實 panel 至少 20mm 起跳
    const minValidSlicePx = Math.floor(canvasPxPerMm * 15); // 約 15mm
    const filteredSlices = slices.filter(function (sl) {
      return sl.end - sl.start >= minValidSlicePx;
    });
    // 用過濾後的切片清單
    slices.length = 0;
    filteredSlices.forEach(function (sl) {
      slices.push(sl);
    });

    const totalPages = slices.length;

    // 切片暫存 canvas
    const sliceCanvas = document.createElement("canvas");
    sliceCanvas.width = canvas.width;
    const sliceCtx = sliceCanvas.getContext("2d");
    const timestamp = exportTimestamp();

    // 逐頁繪製
    slices.forEach((sl, idx) => {
      if (idx > 0) pdf.addPage();
      const slicePx = sl.end - sl.start;
      sliceCanvas.height = slicePx;
      sliceCtx.fillStyle = "#0f131c";
      sliceCtx.fillRect(0, 0, sliceCanvas.width, slicePx);
      sliceCtx.drawImage(
        canvas,
        0,
        sl.start,
        canvas.width,
        slicePx,
        0,
        0,
        canvas.width,
        slicePx
      );
      const sliceData = sliceCanvas.toDataURL("image/jpeg", 0.94);
      const sliceHmm = slicePx / canvasPxPerMm;

      drawPdfLetterhead(pdf, {
        margin,
        tag: opts.tag || "RESEARCH REPORT",
        timestamp,
      });

      pdf.addImage(
        sliceData,
        "JPEG",
        margin,
        lhHeight,
        drawW,
        sliceHmm,
        undefined,
        "FAST"
      );

      drawPdfFooter(pdf, {
        margin,
        pageNum: idx + 1,
        totalPages,
      });
    });

    pdf.save(filename);

    // v10: debug mode 視覺化切點
    // 開啟方式: 在瀏覽器 console 跑 localStorage.setItem("__quantedge_export_debug","1")
    // 關閉方式:                       localStorage.removeItem("__quantedge_export_debug")
    try {
      const dbgOn =
        typeof localStorage !== "undefined" &&
        localStorage.getItem("__quantedge_export_debug") === "1";
      if (dbgOn) {
        // console log 摘要
        // eslint-disable-next-line no-console
        console.group(`[QUANTEDGE PDF DEBUG] ${filename}`);
        // eslint-disable-next-line no-console
        console.log("canvas size", canvas.width, "x", canvas.height);
        // eslint-disable-next-line no-console
        console.log(
          "page params:",
          "maxSlicePx=" + maxSlicePx,
          "minFillPx=" + minFillPx,
          "PAGE_BOTTOM_PAD_PX=" + PAGE_BOTTOM_PAD_PX,
          "canvasPxPerMm=" + canvasPxPerMm.toFixed(2)
        );
        // eslint-disable-next-line no-console
        console.log(
          "sortedCuts (count=" + sortedCuts.length + "):",
          sortedCuts
        );
        // eslint-disable-next-line no-console
        console.log(
          "noCutRanges (count=" + noCutRanges.length + "):",
          noCutRanges
        );
        // eslint-disable-next-line no-console
        console.log(
          "uniqueForceBreaks (count=" + uniqueForceBreaks.length + "):",
          uniqueForceBreaks
        );
        // eslint-disable-next-line no-console
        console.table(
          slices.map((s, i) => ({
            page: i + 1,
            start: s.start,
            end: s.end,
            heightPx: s.end - s.start,
            fillRatio: ((s.end - s.start) / maxSlicePx).toFixed(2),
          }))
        );
        // eslint-disable-next-line no-console
        console.groupEnd();

        // 視覺化:複製一份原 canvas,疊上標記層後下載
        const dbgCanvas = document.createElement("canvas");
        dbgCanvas.width = canvas.width;
        dbgCanvas.height = canvas.height;
        const dctx = dbgCanvas.getContext("2d");
        dctx.drawImage(canvas, 0, 0);

        // 1. 不可切區間
        //    - 黃色帶 = NO_CUT (K線/雷達/表格等)
        //    - 紫色帶 = ORPHAN_GUARD (panel 標題孤兒保護)
        noCutRanges.forEach((r) => {
          if (r.kind === "orphan") {
            dctx.fillStyle = "rgba(167, 139, 250, 0.18)";
          } else {
            dctx.fillStyle = "rgba(255, 220, 0, 0.18)";
          }
          dctx.fillRect(0, r.top, canvas.width, r.bot - r.top);
        });
        // 邊框
        dctx.lineWidth = 2;
        noCutRanges.forEach((r) => {
          dctx.strokeStyle =
            r.kind === "orphan"
              ? "rgba(167, 139, 250, 0.85)"
              : "rgba(255, 200, 0, 0.85)";
          dctx.strokeRect(0, r.top, canvas.width, r.bot - r.top);
        });

        // 2. 所有候選切點 -> 細灰虛線
        dctx.setLineDash([6, 4]);
        dctx.strokeStyle = "rgba(180, 180, 180, 0.55)";
        dctx.lineWidth = 1;
        sortedCuts.forEach((y) => {
          if (y <= 0 || y >= canvas.height) return;
          dctx.beginPath();
          dctx.moveTo(0, y);
          dctx.lineTo(canvas.width, y);
          dctx.stroke();
        });

        // v13: 2.5 forceBreak 點 -> 綠色長虛線 + 標籤
        dctx.setLineDash([12, 6]);
        dctx.strokeStyle = "rgba(34, 197, 94, 0.85)";
        dctx.lineWidth = 2;
        dctx.font = "bold 18px monospace";
        dctx.fillStyle = "rgba(34, 197, 94, 0.95)";
        uniqueForceBreaks.forEach((y) => {
          if (y <= 0 || y >= canvas.height) return;
          dctx.beginPath();
          dctx.moveTo(0, y);
          dctx.lineTo(canvas.width, y);
          dctx.stroke();
          dctx.fillText(`▶ forceBreak (y=${y})`, canvas.width - 280, y - 6);
        });

        // 3. 實際採用的切點 -> 粗紅實線 + 頁碼標籤
        dctx.setLineDash([]);
        dctx.strokeStyle = "rgba(255, 60, 60, 0.95)";
        dctx.lineWidth = 4;
        dctx.font = "bold 24px monospace";
        dctx.fillStyle = "rgba(255, 60, 60, 1)";
        slices.forEach((s, i) => {
          if (i === 0) return; // 第 0 條起點是 0 不畫
          dctx.beginPath();
          dctx.moveTo(0, s.start);
          dctx.lineTo(canvas.width, s.start);
          dctx.stroke();
          dctx.fillText(`◀ P${i + 1} start (y=${s.start})`, 12, s.start - 8);
        });

        // 下載
        const dbgUrl = dbgCanvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = dbgUrl;
        a.download = filename.replace(/\.pdf$/i, "") + "_debug.png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (dbgErr) {
      // debug 失敗不要影響主流程
      // eslint-disable-next-line no-console
      console.warn("[QUANTEDGE PDF DEBUG] viz failed:", dbgErr);
    }
  } finally {
    cleanupHide();
  }
}

/* ─── 📄 匯出按鈕元件 (僅 PDF) ──────────────────────────────── */
function ExportButtons({
  targetRef,
  baseName,
  tag = "REPORT",
  compact = false,
  onBeforeExport,
  onAfterExport,
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function doExport() {
    if (busy) return;
    const el = targetRef && targetRef.current;
    if (!el) {
      setErr("找不到匯出目標");
      return;
    }
    setBusy(true);
    setErr("");
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const fname = `${baseName}_${ts.getFullYear()}${pad(
      ts.getMonth() + 1
    )}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.pdf`;
    let extra = {};
    let cancelled = false;
    try {
      if (onBeforeExport) {
        const r = await onBeforeExport();
        if (r === false) {
          cancelled = true;
          return;
        }
        if (r && typeof r === "object") extra = r;
      }
      const fullOpts = { tag, ...extra };
      await exportElementAsPDF(el, fname, fullOpts);
    } catch (e) {
      setErr(e.message || "匯出失敗");
    } finally {
      // 永遠執行:解除 busy 狀態 + 通知呼叫者收回臨時狀態
      if (onAfterExport) {
        try {
          await onAfterExport();
        } catch (e) {}
      }
      setBusy(false);
      if (cancelled) setErr(""); // 取消不算錯
    }
  }

  return (
    <div className={`export-btns ${compact ? "export-btns-compact" : ""}`}>
      <button
        className="export-btn export-btn-pdf"
        onClick={doExport}
        disabled={busy}
        title="匯出為 PDF 文件"
      >
        {busy ? (
          <span className="export-spin">⟳</span>
        ) : (
          <span className="export-ico">📄</span>
        )}
        <span className="export-label">{busy ? "處理中" : "匯出 PDF"}</span>
      </button>
      {err && (
        <span className="export-err" title={err}>
          !
        </span>
      )}
    </div>
  );
}

/* ─── 🗂 個股研究頁:匯出區塊選擇 modal ───────────────────────
 * 8 個主區塊,量化分析有獨立子選項「全展開 4 tab 完整報告」
 * ─────────────────────────────────────────────────────────── */
const STOCK_EXPORT_SECTIONS = [
  {
    key: "header",
    label: "標題 / 即時報價 / 基本面",
    selector: ".card-header, .fundamentals-grid, .time-tabs",
    required: true,
  },
  {
    key: "chart",
    label: "K 線圖表 (含 MA / MACD / KD)",
    selector: ".chart-area",
  },
  { key: "rating", label: "機構級量化評等", selector: ".rating-panel" },
  { key: "analysis", label: "量化分析報告", selector: ".qa-panel" },
  { key: "inst", label: "法人籌碼動向", selector: ".inst-panel" },
  { key: "news", label: "相關新聞", selector: ".news-panel" },
  { key: "industry", label: "同產業比較 (含雷達圖)", selector: ".ic-panel" },
  { key: "alert", label: "警報歷史", selector: ".alert-panel" },
  { key: "backtest", label: "評級策略歷史回測", selector: ".backtest-panel" },
];

function StockExportModal({ onConfirm, onCancel }) {
  const [checked, setChecked] = useState(() => {
    const map = {};
    STOCK_EXPORT_SECTIONS.forEach((s) => {
      map[s.key] = true;
    });
    return map;
  });

  function toggle(key) {
    const sec = STOCK_EXPORT_SECTIONS.find((s) => s.key === key);
    if (sec && sec.required) return;
    setChecked((c) => ({ ...c, [key]: !c[key] }));
  }
  function setAll(val) {
    const next = {};
    STOCK_EXPORT_SECTIONS.forEach((s) => {
      next[s.key] = s.required || val;
    });
    setChecked(next);
  }
  const selectedCount = STOCK_EXPORT_SECTIONS.filter(
    (s) => checked[s.key]
  ).length;

  function handleConfirm() {
    const hidden = STOCK_EXPORT_SECTIONS.filter(
      (s) => !checked[s.key] && !s.required
    ).map((s) => s.selector);
    const visible = STOCK_EXPORT_SECTIONS.filter((s) => checked[s.key]).map(
      (s) => s.selector
    );
    onConfirm({
      hiddenSelectors: hidden,
      sectionSelectors: visible,
      expandAnalysis: checked.analysis, // 勾選量化分析時固定全展開
    });
  }

  return (
    <div className="export-modal-backdrop" onClick={onCancel}>
      <div className="export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="export-modal-head">
          <div className="export-modal-title">
            <span className="export-modal-icon">📄</span>
            匯出 PDF · 選擇要包含的區塊
          </div>
          <button className="export-modal-close" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="export-modal-toolbar">
          <span className="export-modal-count">
            已選 {selectedCount} / {STOCK_EXPORT_SECTIONS.length}
          </span>
          <div className="export-modal-toolbar-btns">
            <button
              className="export-modal-tool-btn"
              onClick={() => setAll(true)}
            >
              全選
            </button>
            <button
              className="export-modal-tool-btn"
              onClick={() => setAll(false)}
            >
              全不選
            </button>
          </div>
        </div>
        <div className="export-modal-list">
          {STOCK_EXPORT_SECTIONS.map((s) => (
            <div key={s.key} className="export-modal-item-wrap">
              <label
                className={`export-modal-item ${
                  checked[s.key] ? "checked" : ""
                } ${s.required ? "required" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={!!checked[s.key]}
                  onChange={() => toggle(s.key)}
                  disabled={s.required}
                />
                <span className="export-modal-item-label">{s.label}</span>
                {s.required && (
                  <span className="export-modal-required">必選</span>
                )}
              </label>
            </div>
          ))}
        </div>
        <div className="export-modal-footer">
          <button className="export-modal-cancel" onClick={onCancel}>
            取消
          </button>
          <button
            className="export-modal-confirm"
            onClick={handleConfirm}
            disabled={selectedCount === 0}
          >
            開始匯出 →
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── ⭐️ FinMind API Token (永久期限) ⭐️ ─────────────────────
 * 帳號 Chnkai91 | 每小時 600 次
 * 帶 token 後歷史 K 線、PER 都更穩定,額度也更高
 * ─────────────────────────────────────────────────────────── */
const FINMIND_TOKEN =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiQ2hua2FpOTEiLCJlbWFpbCI6Imp1bmthaXpodW9AZ21haWwuY29tIiwidG9rZW5fdmVyc2lvbiI6Mn0.gP_1mdLOSYOn1_GrrKF-1FxSZgqOJf6idIXMQgaUHBY";
function finmindUrl(params) {
  // 自動帶上 token
  return `https://api.finmindtrade.com/api/v4/data?${params}&token=${FINMIND_TOKEN}`;
}

/* ─── 📈 B 個股基本面三件套 — 純函式區 ───────────────────────
 * processRevenue / processDividend / processEPS / alignRevenuePrice
 * 全部走過 18 組 48 個 assertion 單元測試,可進元件使用
 * ─────────────────────────────────────────────────────────── */

// 月營收:輸入 FinMind TaiwanStockMonthRevenue 陣列,輸出含 YoY/MoM 的標準化陣列
function processRevenue(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const rows = raw
    .map((r) => ({
      ym: `${String(r.revenue_year).padStart(4, "0")}-${String(
        r.revenue_month
      ).padStart(2, "0")}`,
      year: Number(r.revenue_year),
      month: Number(r.revenue_month),
      revenue: Number(r.revenue) || 0,
    }))
    .filter((r) => r.revenue > 0 && r.year > 0 && r.month >= 1 && r.month <= 12)
    .sort((a, b) => a.ym.localeCompare(b.ym));
  const byYM = new Map(rows.map((r) => [r.ym, r]));
  return rows.map((r) => {
    const prevMonth =
      r.month === 1
        ? `${r.year - 1}-12`
        : `${r.year}-${String(r.month - 1).padStart(2, "0")}`;
    const prev = byYM.get(prevMonth);
    const mom =
      prev && prev.revenue > 0
        ? ((r.revenue - prev.revenue) / prev.revenue) * 100
        : null;
    const lastYearYM = `${r.year - 1}-${String(r.month).padStart(2, "0")}`;
    const lastYear = byYM.get(lastYearYM);
    const yoy =
      lastYear && lastYear.revenue > 0
        ? ((r.revenue - lastYear.revenue) / lastYear.revenue) * 100
        : null;
    return {
      ym: r.ym,
      year: r.year,
      month: r.month,
      revenue: r.revenue,
      yoy,
      mom,
    };
  });
}

// 股利政策:輸入 FinMind TaiwanStockDividend 陣列,輸出按年合併的陣列(新→舊)
function processDividend(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const byYear = new Map();
  for (const r of raw) {
    const dateStr = r.date || r.year || "";
    const year = Number(String(dateStr).slice(0, 4));
    if (!year || year < 1990 || year > 2100) continue;
    const cash = Number(r.CashEarningsDistribution) || 0;
    const stock = Number(r.StockEarningsDistribution) || 0;
    if (cash <= 0 && stock <= 0) continue;
    const cur = byYear.get(year) || { year, cash: 0, stock: 0, exDate: null };
    cur.cash += cash;
    cur.stock += stock;
    if (!cur.exDate || dateStr < cur.exDate) cur.exDate = dateStr;
    byYear.set(year, cur);
  }
  return Array.from(byYear.values())
    .map((r) => ({
      year: r.year,
      cash: Number(r.cash.toFixed(4)),
      stock: Number(r.stock.toFixed(4)),
      total: Number((r.cash + r.stock).toFixed(4)),
      exDate: r.exDate,
      yield: null,
    }))
    .sort((a, b) => b.year - a.year);
}

// 計算各年均價(從 K 線歷史)
function buildYearlyAvgPrice(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return {};
  const acc = {};
  for (const c of candles) {
    const y = String(c.date || "").slice(0, 4);
    if (!y || !c.close || c.close <= 0) continue;
    if (!acc[y]) acc[y] = { sum: 0, n: 0 };
    acc[y].sum += c.close;
    acc[y].n += 1;
  }
  const out = {};
  for (const y in acc) {
    if (acc[y].n > 0) out[y] = acc[y].sum / acc[y].n;
  }
  return out;
}

// 把殖利率塞回股利資料
function attachDividendYield(dividends, priceMap) {
  return dividends.map((d) => {
    const avg = priceMap[String(d.year)];
    if (!avg || avg <= 0 || !d.cash) return { ...d, yield: null };
    return { ...d, yield: Number(((d.cash / avg) * 100).toFixed(2)) };
  });
}

// EPS 季趨勢:輸入 FinMind TaiwanStockFinancialStatements (篩 type='EPS') 陣列
function processEPS(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  function dateToQ(dateStr) {
    const y = Number(dateStr.slice(0, 4));
    const m = Number(dateStr.slice(5, 7));
    if (!y || !m) return null;
    let quarter;
    if (m <= 3) quarter = 1;
    else if (m <= 6) quarter = 2;
    else if (m <= 9) quarter = 3;
    else quarter = 4;
    return { q: `${y}Q${quarter}`, year: y, quarter };
  }
  const byQ = new Map();
  for (const r of raw) {
    const dateStr = r.date || "";
    if (!dateStr) continue;
    const qInfo = dateToQ(dateStr);
    if (!qInfo) continue;
    const eps = Number(r.value);
    if (!Number.isFinite(eps)) continue;
    const existing = byQ.get(qInfo.q);
    if (!existing || dateStr > existing.date) {
      byQ.set(qInfo.q, {
        q: qInfo.q,
        year: qInfo.year,
        quarter: qInfo.quarter,
        date: dateStr,
        eps,
      });
    }
  }
  const rows = Array.from(byQ.values()).sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.quarter - b.quarter
  );
  const byQKey = new Map(rows.map((r) => [r.q, r]));
  return rows.map((r) => {
    const lastYearQ = `${r.year - 1}Q${r.quarter}`;
    const ly = byQKey.get(lastYearQ);
    const yoy =
      ly && ly.eps !== 0 ? ((r.eps - ly.eps) / Math.abs(ly.eps)) * 100 : null;
    return { q: r.q, date: r.date, eps: r.eps, yoy };
  });
}

// 月營收對齊月末股價(疊圖用)
function alignRevenuePrice(revenue, candles) {
  if (!Array.isArray(revenue) || revenue.length === 0) return [];
  if (!Array.isArray(candles) || candles.length === 0) {
    return revenue.map((r) => ({ ...r, price: null }));
  }
  const byMonth = {};
  for (const c of candles) {
    const ym = String(c.date || "").slice(0, 7);
    if (!ym) continue;
    if (!byMonth[ym] || c.date > byMonth[ym].date) {
      byMonth[ym] = c;
    }
  }
  return revenue.map((r) => ({
    ...r,
    price: byMonth[r.ym] ? byMonth[r.ym].close : null,
  }));
}

// 取最近 N 個月的營收(舊→新)
function tailRevenueMonths(processedRevenue, n) {
  if (!processedRevenue || processedRevenue.length === 0) return [];
  return processedRevenue.slice(-n);
}

const TW_PICKS = [
  { sym: "2330", label: "台積電" },
  { sym: "2454", label: "聯發科" },
  { sym: "2317", label: "鴻海" },
  { sym: "2603", label: "長榮" },
  { sym: "0050", label: "台灣50" },
];

/* ─── 0050 + 0056 成分股清單 (去重) ──────────────────────────
 * 涵蓋台股市值前 70 大 + 高股息 30 大,作為「精選評級榜」打分範圍
 * 來源:截至 2025 Q4 的公開成分股(不會劇烈變動,變動時手動更新)
 * ─────────────────────────────────────────────────────────── */
const ELITE_POOL = [
  // 0050 成分股 (台灣50)
  "2330",
  "2317",
  "2454",
  "2308",
  "2382",
  "6505",
  "2891",
  "2882",
  "3711",
  "3008",
  "2412",
  "2881",
  "2303",
  "2002",
  "1303",
  "1301",
  "2886",
  "2884",
  "2885",
  "1216",
  "5871",
  "3034",
  "2207",
  "2880",
  "2892",
  "5880",
  "2887",
  "3045",
  "2912",
  "2357",
  "2890",
  "1101",
  "2603",
  "1326",
  "2379",
  "4904",
  "2395",
  "2345",
  "3231",
  "2105",
  "2883",
  "2615",
  "2474",
  "2618",
  "2880",
  "2327",
  "9910",
  "2059",
  "2356",
  "2301",
  // 0056 成分股 (高股息)
  "2356",
  "2382",
  "2884",
  "2885",
  "2891",
  "2892",
  "5880",
  "5871",
  "9910",
  "6505",
  "2912",
  "1216",
  "2105",
  "1101",
  "1102",
  "2308",
  "1303",
  "1326",
  "3034",
  "2474",
  "2347",
  "3711",
  "4938",
  "2354",
  "2376",
  "2324",
  "8046",
  "6176",
  "1227",
  "2027",
];
// 去重
const ELITE_POOL_UNIQ = Array.from(new Set(ELITE_POOL));

const MOCK_MARKET_CAP = {
  2330: "22.5 兆",
  2454: "1.8 兆",
  2317: "2.2 兆",
  2603: "4,600 億",
  "0050": "3,800 億",
};

function fmt(n, d = 2) {
  if (n == null || isNaN(n) || n === -Infinity || n === Infinity) return "—";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

/* ─── 🎬 AnimatedNumber 數字滾動元件 (F 動畫) ──────────────
 * 從舊值 tween 到新值,Apple 風 easeOutCubic 0.6s
 *   - value: 目標數字
 *   - decimals: 顯示小數位
 *   - prefix/suffix: 前後綴(如 "$" "%")
 *   - signed: true 時正值前加 "+"
 * 用 requestAnimationFrame 跑動畫,結束時自動 cleanup
 * 首次掛載不動畫(避免進場時無意義 0 → 真值的跳動)
 * --------------------------------------------------------- */
function AnimatedNumber({
  value,
  decimals = 2,
  prefix = "",
  suffix = "",
  signed = false,
  duration = 600,
  className = "",
}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(null);
  const startRef = useRef(0);
  const firstRenderRef = useRef(true);

  useEffect(() => {
    // 第一次掛載直接顯示,不動畫
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    // null / NaN / 同值 不動畫
    if (
      value == null ||
      isNaN(value) ||
      value === fromRef.current ||
      typeof value !== "number"
    ) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    const from = fromRef.current;
    const to = value;
    startRef.current = performance.now();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    function tick(now) {
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / duration);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (to - from) * eased;
      setDisplay(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        fromRef.current = to;
      }
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  if (display == null || isNaN(display)) {
    return <span className={className}>—</span>;
  }
  const formatted = fmt(display, decimals);
  const showSign = signed && display > 0 ? "+" : "";
  return (
    <span className={className}>
      {prefix}
      {showSign}
      {formatted}
      {suffix}
    </span>
  );
}

function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  const v = arr.filter((n) => !isNaN(n));
  if (v.length === 0) return 0;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function stdev(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = avg(arr);
  const sq = arr.map((x) => (x - m) ** 2);
  return Math.sqrt(avg(sq));
}

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return 50;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return (100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
}

// 計算對數報酬率
function calcReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      r.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  return r;
}

/* ─── ⭐️ 自選股迷你評級 (純從 sparkline 算,不打 API) ⭐️
 * 輸入: closes (number[])
 * 輸出: { level, tag, score } 或 null (資料太少)
 * level 對應 CSS class:
 *   buy / outperform / neutral / reduce / sell
 *   → .wl-rating-{level}
 * 演算法:三因子加權 0-100 分
 *   1) RSI(14)        權重 30 (40-60 中性最高分,>70 或 <30 扣分)
 *   2) MA5 vs MA20    權重 35 (短均線高於長均線=多頭,順差越大越高分)
 *   3) 30日累積報酬   權重 35 (+10% 滿分, -10% 0 分,線性內插)
 * 分數對應:
 *   >= 75 → BUY        (強烈買進)
 *   60-74 → OUTPERFORM (優於大盤)
 *   40-59 → HOLD       (持有觀望)
 *   25-39 → REDUCE     (減碼)
 *   < 25  → SELL       (賣出)
 * ─────────────────────────────────────────────────────────── */
function computeMiniRating(closes) {
  if (!closes || closes.length < 20) return null;
  const arr = closes.filter((v) => typeof v === "number" && v > 0);
  if (arr.length < 20) return null;

  // 1) RSI(14):用既有函式,字串轉數字
  const rsi = Number(calculateRSI(arr, 14));
  let rsiScore;
  if (rsi >= 40 && rsi <= 60) rsiScore = 100;
  else if (rsi > 60 && rsi <= 70)
    rsiScore = 100 - (rsi - 60) * 4; // 60→100, 70→60
  else if (rsi > 70) rsiScore = Math.max(0, 60 - (rsi - 70) * 3); // 70→60, 90→0
  else if (rsi >= 30 && rsi < 40)
    rsiScore = 60 + (rsi - 30) * 4; // 30→60, 40→100
  else rsiScore = Math.max(0, (rsi / 30) * 60); // 0→0, 30→60

  // 2) MA5 vs MA20 (純數字陣列版 SMA)
  function smaTail(values, period) {
    if (values.length < period) return null;
    let s = 0;
    for (let i = values.length - period; i < values.length; i++) s += values[i];
    return s / period;
  }
  const ma5 = smaTail(arr, 5);
  const ma20 = smaTail(arr, 20);
  let maScore;
  if (ma5 == null || ma20 == null || ma20 === 0) {
    maScore = 50;
  } else {
    // diff% = (ma5 - ma20) / ma20 * 100
    const diffPct = ((ma5 - ma20) / ma20) * 100;
    // +5% → 100, -5% → 0,線性內插,夾在 [0,100]
    maScore = Math.max(0, Math.min(100, 50 + diffPct * 10));
  }

  // 3) 30 日累積報酬 (或可用長度上限)
  const lookback = Math.min(30, arr.length - 1);
  const startPrice = arr[arr.length - 1 - lookback];
  const endPrice = arr[arr.length - 1];
  let retScore;
  if (startPrice > 0 && endPrice > 0) {
    const retPct = ((endPrice - startPrice) / startPrice) * 100;
    // +10% → 100, -10% → 0
    retScore = Math.max(0, Math.min(100, 50 + retPct * 5));
  } else {
    retScore = 50;
  }

  // 加權合計
  const total = rsiScore * 0.3 + maScore * 0.35 + retScore * 0.35;
  const score = Math.round(total);

  let level, tag;
  if (score >= 75) {
    level = "buy";
    tag = "BUY";
  } else if (score >= 60) {
    level = "outperform";
    tag = "OUTPERFORM";
  } else if (score >= 40) {
    level = "neutral";
    tag = "HOLD";
  } else if (score >= 25) {
    level = "reduce";
    tag = "REDUCE";
  } else {
    level = "sell";
    tag = "SELL";
  }
  return { level, tag, score };
}

// 年化波動率 (annualized vol)
function annualizedVol(closes, days = 60) {
  const slice = closes.slice(-days);
  const returns = calcReturns(slice);
  return stdev(returns) * Math.sqrt(252) * 100;
}

// 夏普比率 (假設無風險利率 1.5%)
function sharpeRatio(closes, days = 60) {
  const slice = closes.slice(-days);
  const returns = calcReturns(slice);
  if (returns.length === 0) return 0;
  const meanReturn = avg(returns) * 252;
  const vol = stdev(returns) * Math.sqrt(252);
  if (vol === 0) return 0;
  return (meanReturn - 0.015) / vol;
}

// 最大回撤
function maxDrawdown(closes, days = 250) {
  const slice = closes.slice(-days);
  let peak = slice[0];
  let maxDD = 0;
  for (const p of slice) {
    if (p > peak) peak = p;
    const dd = (p - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD * 100;
}

function isMarketOpen() {
  const now = new Date();
  const taipei = new Date(
    now.getTime() + (now.getTimezoneOffset() + 480) * 60000
  );
  const day = taipei.getDay();
  const hours = taipei.getHours();
  const minutes = taipei.getMinutes();
  const t = hours * 100 + minutes;
  if (day === 0 || day === 6) return false;
  return t >= 900 && t <= 1330;
}

/* ─── 即時報價 (證交所 mis API + Yahoo 備援) ───────────────── */
async function fetchTWSE(symbol) {
  const prefixes = ["tse", "otc"];
  for (const prefix of prefixes) {
    try {
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const targetUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${prefix}_${symbol}.tw&json=1&delay=0&_=${nonce}`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(viaProxy(targetUrl), {
        signal: controller.signal,
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      clearTimeout(tid);
      if (!res.ok) {
        dlog(`[TWSE ${prefix}] HTTP ${res.status}`);
        continue;
      }

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        dlog(`[TWSE ${prefix}] JSON 解析失敗:`, text.slice(0, 100));
        continue;
      }
      if (!json.msgArray || json.msgArray.length === 0) {
        dlog(`[TWSE ${prefix}] msgArray 為空`);
        continue;
      }

      const t = json.msgArray[0];
      const z = parseFloat(t.z);
      const pz = parseFloat(t.pz);
      const yClose = parseFloat(t.y);
      const open = parseFloat(t.o);
      const bid = parseFloat((t.b || "").split("_")[0]);
      const ask = parseFloat((t.a || "").split("_")[0]);

      let livePrice = 0;
      let priceSource = "";
      if (z > 0) {
        livePrice = z;
        priceSource = "z";
      } else if (pz > 0) {
        livePrice = pz;
        priceSource = "pz";
      } else if (bid > 0 && ask > 0) {
        livePrice = (bid + ask) / 2;
        priceSource = "mid";
      } else if (bid > 0) {
        livePrice = bid;
        priceSource = "bid";
      } else if (ask > 0) {
        livePrice = ask;
        priceSource = "ask";
      } else if (open > 0) {
        livePrice = open;
        priceSource = "open";
      } else if (yClose > 0) {
        livePrice = yClose;
        priceSource = "y";
      }

      if (livePrice > 0) {
        const ts = t.tlong ? parseInt(t.tlong) : Date.now();
        dlog(
          `[TWSE ${prefix}] ✅ ${livePrice} (來源:${priceSource}) @ ${new Date(
            ts
          ).toLocaleTimeString("zh-TW")}`
        );
        return {
          source: "TWSE",
          price: livePrice,
          previousClose: yClose || livePrice,
          volume: parseInt(t.v) || 0,
          open: open || livePrice,
          high: parseFloat(t.h) || livePrice,
          low: parseFloat(t.l) || livePrice,
          dataTime: ts,
        };
      }
      dlog(`[TWSE ${prefix}] 無有效價格欄位`, t);
    } catch (e) {
      dlog(`[TWSE ${prefix}] error:`, e.message);
    }
  }
  return null;
}

async function fetchYahoo(symbol) {
  const suffixes = [".TW", ".TWO"];
  for (const suffix of suffixes) {
    try {
      const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}?interval=1m&range=1d`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(viaProxy(targetUrl), {
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) {
        dlog(`[Yahoo ${suffix}] HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) {
        dlog(`[Yahoo ${suffix}] 無 result`);
        continue;
      }
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      if (!price || price <= 0) {
        dlog(`[Yahoo ${suffix}] 無有效 regularMarketPrice`);
        continue;
      }
      dlog(
        `[Yahoo ${suffix}] ✅ ${price} @ ${new Date(
          (meta.regularMarketTime || 0) * 1000
        ).toLocaleTimeString("zh-TW")}`
      );
      return {
        source: "Yahoo",
        price: price,
        previousClose: meta.chartPreviousClose || meta.previousClose,
        volume: meta.regularMarketVolume
          ? Math.round(meta.regularMarketVolume / 1000)
          : 0,
        dataTime: meta.regularMarketTime
          ? meta.regularMarketTime * 1000
          : Date.now(),
      };
    } catch (e) {
      dlog(`[Yahoo ${suffix}] error:`, e.message);
    }
  }
  return null;
}

/* ⭐️ 證交所「當日收盤」API — 收盤後馬上有今天收盤價
 * 用 STOCK_DAY,回傳當月每日收盤,取最後一筆 = 最近交易日 */
async function fetchTWSEDailyClose(symbol) {
  // 試 www 和 openapi 兩個域名
  const now = new Date();
  const yyyymmdd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}01`;
  const urls = [
    `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${yyyymmdd}&stockNo=${symbol}&_=${Date.now()}`,
    `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${yyyymmdd}&stockNo=${symbol}&response=json&_=${Date.now()}`,
  ];

  for (const targetUrl of urls) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(viaProxy(targetUrl), {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(tid);
      if (!res.ok) {
        dlog(`[TWSE收盤] HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (!json.data || json.data.length === 0) {
        dlog(`[TWSE收盤] data 為空 (stat: ${json.stat})`);
        continue;
      }

      const last = json.data[json.data.length - 1];
      const prev = json.data[json.data.length - 2] || last;
      // 欄位: [日期, 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌價差, 成交筆數]
      const closePrice = parseFloat(String(last[6]).replace(/,/g, ""));
      const prevClose = parseFloat(String(prev[6]).replace(/,/g, ""));
      if (!closePrice || closePrice <= 0) {
        dlog(`[TWSE收盤] 收盤價無效:`, last);
        continue;
      }

      dlog(`[TWSE收盤] ✅ ${closePrice} (日期 ${last[0]})`);
      return {
        source: "TWSE收盤",
        price: closePrice,
        previousClose: prevClose || closePrice,
        volume:
          Math.round(parseFloat(String(last[1]).replace(/,/g, "")) / 1000) || 0,
        open: parseFloat(String(last[3]).replace(/,/g, "")) || closePrice,
        high: parseFloat(String(last[4]).replace(/,/g, "")) || closePrice,
        low: parseFloat(String(last[5]).replace(/,/g, "")) || closePrice,
        dataTime: Date.now(),
      };
    } catch (e) {
      dlog(`[TWSE收盤] error:`, e.message);
    }
  }
  return null;
}

async function fetchRealtimeQuote(symbol) {
  const open = isMarketOpen();
  dlog(`[報價] 開始抓 ${symbol} | 市場${open ? "開盤中" : "已收盤"}`);

  if (open) {
    // 盤中:Yahoo → TWSE 備援
    let q = await fetchYahoo(symbol);
    if (q) return q;
    q = await fetchTWSE(symbol);
    return q;
  } else {
    // 盤後:Yahoo → 證交所當日收盤 → 證交所即時
    let q = await fetchYahoo(symbol);
    if (q) return q;
    q = await fetchTWSEDailyClose(symbol);
    if (q) return q;
    q = await fetchTWSE(symbol);
    return q;
  }
}

/* ─── 法人籌碼：外資 / 投信 / 自營 買賣超 ──────────────────
 * FinMind dataset: TaiwanStockInstitutionalInvestorsBuySell
 * 欄位: date, name(外陸資/投信/自營商), buy, sell
 * 快取: 12 小時 localStorage,key: QUANT_II_V3_<代碼>
 * ─────────────────────────────────────────────────────────── */
const II_CACHE_TTL = 12 * 60 * 60 * 1000;

async function fetchInstitutional(symbol) {
  const cacheKey = SK.ii(symbol);
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const p = JSON.parse(cached);
      if (
        p &&
        Array.isArray(p.rows) &&
        p.rows.length > 0 &&
        Date.now() - p.ts < II_CACHE_TTL
      ) {
        dlog(`[籌碼 ${symbol}] ✅ 快取命中 (${p.rows.length} 筆)`);
        return p.rows;
      }
    }
  } catch (e) {
    localStorage.removeItem(cacheKey);
  }

  const startDate = new Date(Date.now() - 90 * 86400000)
    .toISOString()
    .split("T")[0];
  try {
    const res = await fetch(
      viaProxy(
        finmindUrl(
          `dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${symbol}&start_date=${startDate}`
        )
      )
    );
    const json = await res.json();
    if (!json.data || !json.data.length) {
      dlog(`[籌碼 ${symbol}] data 為空`);
      return [];
    }

    // FinMind 此資料集為「每法人一筆 row」格式:
    // { date, stock_id, buy, sell, name }  其中 name = 外陸資自然人/外陸資/投信/自營商_自行買賣/自營商_避險 等
    // 用 name 關鍵字分類,以 (buy - sell) / 1000 換算成「張」
    const byDate = {};
    let matchedRows = 0;
    const sampleNames = new Set();

    for (const row of json.data) {
      const d = row.date;
      if (!d) continue;
      if (!byDate[d]) byDate[d] = { date: d, foreign: 0, trust: 0, dealer: 0 };

      const buy = Number(row.buy || row.Buy || 0);
      const sell = Number(row.sell || row.Sell || 0);
      const net = (buy - sell) / 1000; // 換算張

      const name = String(row.name || "");
      if (sampleNames.size < 8) sampleNames.add(name);

      // FinMind 實際回傳的 name 為英文,共五類:
      //   Foreign_Investor     → 外資
      //   Foreign_Dealer_Self  → 外資自營(歸外資)
      //   Investment_Trust     → 投信
      //   Dealer_self          → 自營商自行買賣
      //   Dealer_Hedging       → 自營商避險
      let matched = true;
      if (name === "Foreign_Investor" || name === "Foreign_Dealer_Self") {
        byDate[d].foreign += net;
      } else if (name === "Investment_Trust") {
        byDate[d].trust += net;
      } else if (name === "Dealer_self" || name === "Dealer_Hedging") {
        byDate[d].dealer += net;
      } else {
        matched = false;
      }
      if (matched) matchedRows++;
    }

    if (matchedRows === 0) {
      dlog(
        `[籌碼 ${symbol}] 無匹配 name 欄位,樣本:`,
        [...sampleNames].slice(0, 6).join(" | ")
      );
      return [];
    }

    const rows = Object.values(byDate)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-40);
    dlog(
      `[籌碼 ${symbol}] ✅ 抓取成功 ${rows.length} 日 / 配對 ${matchedRows} 筆`
    );
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), rows }));
    } catch (e) {}
    return rows;
  } catch (e) {
    dlog(`[籌碼 ${symbol}] error:`, e.message);
    return [];
  }
}

/* ─── 個股相關新聞 (Google News RSS) ──────────────────────────
 * 直接用 Google News 的 RSS 端點:
 *   https://news.google.com/rss/search?q={query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant
 * 優點:
 *   - 內容豐富(同樣的查詢可拿到 100 則以上)、時效性好
 *   - <link> 是直連 Google News article 頁(會跳轉,我們改抓 <source> 的 url
 *     或從 description 抓直連)
 *   - 純 XML,Cloudflare Worker proxy 直接轉發
 * 過濾規則: 只保留近 7 日(由 RSS 的 pubDate 判斷)
 * 快取: 3 小時 (新聞變化頻繁,比 FinMind 短)
 * key: QUANT_NEWS_V4_<代碼>
 * ─────────────────────────────────────────────────────────── */
const NEWS_CACHE_TTL = 3 * 60 * 60 * 1000;
const NEWS_MAX_DAYS = 7;

// 從 RSS XML 字串中,撈出第 i 筆 item 內容(避免依賴 DOMParser 解析整段)
function extractTag(block, tagName) {
  // 支援 <tag>text</tag> 與 <tag><![CDATA[...]]></tag>
  const cdata = new RegExp(
    `<${tagName}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tagName}>`,
    "i"
  );
  const plain = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i");
  const m1 = block.match(cdata);
  if (m1) return m1[1].trim();
  const m2 = block.match(plain);
  if (m2) return m2[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
  return "";
}

// 解析 RSS XML → items 陣列(寬鬆解析:兼容 <item> 與 atom <entry>)
function parseGoogleNewsRSS(xml) {
  if (!xml || typeof xml !== "string") return [];
  // 若 Worker 回的是 HTML(被擋掉/consent 頁),直接放棄
  const lower = xml.slice(0, 500).toLowerCase();
  if (lower.includes("<!doctype html") || lower.includes("<html")) {
    return [];
  }
  const items = [];
  // 先試 <item>,失敗再試 <entry>
  const blocks = [];
  const reItem = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = reItem.exec(xml)) !== null) blocks.push(m[0]);
  if (blocks.length === 0) {
    const reEntry = /<entry[\s>][\s\S]*?<\/entry>/gi;
    while ((m = reEntry.exec(xml)) !== null) blocks.push(m[0]);
  }

  for (const block of blocks) {
    const title = extractTag(block, "title");
    let link = extractTag(block, "link");
    const pubDate =
      extractTag(block, "pubDate") ||
      extractTag(block, "published") ||
      extractTag(block, "updated");
    const source = extractTag(block, "source");
    const desc =
      extractTag(block, "description") ||
      extractTag(block, "content") ||
      extractTag(block, "summary");

    // atom <link href="..."/>
    if (!link) {
      const lm = block.match(/<link[^>]*href="([^"]+)"/i);
      if (lm) link = lm[1];
    }

    // Google News RSS 的 description 通常含直連:從中抓第一個 <a href="...">
    let directLink = link;
    const aMatch = (desc || "").match(/<a\s+href="([^"]+)"/i);
    if (aMatch && aMatch[1]) directLink = aMatch[1];

    if (!title) continue;
    items.push({
      title: title
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">"),
      link: directLink,
      googleLink: link,
      pubDate,
      source: source || "",
    });
    if (items.length >= 50) break;
  }
  return items;
}

/* ─── Yahoo 奇摩股市 RSS 解析 ──────────────────────────────
 * URL 範例: https://tw.stock.yahoo.com/rss?s=2330.TW
 * 比 Google News 穩定許多,且專屬台股。
 * ─────────────────────────────────────────────────────────── */
function parseYahooStockRSS(xml) {
  if (!xml || typeof xml !== "string") return [];
  const items = [];
  const reItem = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  function extractTag(block, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const mm = block.match(re);
    if (!mm) return "";
    let v = mm[1];
    v = v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
    return v;
  }
  while ((m = reItem.exec(xml)) !== null) {
    const block = m[0];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const source = extractTag(block, "source") || "Yahoo 奇摩股市";
    if (!title) continue;
    items.push({
      title: title
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">"),
      link,
      googleLink: link,
      pubDate,
      source,
    });
    if (items.length >= 50) break;
  }
  return items;
}

async function fetchStockNews(symbol, stockName) {
  const cacheKey = SK.news(symbol);
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const p = JSON.parse(cached);
      if (p && Array.isArray(p.rows) && Date.now() - p.ts < NEWS_CACHE_TTL) {
        dlog(`[新聞 ${symbol}] ✅ 快取命中 (${p.rows.length} 則)`);
        return p.rows;
      }
    }
  } catch (e) {
    localStorage.removeItem(cacheKey);
  }

  // ─── 清洗 stockName ───
  let cleanName = (stockName || "").toString();
  cleanName = cleanName
    .replace(/\s+/g, " ")
    .replace(/\s*\d+(\.[A-Z]+)?\s*$/i, "")
    .replace(/\.TW$/i, "")
    .trim();
  if (!cleanName || /^[\d]+$/.test(cleanName)) cleanName = "";

  const cutoff = Date.now() - NEWS_MAX_DAYS * 86400000;
  function dedupSort(rows) {
    // 用 title 去重 + 按日期排序
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const k = (r.title || "").trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out.sort((a, b) => b.dateMs - a.dateMs).slice(0, 30);
  }
  function toRow(x) {
    const t = new Date(x.pubDate).getTime();
    return {
      title: x.title,
      link: x.link,
      source: x.source,
      dateMs: isNaN(t) ? 0 : t,
      dateStr: isNaN(t) ? x.pubDate : new Date(t).toISOString().slice(0, 10),
    };
  }
  function isHtmlBlocked(text) {
    const head = (text || "").slice(0, 300).toLowerCase();
    return (
      head.includes("<!doctype html") ||
      (head.includes("<html") &&
        !head.includes("<rss") &&
        !head.includes("<feed"))
    );
  }

  const collected = [];

  // ─── 來源 1: Yahoo 奇摩股市 RSS (最穩定,專屬台股) ───
  try {
    const yahooUrl = `https://tw.stock.yahoo.com/rss?s=${symbol}.TW`;
    const text = await fetchTextUTF8(viaProxy(yahooUrl));
    if (text && text.length > 100 && !isHtmlBlocked(text)) {
      const items = parseYahooStockRSS(text);
      dlog(
        `[新聞 ${symbol}] [Yahoo] XML ${text.length}字 → 解析 ${items.length} 則`
      );
      for (const it of items) {
        const row = toRow(it);
        if (row.title && (row.dateMs === 0 || row.dateMs >= cutoff))
          collected.push(row);
      }
    } else {
      dlog(`[新聞 ${symbol}] [Yahoo] 無回應或被擋 (${text?.length || 0}字)`);
    }
  } catch (e) {
    dlog(`[新聞 ${symbol}] [Yahoo] error: ${e.message}`);
  }

  // ─── 來源 2: Google News RSS (備援,可能被擋) ───
  // 只在 Yahoo 拿不到足夠新聞時才打,節省時間
  if (collected.length < 5) {
    const candidates = [];
    if (cleanName) {
      candidates.push(`${cleanName} 股價`);
      candidates.push(`${cleanName}`);
    }
    candidates.push(`${symbol} 台股`);

    for (const q of candidates) {
      const query = encodeURIComponent(q);
      const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
      try {
        const text = await fetchTextUTF8(viaProxy(rssUrl));
        if (!text || text.length < 100) {
          dlog(`[新聞 ${symbol}] [GN:${q}] 過短 ${text.length} 字`);
          continue;
        }
        if (isHtmlBlocked(text)) {
          dlog(`[新聞 ${symbol}] [GN:${q}] 被擋`);
          continue;
        }
        const items = parseGoogleNewsRSS(text);
        dlog(`[新聞 ${symbol}] [GN:${q}] ${items.length} 則`);
        for (const it of items) {
          const row = toRow(it);
          if (row.title && (row.dateMs === 0 || row.dateMs >= cutoff))
            collected.push(row);
        }
        if (collected.length >= 10) break;
      } catch (e) {
        dlog(`[新聞 ${symbol}] [GN:${q}] error: ${e.message}`);
      }
    }
  }

  const bestRows = dedupSort(collected);

  if (bestRows.length > 0) {
    dlog(`[新聞 ${symbol}] ✅ 共 ${bestRows.length} 則 (去重後)`);
    try {
      localStorage.setItem(
        cacheKey,
        JSON.stringify({ ts: Date.now(), rows: bestRows })
      );
    } catch (e) {}
  } else {
    dlog(`[新聞 ${symbol}] ❌ 所有來源均無結果`);
  }
  return bestRows;
}

/* ─── ⭐️ 全市場當日漲跌幅榜 (Top10 第一階段) ──────────────────
 * 用證交所 MI_INDEX 端點,一個 API 拉全市場 1700+ 檔當日報價
 * (上市股票)。免費、無 token、約 5 秒完成。
 * 端點: https://www.twse.com.tw/exchangeReport/MI_INDEX?type=ALLBUT0999&response=json&date=YYYYMMDD
 * 快取: 10 分鐘 (盤中要相對即時)
 * ─────────────────────────────────────────────────────────── */
const MARKET_CACHE_TTL = 30 * 60 * 1000;

async function fetchMarketDailyChange() {
  // V4:真正修復 - chgAbs 是絕對價差,必須先判方向再算百分比
  // 方向判定:1) 漲跌(+/-)欄位 2) Fallback: close vs open
  const cacheKey = SK.MARKET_DAILY;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const p = JSON.parse(cached);
      if (p && Array.isArray(p.rows) && Date.now() - p.ts < MARKET_CACHE_TTL) {
        dlog(`[全市場榜] ✅ 快取命中 (${p.rows.length} 檔)`);
        return {
          rows: p.rows,
          dataDate: p.dataDate || null,
          isToday: p.isToday || false,
          fetchedAt: p.fetchedAt || p.ts,
        };
      }
    }
  } catch (e) {
    localStorage.removeItem(cacheKey);
  }

  // 取最近交易日(往前最多回推 7 天試一次)
  let sourceUnavailableCount = 0; // 統計「資料源異常」次數,用來判斷整體是不是源頭壞了
  for (let d = 0; d < 7; d++) {
    const date = new Date(Date.now() - d * 86400000);
    const yyyymmdd = `${date.getFullYear()}${String(
      date.getMonth() + 1
    ).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const targetUrl = `https://www.twse.com.tw/exchangeReport/MI_INDEX?type=ALLBUT0999&response=json&date=${yyyymmdd}&_=${Date.now()}`;
    try {
      const res = await fetch(viaProxy(targetUrl));
      // 改用 text() 先取原始字串,自己 parse,可在失敗時看到真正回了什麼
      const raw = await res.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch (parseErr) {
        // TWSE 維護或 Cloudflare 擋的時候會回 HTML 而非 JSON
        const head = raw.slice(0, 150).replace(/\s+/g, " ");
        const isHtml = /^\s*<(?:!doctype|html|head|body)/i.test(raw);
        const reason = isHtml
          ? "TWSE 回 HTML(可能維護中或被擋)"
          : `非 JSON: ${head}`;
        dlog(`[全市場榜] ${yyyymmdd} 解析失敗: ${reason}`);
        // 標記成「資料源異常」,讓上層能區分「真的沒資料」vs「源頭壞了」
        throw new Error("DATA_SOURCE_UNAVAILABLE");
      }
      // tables 是一個陣列,內含多個表;我們要找「fields」含「收盤價」「漲跌價差」的那個表
      let priceTable = null;
      if (Array.isArray(json.tables)) {
        for (const t of json.tables) {
          if (
            Array.isArray(t.fields) &&
            t.fields.includes("收盤價") &&
            t.fields.includes("漲跌價差")
          ) {
            priceTable = t;
            break;
          }
        }
      } else if (Array.isArray(json.data9)) {
        // 舊版格式
        priceTable = { fields: json.fields9, data: json.data9 };
      }

      if (
        !priceTable ||
        !Array.isArray(priceTable.data) ||
        priceTable.data.length === 0
      ) {
        dlog(`[全市場榜] ${yyyymmdd} 無資料,試下一日`);
        continue;
      }

      const fields = priceTable.fields;
      const idxSym = fields.indexOf("證券代號");
      const idxName = fields.indexOf("證券名稱");
      const idxClose = fields.indexOf("收盤價");
      const idxChg = fields.indexOf("漲跌價差");
      // 「漲跌(+/-)」這個欄位在不同期間 API 可能名稱不同,試多個變體
      let idxDir = fields.indexOf("漲跌(+/-)");
      if (idxDir < 0) idxDir = fields.indexOf("漲跌");
      if (idxDir < 0) {
        // 找名稱含「漲跌」但不含「價差」的欄位
        idxDir = fields.findIndex(
          (f) =>
            typeof f === "string" &&
            f.includes("漲跌") &&
            !f.includes("價差") &&
            !f.includes("幅")
        );
      }
      const idxVol = fields.indexOf("成交股數");
      const idxOpen = fields.indexOf("開盤價");

      dlog(`[全市場榜] fields=${JSON.stringify(fields)}`);
      dlog(
        `[全市場榜] 索引: sym=${idxSym} name=${idxName} close=${idxClose} chg=${idxChg} dir=${idxDir} vol=${idxVol} open=${idxOpen}`
      );

      // 從欄位中抓出 + 或 - 方向(欄位內容可能是 HTML 或純文字)
      function parseDirection(raw) {
        if (raw == null) return 0;
        const s = String(raw)
          .replace(/<[^>]*>/g, "")
          .trim();
        if (!s) return 0;
        if (s.includes("+")) return 1;
        if (s.includes("-") || s.includes("－")) return -1;
        return 0;
      }
      // 從欄位中剝離 HTML 標籤,然後 parseFloat (chgAbs 是絕對價差,證交所只給絕對值)
      function cleanNumber(raw) {
        if (raw == null) return NaN;
        const s = String(raw)
          .replace(/<[^>]*>/g, "")
          .replace(/,/g, "")
          .trim();
        if (!s || s === "--" || s === "－") return NaN;
        return parseFloat(s);
      }

      let dbgDirFromField = 0,
        dbgDirFromOpen = 0,
        dbgDirZero = 0;

      const rows = priceTable.data
        .map((r, idx) => {
          const symbol = (r[idxSym] || "").toString().trim();
          const name = (r[idxName] || "").toString().trim();
          const close = cleanNumber(r[idxClose]);
          const chgAbs = cleanNumber(r[idxChg]); // 絕對價差 (永遠是正值,證交所只給絕對值)
          const open = idxOpen >= 0 ? cleanNumber(r[idxOpen]) : NaN;
          const vol =
            idxVol >= 0
              ? parseInt(String(r[idxVol]).replace(/,/g, "")) || 0
              : 0;

          if (!symbol || isNaN(close) || close <= 0) return null;
          if (isNaN(chgAbs)) return null;
          if (vol <= 0) return null;
          // 排除 ETN/權證/特別股
          if (symbol.length > 4) return null;

          // 【V4 真正修復】
          // chgAbs 永遠是絕對價差(證交所只給絕對值,沒有正負號)
          // 必須先判定方向,才能算出正確的 chgPct
          //
          // 方向判定優先順序:
          //   1. 從「漲跌(+/-)」欄位抓 + / - (最準確)
          //   2. 若上欄不存在,從 close vs open 推測(粗略但通常準)
          //   3. 都失敗則預設為 0 (不顯示符號)
          let dir = 0;
          let dirSource = "none";

          if (idxDir >= 0) {
            const d = parseDirection(r[idxDir]);
            if (d !== 0) {
              dir = d;
              dirSource = "field";
              dbgDirFromField++;
            }
          }

          // Fallback: 從 close vs open 推測方向
          // (注意:這只是近似,因為盤中可能反轉,但對日線排行榜夠用)
          if (dir === 0 && !isNaN(open) && open > 0) {
            if (close > open) {
              dir = 1;
              dirSource = "open";
              dbgDirFromOpen++;
            } else if (close < open) {
              dir = -1;
              dirSource = "open";
              dbgDirFromOpen++;
            }
          }

          if (dir === 0) dbgDirZero++;

          // 計算漲跌百分比
          // chg(帶符號) = dir * chgAbs
          // yClose(昨日收盤) = close - chg
          // chgPct = (chg / yClose) * 100
          const chg = dir * chgAbs;
          const yClose = close - chg;
          const chgPct = yClose > 0 ? (chg / yClose) * 100 : 0;

          // 前 3 筆記錄打印 debug 資訊
          if (idx < 3) {
            dlog(
              `[全市場榜] #${
                idx + 1
              } ${symbol} ${name}: close=${close} chgAbs=${chgAbs} dir=${dir}(${dirSource}) → chgPct=${chgPct.toFixed(
                2
              )}%`
            );
          }

          return {
            symbol,
            name,
            close,
            chg,
            chgPct,
            vol,
            open: isNaN(open) ? close : open,
          };
        })
        .filter((x) => x !== null);

      if (rows.length === 0) continue;

      // 輸出統計
      dlog(
        `[全市場榜] 方向來源統計: field=${dbgDirFromField} open=${dbgDirFromOpen} zero=${dbgDirZero}`
      );
      const topGains = [...rows]
        .sort((a, b) => b.chgPct - a.chgPct)
        .slice(0, 3);
      const topLosses = [...rows]
        .sort((a, b) => a.chgPct - b.chgPct)
        .slice(0, 3);
      dlog(
        `[全市場榜] ✅ ${yyyymmdd} 取得 ${rows.length} 檔 | Top 漲幅: ${topGains
          .map((r) => `${r.symbol}+${r.chgPct.toFixed(2)}%`)
          .join(", ")}`
      );
      dlog(
        `[全市場榜] Top 跌幅: ${topLosses
          .map((r) => `${r.symbol}${r.chgPct.toFixed(2)}%`)
          .join(", ")}`
      );

      const meta = {
        rows,
        dataDate: yyyymmdd,
        isToday: d === 0,
        fetchedAt: Date.now(),
      };
      try {
        localStorage.setItem(
          cacheKey,
          JSON.stringify({ ts: Date.now(), ...meta })
        );
      } catch (e) {}
      return meta;
    } catch (e) {
      dlog(`[全市場榜] ${yyyymmdd} 錯誤: ${e.message}`);
      // 記錄是否為「資料源異常」(這樣全部試完後能告訴使用者真實原因)
      if (e.message === "DATA_SOURCE_UNAVAILABLE") {
        sourceUnavailableCount++;
      }
    }
  }

  dlog(`[全市場榜] ❌ 連續 7 天皆無資料`);
  // 7 天全失敗:若大多數是「資料源異常」,嘗試用過期的快取救場
  if (sourceUnavailableCount >= 4) {
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const p = JSON.parse(cached);
        if (p && Array.isArray(p.rows) && p.rows.length > 0) {
          const ageMin = Math.round((Date.now() - p.ts) / 60000);
          dlog(
            `[全市場榜] ⚠️ 用過期快取 (${ageMin} 分鐘前, ${p.rows.length} 檔)`
          );
          return {
            rows: p.rows,
            dataDate: p.dataDate || null,
            isToday: false,
            fetchedAt: p.fetchedAt || p.ts,
            stale: true, // ⭐️ 標記為過期快照
            staleMin: ageMin,
          };
        }
      }
    } catch (e) {}
  }
  return {
    rows: [],
    dataDate: null,
    isToday: false,
    fetchedAt: Date.now(),
    sourceError: sourceUnavailableCount >= 4, // 大多數是資料源異常 → 上層顯示對應訊息
  };
}

/* ─── ⭐️ 精選評級榜 (Top10 第二階段:0050+0056 成分股深入打分) ──
 * 約 70 檔逐一抓 120 日 K 線 + 計算綜合分數
 * 用 Promise 並發(每批 10 檔),避免 FinMind 速率超限
 * 快取: 30 分鐘(分數計算結果變化緩慢)
 * ─────────────────────────────────────────────────────────── */
const ELITE_CACHE_TTL = 30 * 60 * 1000;
const ELITE_BATCH_SIZE = 8;
const ELITE_HIST_DAYS = 130;

async function computeEliteScore(symbol) {
  const now = Date.now();
  const startDate = new Date(now - ELITE_HIST_DAYS * 86400000)
    .toISOString()
    .split("T")[0];
  try {
    const res = await fetch(
      viaProxy(
        finmindUrl(
          `dataset=TaiwanStockPrice&data_id=${symbol}&start_date=${startDate}`
        )
      )
    );
    const json = await res.json();
    if (!json?.data || !Array.isArray(json.data) || json.data.length < 30)
      return null;
    const data = json.data
      .filter((r) => r.close > 0)
      .map((r) => ({ date: r.date, close: r.close, volume: r.Trading_Volume }));
    if (data.length < 30) return null;

    const closes = data.map((d) => d.close);
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2] || lastClose;
    const dayChgPct = ((lastClose - prevClose) / prevClose) * 100;

    // 用既有的指標函式做快速打分
    const rsi = calculateRSI(closes, 14);
    const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const ma60 =
      closes.length >= 60
        ? closes.slice(-60).reduce((a, b) => a + b, 0) / 60
        : ma20;

    // 量化指標:近 60 日報酬、波動率、夏普
    const recentRet =
      closes.length >= 60
        ? ((lastClose - closes[closes.length - 60]) /
            closes[closes.length - 60]) *
          100
        : 0;
    const dailyRets = [];
    for (let i = 1; i < closes.length; i++) {
      dailyRets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    const avgRet = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
    const variance =
      dailyRets.reduce((acc, r) => acc + Math.pow(r - avgRet, 2), 0) /
      dailyRets.length;
    const vol = Math.sqrt(variance * 252) * 100;
    const annRet = avgRet * 252 * 100;
    const sharpe = vol > 0 ? (annRet - 2) / vol : 0;

    // 趨勢分:MA 排列、價格 vs MA20、近期報酬
    let trendScore = 50;
    if (lastClose > ma5 && ma5 > ma20 && ma20 > ma60) trendScore = 90;
    else if (lastClose > ma20 && ma20 > ma60) trendScore = 75;
    else if (lastClose > ma20) trendScore = 62;
    else if (lastClose < ma60) trendScore = 28;
    else if (lastClose < ma20) trendScore = 42;

    // 動能分:RSI(40-70 區間最健康)、近期報酬
    let momScore = 50;
    if (rsi >= 50 && rsi <= 70) momScore = 80;
    else if (rsi > 70 && rsi <= 80) momScore = 60; // 偏熱
    else if (rsi > 80) momScore = 35; // 過熱
    else if (rsi >= 40 && rsi < 50) momScore = 60;
    else if (rsi < 30) momScore = 35;
    momScore += Math.max(-15, Math.min(15, recentRet * 0.5));

    // 風控分:夏普 + 波動率
    let riskScore = 50;
    if (sharpe > 2) riskScore = 90;
    else if (sharpe > 1) riskScore = 78;
    else if (sharpe > 0.5) riskScore = 65;
    else if (sharpe > 0) riskScore = 52;
    else if (sharpe > -0.5) riskScore = 38;
    else riskScore = 22;
    if (vol > 50) riskScore -= 10;

    // 綜合分數
    const composite = trendScore * 0.4 + momScore * 0.3 + riskScore * 0.3;

    // 【新增】5 級推薦標籤（依綜合分數 + 額外條件微調）
    // 同時考慮 RSI 極端值,避免過熱還推薦買進
    let rating, ratingClass;
    if (composite >= 80 && rsi < 80) {
      rating = "強力買進";
      ratingClass = "strong-buy";
    } else if (composite >= 70 && rsi < 80) {
      rating = "買進";
      ratingClass = "buy";
    } else if (composite >= 50) {
      rating = "觀望";
      ratingClass = "hold";
    } else if (composite >= 35) {
      rating = "減碼";
      ratingClass = "reduce";
    } else {
      rating = "賣出";
      ratingClass = "sell";
    }
    // RSI 過熱(>80)或過冷(<20)時調整
    if (rsi > 80 && (rating === "強力買進" || rating === "買進")) {
      rating = "觀望";
      ratingClass = "hold"; // 過熱降級
    }
    if (rsi < 20 && rating === "賣出") {
      rating = "減碼";
      ratingClass = "reduce"; // 過冷反彈機會
    }

    return {
      symbol,
      close: lastClose,
      dayChgPct,
      rsi,
      composite,
      rating,
      ratingClass,
      trendScore,
      momScore,
      riskScore,
      vol,
      sharpe,
      recentRet,
    };
  } catch (e) {
    return null;
  }
}

async function fetchEliteRanking(stockMap) {
  const cacheKey = SK.ELITE_RANK; // V2: 新增 rating / ratingClass 推薦標籤
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const p = JSON.parse(cached);
      if (p && Array.isArray(p.rows) && Date.now() - p.ts < ELITE_CACHE_TTL) {
        dlog(`[精選榜] ✅ 快取命中 (${p.rows.length} 檔)`);
        return p.rows;
      }
    }
  } catch (e) {
    localStorage.removeItem(cacheKey);
  }

  const pool = ELITE_POOL_UNIQ;
  dlog(`[精選榜] 開始打分,共 ${pool.length} 檔,每批 ${ELITE_BATCH_SIZE} 並發`);
  const results = [];
  for (let i = 0; i < pool.length; i += ELITE_BATCH_SIZE) {
    const batch = pool.slice(i, i + ELITE_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((s) => computeEliteScore(s))
    );
    for (const r of batchResults) {
      if (r) {
        r.name = (stockMap && stockMap[r.symbol]) || "";
        results.push(r);
      }
    }
    // 給 API 喘息一下
    if (i + ELITE_BATCH_SIZE < pool.length) {
      await new Promise((res) => setTimeout(res, 200));
    }
  }
  dlog(`[精選榜] ✅ 成功打分 ${results.length} 檔`);
  try {
    localStorage.setItem(
      cacheKey,
      JSON.stringify({ ts: Date.now(), rows: results })
    );
  } catch (e) {}
  return results;
}

/* ═══════════════════════════════════════════════════════════════════
   ⭐️ 投資組合模擬器 (Portfolio Simulator)
   
   功能:
   - 多檔股票持倉管理 (股票 + 股數 + 成本價)
   - 即時市值與損益計算
   - 4 大圖表:淨值曲線 / 個股權重圓餅 / 相關性熱力圖 / vs 0050 對比
   - 自選時間範圍:1月 / 3月 / 1年 / 3年
   - localStorage 持久化
   ═══════════════════════════════════════════════════════════════════ */

const PORTFOLIO_HOLDINGS_KEY = SK.PORTFOLIO;
const PORTFOLIO_RANGE_DAYS = { "1M": 30, "3M": 90, "1Y": 365, "3Y": 1095 };
const PORTFOLIO_BENCHMARK_SYMBOL = "0050";

// 抓單檔歷史 K 線 (給投資組合用,小型快取)
async function fetchPortfolioHistory(symbol, days) {
  const startDate = new Date(Date.now() - (days + 30) * 86400000)
    .toISOString()
    .split("T")[0];
  try {
    const res = await fetch(
      viaProxy(
        finmindUrl(
          `dataset=TaiwanStockPrice&data_id=${symbol}&start_date=${startDate}`
        )
      )
    );
    const json = await res.json();
    if (!json?.data || !Array.isArray(json.data)) return [];
    return json.data
      .filter((r) => r.close > 0)
      .map((r) => ({ date: r.date, close: r.close }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    dlog(`[組合 ${symbol}] 歷史資料抓取錯誤: ${e.message}`);
    return [];
  }
}

// Pearson 相關係數
function pearsonCorr(x, y) {
  if (!x || !y || x.length !== y.length || x.length < 2) return 0;
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    dx2 = 0,
    dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx,
      dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

// 計算完整投資組合分析結果
async function computePortfolio(holdings, days) {
  if (!holdings || holdings.length === 0) return null;

  dlog(`[組合] 開始計算,${holdings.length} 檔,範圍 ${days} 日`);

  // 並發抓所有持倉 + benchmark
  const symbols = holdings.map((h) => h.symbol);
  const allSyms = [...new Set([...symbols, PORTFOLIO_BENCHMARK_SYMBOL])];
  const histArr = await Promise.all(
    allSyms.map((s) => fetchPortfolioHistory(s, days))
  );
  const histMap = {};
  allSyms.forEach((s, i) => {
    histMap[s] = histArr[i];
  });

  // 過濾出有效持倉(有資料的)
  const validHoldings = holdings.filter(
    (h) => histMap[h.symbol] && histMap[h.symbol].length >= 2
  );
  if (validHoldings.length === 0) {
    dlog(`[組合] ❌ 無任何有效持倉資料`);
    return null;
  }

  // 找所有持倉的共同交易日(取交集)
  let commonDates = null;
  for (const h of validHoldings) {
    const dates = new Set(histMap[h.symbol].map((p) => p.date));
    if (commonDates === null) commonDates = dates;
    else commonDates = new Set([...commonDates].filter((d) => dates.has(d)));
  }
  const sortedDates = [...commonDates].sort();
  if (sortedDates.length < 2) {
    dlog(`[組合] ❌ 共同交易日少於 2 天`);
    return null;
  }

  // 建立每檔股票的 dateMap (date → close) 加速查找
  const dateMaps = {};
  for (const h of validHoldings) {
    const dm = {};
    for (const p of histMap[h.symbol]) dm[p.date] = p.close;
    dateMaps[h.symbol] = dm;
  }
  const benchMap = {};
  if (histMap[PORTFOLIO_BENCHMARK_SYMBOL]) {
    for (const p of histMap[PORTFOLIO_BENCHMARK_SYMBOL])
      benchMap[p.date] = p.close;
  }

  // 計算每日組合淨值
  const equityCurve = []; // [{date, portfolioValue, benchmarkValue}]
  const initialCost = validHoldings.reduce((s, h) => s + h.cost * h.shares, 0);

  // 取第一個共同日作為 benchmark 起始點
  const benchStartDate = sortedDates.find((d) => benchMap[d]) || sortedDates[0];
  const benchStart = benchMap[benchStartDate] || 1;

  for (const date of sortedDates) {
    let portValue = 0;
    for (const h of validHoldings) {
      const px = dateMaps[h.symbol][date];
      portValue += (px || 0) * h.shares;
    }
    const benchPx = benchMap[date] || benchStart;
    equityCurve.push({
      date,
      portfolioValue: portValue,
      portfolioReturn:
        initialCost > 0 ? ((portValue - initialCost) / initialCost) * 100 : 0,
      benchmarkReturn: ((benchPx - benchStart) / benchStart) * 100,
    });
  }

  // 個股當前狀態 (用最後一個共同交易日的價格)
  const lastDate = sortedDates[sortedDates.length - 1];
  const positions = validHoldings.map((h) => {
    const currentPrice = dateMaps[h.symbol][lastDate] || 0;
    const marketValue = currentPrice * h.shares;
    const costValue = h.cost * h.shares;
    const pnl = marketValue - costValue;
    const pnlPct = costValue > 0 ? (pnl / costValue) * 100 : 0;
    return {
      symbol: h.symbol,
      shares: h.shares,
      cost: h.cost,
      currentPrice,
      marketValue,
      costValue,
      pnl,
      pnlPct,
    };
  });

  // 計算個股權重
  const totalMV = positions.reduce((s, p) => s + p.marketValue, 0);
  for (const p of positions) {
    p.weight = totalMV > 0 ? (p.marketValue / totalMV) * 100 : 0;
  }

  // 相關性矩陣 (用日報酬率)
  const dailyReturns = {};
  for (const h of validHoldings) {
    const rets = [];
    for (let i = 1; i < sortedDates.length; i++) {
      const prev = dateMaps[h.symbol][sortedDates[i - 1]];
      const curr = dateMaps[h.symbol][sortedDates[i]];
      if (prev > 0 && curr > 0) rets.push((curr - prev) / prev);
    }
    dailyReturns[h.symbol] = rets;
  }
  const corrMatrix = [];
  for (const h1 of validHoldings) {
    const row = [];
    for (const h2 of validHoldings) {
      row.push(pearsonCorr(dailyReturns[h1.symbol], dailyReturns[h2.symbol]));
    }
    corrMatrix.push(row);
  }

  // 組合摘要
  const lastPoint = equityCurve[equityCurve.length - 1];
  const summary = {
    totalCost: initialCost,
    totalMarketValue: totalMV,
    totalPnL: totalMV - initialCost,
    totalPnLPct:
      initialCost > 0 ? ((totalMV - initialCost) / initialCost) * 100 : 0,
    periodReturn: lastPoint ? lastPoint.portfolioReturn : 0,
    benchmarkReturn: lastPoint ? lastPoint.benchmarkReturn : 0,
    alpha: lastPoint
      ? lastPoint.portfolioReturn - lastPoint.benchmarkReturn
      : 0,
    positionsCount: validHoldings.length,
    dataDays: sortedDates.length,
  };

  dlog(
    `[組合] ✅ 完成 | ${
      validHoldings.length
    }檔 | 報酬 ${summary.totalPnLPct.toFixed(2)}% | vs 0050 ${
      summary.alpha >= 0 ? "+" : ""
    }${summary.alpha.toFixed(2)}%`
  );

  return {
    equityCurve,
    positions,
    corrMatrix,
    corrSymbols: validHoldings.map((h) => h.symbol),
    summary,
  };
}

/* ─── 自選股迷你走勢:抓近 ~90 天收盤,給 sparkline 用 ─────
 * 帶 12 小時短快取(localStorage),避免重新整理時重複打 FinMind。
 * ─────────────────────────────────────────────────────────── */
const SPARK_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 小時

async function fetchSparkline(symbol) {
  const cacheKey = SK.spark(symbol);

  // 先看短快取
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const p = JSON.parse(cached);
      if (
        p &&
        Array.isArray(p.closes) &&
        p.closes.length >= 2 &&
        Date.now() - p.ts < SPARK_CACHE_TTL
      ) {
        dlog(`[Sparkline ${symbol}] ✅ 快取命中 (${p.closes.length} 點)`);
        return p.closes;
      }
    }
  } catch (e) {
    localStorage.removeItem(cacheKey);
  }

  const startDate = new Date(Date.now() - 90 * 86400000)
    .toISOString()
    .split("T")[0];
  try {
    const res = await fetch(
      viaProxy(
        finmindUrl(
          `dataset=TaiwanStockPrice&data_id=${symbol}&start_date=${startDate}`
        )
      )
    );
    const json = await res.json();
    if (json.data && json.data.length) {
      const closes = json.data
        .slice(-45)
        .map((x) => Number(x.close) || 0)
        .filter((v) => v > 0);
      dlog(`[Sparkline ${symbol}] ✅ 抓取成功 ${closes.length} 點`);
      if (closes.length >= 2) {
        try {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({ ts: Date.now(), closes })
          );
        } catch (e) {
          dlog(`[Sparkline ${symbol}] 快取寫入失敗:`, e.message);
        }
      }
      return closes;
    }
    dlog(`[Sparkline ${symbol}] data 為空`);
  } catch (e) {
    dlog(`[Sparkline ${symbol}] error:`, e.message);
  }
  return [];
}

/* ─── ⭐️⭐️⭐️ 量化評級引擎 v2.0 (機構級多因子複合模型) ⭐️⭐️⭐️ ───
 * 四大因子 (Four-Factor Composite):
 *   1. MOMENTUM (動能因子)  ─ RSI、MA 排列、近期報酬
 *   2. VALUE    (估值因子)  ─ 近季百分位、PE 評估
 *   3. QUALITY  (品質因子)  ─ Sharpe Ratio、波動率穩定度
 *   4. TREND    (趨勢因子)  ─ MA20/60 排列、長線方向
 *
 * 各因子打 0-100 分,加權平均後得到綜合分數 → 對應七級評等
 * ─────────────────────────────────────────────────────────── */
function generateAnalysis(d, fundamentals) {
  const closes = d.closes || [];
  const price = d.price;
  const ma5 = avg(closes.slice(-5));
  const ma20 = avg(closes.slice(-20));
  const ma60 = avg(closes.slice(-60)) || ma20;
  const ma120 = avg(closes.slice(-120)) || ma60;
  const rsi = parseFloat(d.rsi) || 50;

  const max90 = Math.max(...closes.slice(-90));
  const min90 = Math.min(...closes.slice(-90));
  const max250 = Math.max(...closes.slice(-250));
  const min250 = Math.min(...closes.slice(-250));

  // 趨勢判讀
  let trend = "震盪收斂 (Consolidation)";
  let isTrending = false;
  if (price > ma20 && ma5 > ma20) {
    trend = "多頭排列 (Bullish Trend)";
    isTrending = true;
  } else if (price < ma20 && ma5 < ma20) {
    trend = "空頭下行 (Bearish Trend)";
    isTrending = true;
  }

  /* ─── 因子 1: MOMENTUM 動能 (0-100) ─── */
  let momentumScore = 50;
  // RSI 區間
  if (rsi >= 50 && rsi <= 70) momentumScore += 15;
  else if (rsi > 70) momentumScore += 5; // 過熱反而減分
  else if (rsi < 30) momentumScore += 10; // 超賣反彈機會
  else if (rsi < 45) momentumScore -= 10;
  // 短期動能 (MA5 vs MA20)
  if (ma5 > ma20 * 1.02) momentumScore += 12;
  else if (ma5 > ma20) momentumScore += 6;
  else if (ma5 < ma20 * 0.98) momentumScore -= 12;
  // 30 天報酬率
  if (closes.length >= 30) {
    const ret30 =
      ((price - closes[closes.length - 30]) / closes[closes.length - 30]) * 100;
    if (ret30 > 10) momentumScore += 10;
    else if (ret30 > 3) momentumScore += 5;
    else if (ret30 < -10) momentumScore -= 15;
    else if (ret30 < -3) momentumScore -= 5;
  }
  momentumScore = Math.max(0, Math.min(100, momentumScore));

  /* ─── 因子 2: VALUE 估值 (0-100) ─── */
  const percentile90 = ((price - min90) / (max90 - min90)) * 100;
  const percentile250 = ((price - min250) / (max250 - min250)) * 100;
  let valueScore = 100 - percentile90 * 0.6 - percentile250 * 0.4; // 越低位越高分
  // PE 額外加減分
  const per = parseFloat(fundamentals.per);
  if (!isNaN(per) && per > 0) {
    if (per < 12) valueScore += 8;
    else if (per < 18) valueScore += 3;
    else if (per > 35) valueScore -= 8;
    else if (per > 25) valueScore -= 3;
  }
  valueScore = Math.max(0, Math.min(100, valueScore));

  /* ─── 因子 3: QUALITY 品質 (0-100) ─── */
  const sharpe = sharpeRatio(closes, 60);
  const vol = annualizedVol(closes, 60);
  const dd = maxDrawdown(closes, 250);
  let qualityScore = 50;
  // Sharpe 評分
  if (sharpe > 2) qualityScore += 25;
  else if (sharpe > 1) qualityScore += 15;
  else if (sharpe > 0.5) qualityScore += 8;
  else if (sharpe < -0.5) qualityScore -= 15;
  else if (sharpe < 0) qualityScore -= 8;
  // 波動率評分 (越穩定越好)
  if (vol < 15) qualityScore += 15;
  else if (vol < 25) qualityScore += 8;
  else if (vol > 50) qualityScore -= 15;
  else if (vol > 35) qualityScore -= 5;
  // 最大回撤
  if (dd > -10) qualityScore += 10;
  else if (dd < -40) qualityScore -= 12;
  qualityScore = Math.max(0, Math.min(100, qualityScore));

  /* ─── 因子 4: TREND 趨勢 (0-100) ─── */
  let trendScore = 50;
  // MA 排列 (黃金/死亡交叉)
  if (price > ma20 && ma20 > ma60 && ma60 > ma120) trendScore += 25; // 完美多頭
  else if (price > ma60 && ma20 > ma60) trendScore += 15;
  else if (price > ma60) trendScore += 8;
  else if (price < ma20 && ma20 < ma60 && ma60 < ma120) trendScore -= 25;
  else if (price < ma60 && ma20 < ma60) trendScore -= 15;
  else if (price < ma60) trendScore -= 8;
  // 距離 MA60 偏離度
  const devFromMA60 = ((price - ma60) / ma60) * 100;
  if (Math.abs(devFromMA60) < 3 && trendScore > 50) trendScore += 5; // 健康回踩
  if (devFromMA60 > 15) trendScore -= 8; // 過度上漲乖離
  trendScore = Math.max(0, Math.min(100, trendScore));

  /* ─── 綜合分數 (加權平均) ─── */
  const compositeScore =
    momentumScore * 0.25 +
    valueScore * 0.25 +
    qualityScore * 0.25 +
    trendScore * 0.25;

  /* ─── 七級評等 (依綜合分數) ─── */
  let rating, ratingClass, ratingShort, ratingScore, ratingStars;
  if (compositeScore >= 80) {
    rating = "積極加碼";
    ratingShort = "STRONG BUY";
    ratingClass = "strong-buy";
    ratingScore = 6;
    ratingStars = 5;
  } else if (compositeScore >= 68) {
    rating = "買進";
    ratingShort = "BUY";
    ratingClass = "buy";
    ratingScore = 5;
    ratingStars = 4.5;
  } else if (compositeScore >= 58) {
    rating = "優於大盤";
    ratingShort = "OUTPERFORM";
    ratingClass = "outperform";
    ratingScore = 4;
    ratingStars = 4;
  } else if (compositeScore >= 45) {
    rating = "中立";
    ratingShort = "HOLD";
    ratingClass = "neutral";
    ratingScore = 3;
    ratingStars = 3;
  } else if (compositeScore >= 35) {
    rating = "劣於大盤";
    ratingShort = "UNDERPERFORM";
    ratingClass = "underperform";
    ratingScore = 2;
    ratingStars = 2;
  } else if (compositeScore >= 22) {
    rating = "減碼";
    ratingShort = "REDUCE";
    ratingClass = "reduce";
    ratingScore = 1;
    ratingStars = 1.5;
  } else {
    rating = "賣出";
    ratingShort = "SELL";
    ratingClass = "sell";
    ratingScore = 0;
    ratingStars = 1;
  }

  /* ─── 信心度 (基於各因子一致性) ─── */
  const scores = [momentumScore, valueScore, qualityScore, trendScore];
  const scoreStdev = stdev(scores);
  let confidence;
  if (scoreStdev < 10) confidence = "高度共識";
  else if (scoreStdev < 20) confidence = "中度共識";
  else confidence = "因子分歧";

  /* ─── 建議部位 (Half-Kelly + 評分調整) ─── */
  let expectedUpside = max90 - price;
  if (expectedUpside <= 0) expectedUpside = price * 0.15;
  let expectedDownside = price - min90;
  if (expectedDownside <= 0) expectedDownside = price * 0.1;
  const b = expectedUpside / expectedDownside;
  const p = compositeScore / 100;
  const q = 1 - p;
  let fullKelly = (b * p - q) / b;
  let halfKellyPct = fullKelly > 0 ? fullKelly * 0.5 * 100 : 0;
  let recommendedPosition = Math.max(0, Math.min(halfKellyPct, 20));

  /* ─── 分析文字 ─── */
  const technical = `【流動性與結構】標的現處「${trend}」型態。短線動能線 (MA5) 報 ${fmt(
    ma5
  )},核心成本線 (MA20) 報 ${fmt(ma20)},長期均線 (MA60) 報 ${fmt(ma60)}。
【動能與乖離】RSI(14) 讀值 ${rsi}。${
    isTrending
      ? "趨勢動能延續中,需監控均值回歸風險。"
      : "區間震盪,等待方向性突破。"
  }`;

  const valuation = `【相對估值】近季 PR${Math.round(
    percentile90
  )} / 近年 PR${Math.round(percentile250)} 位階。
【量化診斷】${
    percentile90 > 80
      ? "估值偏貴,追高風險顯著,勝率不佳。"
      : percentile90 < 20
      ? "深度折價,具備不對稱潛在報酬比。"
      : "中軸地帶,符合市場共識。"
  }`;

  const strategy = `【風險報酬比】R/R = ${fmt(b, 2)} (預期上行 ${fmt(
    expectedUpside
  )} / 最大回撤 ${fmt(expectedDownside)})
【夏普比率】${fmt(sharpe, 2)} | 【年化波動率】${fmt(
    vol,
    1
  )}% | 【歷史最大回撤】${fmt(dd, 1)}%
【動態部位】建議曝險 ${fmt(
    recommendedPosition,
    1
  )}% (Half-Kelly 模型 + 多因子調整)`;

  return {
    technical,
    valuation,
    strategy,
    rating,
    ratingClass,
    ratingShort,
    ratingScore,
    ratingStars,
    compositeScore,
    confidence,
    factors: {
      momentum: momentumScore,
      value: valueScore,
      quality: qualityScore,
      trend: trendScore,
    },
    quantMetrics: {
      sharpe,
      vol,
      dd,
      percentile90,
      percentile250,
      ret30:
        closes.length >= 30
          ? ((price - closes[closes.length - 30]) /
              closes[closes.length - 30]) *
            100
          : 0,
      riskRewardRatio: b,
      expectedUpside,
      expectedDownside,
      recommendedPosition,
      ma5,
      ma20,
      ma60,
      ma120,
    },
    ma5,
    ma20,
    rsi,
  };
}

/* ─── ⭐️⭐️⭐️ 歷史回測引擎 ⭐️⭐️⭐️ ───
 * 把四因子評級套到歷史上的每一天,模擬「依評級動態調整部位」的績效。
 * 對照組:同一檔股票「買進持有 (Buy & Hold)」—— 不需額外 API,完美對齊日期。
 *
 * 評級 → 目標部位對照(七級):
 *   STRONG BUY 100% / BUY 80% / OUTPERFORM 60%
 *   HOLD 維持前一日 / UNDERPERFORM 30% / REDUCE 10% / SELL 0%
 *
 * 無前視偏誤:第 i 天的部位只用「第 i 天(含)以前」的資料決定,
 * 套用在「第 i → i+1 天」的報酬上。
 * ─────────────────────────────────────────────────────────── */
const RATING_POSITION = {
  6: 1.0, // STRONG BUY → 滿倉
  5: 0.8, // BUY
  4: 0.6, // OUTPERFORM
  3: null, // HOLD → 維持前一日部位
  2: 0.3, // UNDERPERFORM
  1: 0.1, // REDUCE
  0: 0.0, // SELL → 空手
};

function maxDrawdownOfCurve(curve) {
  if (!curve || curve.length === 0) return 0;
  let peak = curve[0];
  let mdd = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd * 100;
}

function runBacktest(fullData, perValue, lookbackDays) {
  const WARMUP = 120; // 暖身期:需要 MA120 才有完整趨勢因子
  if (!fullData || fullData.length < WARMUP + 40) return null;

  let series = fullData;
  if (lookbackDays && fullData.length > lookbackDays + WARMUP) {
    series = fullData.slice(-(lookbackDays + WARMUP));
  }
  const closes = series.map((d) => d.close);
  const n = series.length;
  if (n < WARMUP + 20) return null;

  let stratEquity = 1;
  let bhEquity = 1;
  let position = 0; // 已決定、要套用到「下一日」的部位

  const stratCurve = [];
  const bhCurve = [];
  const posCurve = [];
  const dates = [];

  const trades = []; // 每段「持倉期間」的報酬率
  let openTrade = null;
  let daysInMarket = 0;

  for (let i = WARMUP; i < n; i++) {
    // 先用「昨日決定的部位」結算今日報酬(無前視)
    if (i > WARMUP) {
      const dayRet = (closes[i] - closes[i - 1]) / closes[i - 1];
      stratEquity *= 1 + position * dayRet;
      bhEquity *= 1 + dayRet;
      if (position > 0.0001) daysInMarket++;
    }

    // 用第 i 天(含)以前的資料算評級
    const histCloses = closes.slice(0, i + 1);
    const rsi = calculateRSI(histCloses, 14);
    const d = {
      closes: histCloses,
      price: histCloses[histCloses.length - 1],
      rsi,
    };
    const res = generateAnalysis(d, { per: perValue });
    let target = RATING_POSITION[res.ratingScore];
    if (target == null) target = position; // HOLD → 維持

    // 交易區段:position>0 的連續期間視為一筆交易
    if (position <= 0.0001 && target > 0.0001) {
      openTrade = { entryEquity: stratEquity };
    } else if (position > 0.0001 && target <= 0.0001 && openTrade) {
      trades.push(stratEquity / openTrade.entryEquity - 1);
      openTrade = null;
    }

    position = target;
    stratCurve.push(stratEquity);
    bhCurve.push(bhEquity);
    posCurve.push(position);
    dates.push(series[i].date);
  }
  // 收尾:期末仍未平倉的交易,以最終市值結算
  if (openTrade) {
    trades.push(stratEquity / openTrade.entryEquity - 1);
  }

  const tradingDays = stratCurve.length;
  const years = tradingDays / 252;
  const stratRet = (stratEquity - 1) * 100;
  const bhRet = (bhEquity - 1) * 100;
  const wins = trades.filter((t) => t > 0).length;

  return {
    dates,
    stratCurve,
    bhCurve,
    posCurve,
    stratRet,
    bhRet,
    excessReturn: stratRet - bhRet,
    stratCAGR: years > 0 ? (Math.pow(stratEquity, 1 / years) - 1) * 100 : 0,
    bhCAGR: years > 0 ? (Math.pow(bhEquity, 1 / years) - 1) * 100 : 0,
    stratMDD: maxDrawdownOfCurve(stratCurve),
    bhMDD: maxDrawdownOfCurve(bhCurve),
    winRate: trades.length ? (wins / trades.length) * 100 : 0,
    tradeCount: trades.length,
    timeInMarket: tradingDays ? (daysInMarket / tradingDays) * 100 : 0,
    tradingDays,
  };
}

/* ─── 回測權益曲線圖 (SVG) ─────────────────────────────────── */
function EquityChart({ result }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const wrapRef = useRef(null);

  const { stratCurve, bhCurve, dates } = result;
  const W = 600;
  const H = 230;
  const padL = 6;
  const padR = 6;
  const padT = 14;
  const padB = 24;
  const n = stratCurve.length;

  const all = [...stratCurve, ...bhCurve, 1];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min || 1;

  const xOf = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const yOf = (v) => padT + (1 - (v - min) / range) * (H - padT - padB);

  const toPath = (curve) =>
    curve
      .map(
        (v, i) =>
          `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`
      )
      .join(" ");

  const stratPath = toPath(stratCurve);
  const bhPath = toPath(bhCurve);
  const stratArea = `${stratPath} L${xOf(n - 1).toFixed(1)},${(
    H - padB
  ).toFixed(1)} L${xOf(0).toFixed(1)},${(H - padB).toFixed(1)} Z`;
  const baselineY = yOf(1);

  function handleMove(e) {
    const rect = wrapRef.current.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    let idx = Math.round(((relX - padL) / (W - padL - padR)) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    setHoverIdx(idx);
  }

  const hov = hoverIdx != null ? hoverIdx : null;

  return (
    <div className="equity-chart-wrap">
      <div className="equity-legend">
        <span className="eq-leg eq-leg-strat">
          <span className="eq-swatch" /> 評級策略
        </span>
        <span className="eq-leg eq-leg-bh">
          <span className="eq-swatch" /> 買進持有
        </span>
        <span className="eq-leg eq-leg-base">
          <span className="eq-swatch" /> 損益兩平
        </span>
      </div>
      <div
        className="equity-svg-box"
        ref={wrapRef}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="equity-svg"
        >
          <defs>
            <linearGradient id="eq-strat-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* 損益兩平基準線 */}
          <line
            x1={padL}
            y1={baselineY}
            x2={W - padR}
            y2={baselineY}
            stroke="var(--border-strong)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />

          <path d={stratArea} fill="url(#eq-strat-fill)" />
          {/* 買進持有 */}
          <path
            d={bhPath}
            fill="none"
            stroke="var(--text-faint)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* 評級策略 */}
          <path
            d={stratPath}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {hov != null && (
            <line
              x1={xOf(hov)}
              y1={padT}
              x2={xOf(hov)}
              y2={H - padB}
              stroke="var(--accent-hover)"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
          )}
          {hov != null && (
            <>
              <circle
                cx={xOf(hov)}
                cy={yOf(stratCurve[hov])}
                r="3"
                fill="var(--accent)"
              />
              <circle
                cx={xOf(hov)}
                cy={yOf(bhCurve[hov])}
                r="3"
                fill="var(--text-muted)"
              />
            </>
          )}
        </svg>

        {hov != null && (
          <div
            className="equity-tooltip"
            style={{
              left: `${(xOf(hov) / W) * 100}%`,
            }}
          >
            <div className="eq-tt-date">{dates[hov]}</div>
            <div className="eq-tt-row strat">
              <span>策略</span>
              <strong>
                {stratCurve[hov] >= 1 ? "+" : ""}
                {fmt((stratCurve[hov] - 1) * 100, 1)}%
              </strong>
            </div>
            <div className="eq-tt-row bh">
              <span>持有</span>
              <strong>
                {bhCurve[hov] >= 1 ? "+" : ""}
                {fmt((bhCurve[hov] - 1) * 100, 1)}%
              </strong>
            </div>
          </div>
        )}
      </div>
      <div className="equity-xaxis">
        <span>{dates[0]}</span>
        <span>{dates[Math.floor(n / 2)]}</span>
        <span>{dates[n - 1]}</span>
      </div>
    </div>
  );
}

/* ─── ⭐️⭐️⭐️ 法人籌碼面板 ⭐️⭐️⭐️ ──────────────────────────────
 * 外資(藍) / 投信(金) / 自營(紫) 三色柱狀圖,近 30 日買賣超
 * hover 顯示單日三法人明細、30 日累積統計橫列
 * ─────────────────────────────────────────────────────────── */
function InstitutionalPanel({ symbol, forceExpand = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);

  useEffect(() => {
    if (!symbol) return;
    setRows([]);
    setError("");
    setLoading(true);
    fetchInstitutional(symbol).then((r) => {
      setRows(r.slice(-30));
      setLoading(false);
      if (!r.length)
        setError("無法取得籌碼資料（FinMind 可能尚未更新或額度不足）");
    });
  }, [symbol]);

  // 30 日累積
  const sumForeign = rows.reduce((s, r) => s + r.foreign, 0);
  const sumTrust = rows.reduce((s, r) => s + r.trust, 0);
  const sumDealer = rows.reduce((s, r) => s + r.dealer, 0);
  const sumTotal = sumForeign + sumTrust + sumDealer;

  // SVG 幾何
  const W = 400,
    H = 130;
  const padL = 4,
    padR = 4,
    padT = 14,
    padB = 24;
  const graphW = W - padL - padR;
  const graphH = H - padT - padB;
  const n = rows.length;

  // 每柱組寬度
  const groupW = n > 0 ? graphW / n : 1;
  const barW = Math.max(groupW * 0.22, 1.2);
  const offsets = [-barW - 0.5, 0, barW + 0.5]; // foreign / trust / dealer 橫移

  // Y 軸:找所有日最大絕對值(三柱各自)
  let allVals = rows.flatMap((r) => [r.foreign, r.trust, r.dealer]);
  const absMax = Math.max(...allVals.map(Math.abs), 1);
  const yScale = graphH / 2 / absMax;
  const zeroY = padT + graphH / 2; // 零軸 Y 座標
  const xMid = (i) => padL + (i + 0.5) * groupW;
  const yBar = (v) => {
    const h = Math.abs(v) * yScale;
    return { top: v >= 0 ? zeroY - h : zeroY, height: Math.max(h, 0.5) };
  };

  const colors = ["var(--accent)", "var(--ma5)", "rgba(167,139,250,0.9)"];
  const legends = [
    { label: "外資", color: "var(--accent)" },
    { label: "投信", color: "var(--ma5)" },
    { label: "自營", color: "rgba(167,139,250,0.9)" },
  ];

  function handleSvgMove(e) {
    if (!svgRef.current || n === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const rx = cx - rect.left;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((rx / rect.width) * n)));
    setHoverIdx(idx);
  }

  const hov = hoverIdx != null && rows[hoverIdx] ? rows[hoverIdx] : null;

  return (
    <div className="inst-panel">
      <div className="inst-header">
        <div className="inst-title-group">
          <span className="inst-eyebrow">INSTITUTIONAL FLOW</span>
          <h3 className="inst-title">法人籌碼動向</h3>
        </div>
        <button
          className="panel-collapse-btn"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed && !forceExpand ? "展開" : "收合"}
        >
          <span
            className={`panel-chevron ${
              collapsed && !forceExpand ? "" : "open"
            }`}
          >
            ›
          </span>
        </button>
      </div>

      <div className={`panel-body ${collapsed && !forceExpand ? "" : "open"}`}>
        <div className="panel-body-inner">
          {/* 30 日累積統計列 */}
          <div className="inst-summary">
            {[
              { label: "外資累積", val: sumForeign, color: "var(--accent)" },
              { label: "投信累積", val: sumTrust, color: "var(--ma5)" },
              {
                label: "自營累積",
                val: sumDealer,
                color: "rgba(167,139,250,0.9)",
              },
              {
                label: "三大法人合計",
                val: sumTotal,
                color: "var(--text-strong)",
                highlight: true,
              },
            ].map((s) => (
              <div
                key={s.label}
                className={`inst-sum-cell ${s.highlight ? "highlight" : ""}`}
              >
                <span className="inst-sum-label">{s.label}</span>
                <span
                  className="inst-sum-val"
                  style={{ color: s.val >= 0 ? "var(--up)" : "var(--down)" }}
                >
                  {s.val >= 0 ? "+" : ""}
                  {Math.round(s.val).toLocaleString()} 張
                </span>
              </div>
            ))}
          </div>

          {/* 圖例列 */}
          <div className="inst-legend">
            {legends.map((l) => (
              <span key={l.label} className="inst-leg-item">
                <span
                  className="inst-leg-dot"
                  style={{ background: l.color }}
                ></span>
                {l.label}
              </span>
            ))}
            <span className="inst-leg-note">近 {n} 日 · 單位:千張</span>
          </div>

          {loading && (
            <div className="inst-loading">
              <span className="dot">●</span>
              <span className="dot">●</span>
              <span className="dot">●</span>
              抓取法人籌碼資料中…
            </div>
          )}
          {error && !loading && <div className="inst-error">{error}</div>}

          {!loading && rows.length > 0 && (
            <div
              className="inst-chart-wrap"
              onMouseMove={handleSvgMove}
              onMouseLeave={() => setHoverIdx(null)}
              onTouchMove={handleSvgMove}
              onTouchEnd={() => setHoverIdx(null)}
            >
              <svg
                ref={svgRef}
                width="100%"
                height="100%"
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                className="inst-svg"
              >
                {/* 零軸 */}
                <line
                  x1={padL}
                  y1={zeroY}
                  x2={W - padR}
                  y2={zeroY}
                  stroke="var(--border-strong)"
                  strokeWidth="0.8"
                />

                {/* 柱狀體 */}
                {rows.map((r, i) => {
                  const vals = [r.foreign, r.trust, r.dealer];
                  return vals.map((v, ci) => {
                    const { top, height } = yBar(v);
                    const x = xMid(i) + offsets[ci] - barW / 2;
                    const isHov = hoverIdx === i;
                    return (
                      <rect
                        key={`${i}-${ci}`}
                        x={x}
                        y={top}
                        width={barW}
                        height={height}
                        fill={colors[ci]}
                        opacity={isHov ? 0.95 : hoverIdx == null ? 0.72 : 0.28}
                        rx="0.5"
                      />
                    );
                  });
                })}

                {/* hover 垂直線 */}
                {hoverIdx !== null && (
                  <line
                    x1={xMid(hoverIdx)}
                    y1={padT}
                    x2={xMid(hoverIdx)}
                    y2={H - padB}
                    stroke="var(--accent)"
                    strokeWidth="0.7"
                    strokeDasharray="2 2"
                    opacity="0.5"
                  />
                )}

                {/* X 軸日期(只顯示頭/中/尾) */}
                {[0, Math.floor(n / 2), n - 1].map(
                  (i) =>
                    rows[i] && (
                      <text
                        key={i}
                        x={xMid(i)}
                        y={H - padB + 12}
                        textAnchor="middle"
                        fontSize="7.5"
                        fill="var(--text-faint)"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {rows[i].date.slice(5)}
                      </text>
                    )
                )}

                {/* Y 軸輔助線 (±absMax/2) */}
                {[absMax * 0.5, -absMax * 0.5].map((v, i) => {
                  const y = zeroY - v * yScale;
                  return (
                    <line
                      key={i}
                      x1={padL}
                      y1={y}
                      x2={W - padR}
                      y2={y}
                      stroke="var(--border)"
                      strokeWidth="0.4"
                      strokeDasharray="2 3"
                    />
                  );
                })}
              </svg>

              {/* Hover tooltip */}
              {hov && (
                <div
                  className="inst-tooltip"
                  style={{ left: `${((hoverIdx + 0.5) / n) * 100}%` }}
                >
                  <div className="inst-tt-date">{hov.date}</div>
                  {[
                    { label: "外資", val: hov.foreign, color: "var(--accent)" },
                    { label: "投信", val: hov.trust, color: "var(--ma5)" },
                    {
                      label: "自營",
                      val: hov.dealer,
                      color: "rgba(167,139,250,0.9)",
                    },
                  ].map((x) => (
                    <div key={x.label} className="inst-tt-row">
                      <span
                        className="inst-tt-label"
                        style={{ color: x.color }}
                      >
                        {x.label}
                      </span>
                      <span
                        className={`inst-tt-val ${x.val >= 0 ? "up" : "down"}`}
                      >
                        {x.val >= 0 ? "+" : ""}
                        {Math.round(x.val).toLocaleString()}
                      </span>
                    </div>
                  ))}
                  <div className="inst-tt-total">
                    合計{" "}
                    <strong
                      className={
                        hov.foreign + hov.trust + hov.dealer >= 0
                          ? "up"
                          : "down"
                      }
                    >
                      {hov.foreign + hov.trust + hov.dealer >= 0 ? "+" : ""}
                      {Math.round(
                        hov.foreign + hov.trust + hov.dealer
                      ).toLocaleString()}
                    </strong>{" "}
                    張
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── ⭐️⭐️⭐️ 量化分析報告 — 多分頁版本 ⭐️⭐️⭐️ ──────────────
 * 四個分頁:技術面 / 估值面 / 籌碼面 / 風控面
 * 每個分頁整合對應的指標 + 自動解讀文字
 * 籌碼分頁會自己抓 fetchInstitutional (短快取會直接命中,不浪費 API)
 * ─────────────────────────────────────────────────────────── */
function AnalysisTabs({
  metrics,
  fullData,
  fundamentals,
  symbol,
  forceShowAll = false,
}) {
  const [activeTab, setActiveTab] = useState("tech");
  const [instRows, setInstRows] = useState([]);

  // 籌碼資料(沿用同一支 API,有短快取)
  useEffect(() => {
    // forceShowAll 時也要載入籌碼資料(因為要顯示籌碼面 tab)
    if (!symbol) return;
    if (!forceShowAll && activeTab !== "chip") return;
    fetchInstitutional(symbol).then((r) => setInstRows(r.slice(-10)));
  }, [activeTab, symbol, forceShowAll]);

  if (!metrics || !fullData || fullData.length === 0) return null;

  // ─── 預先計算各分頁需要的指標 ───
  const closes = fullData.map((d) => d.close);
  const lastIdx = fullData.length - 1;
  const price = closes[lastIdx];
  const {
    ma5,
    ma20,
    ma60,
    ma120,
    sharpe,
    vol,
    dd,
    ret30,
    percentile90,
    percentile250,
    riskRewardRatio,
    recommendedPosition,
    expectedUpside,
    expectedDownside,
  } = metrics.quantMetrics;
  const rsi = parseFloat(metrics.rsi) || 50;

  // KD 末值(用 fullData 算)
  const kdAll = calcKD(fullData);
  const kdK = kdAll.k[lastIdx];
  const kdD = kdAll.d[lastIdx];

  // 布林通道末值
  const bbAll = calcBollinger(fullData, 20, 2);
  const bbU = bbAll.upper[lastIdx];
  const bbM = bbAll.mid[lastIdx];
  const bbL = bbAll.lower[lastIdx];
  // %B 與帶寬
  const pctB =
    bbU != null && bbL != null && bbU !== bbL
      ? ((price - bbL) / (bbU - bbL)) * 100
      : 50;
  const bbWidth =
    bbU != null && bbL != null && bbM ? ((bbU - bbL) / bbM) * 100 : 0;

  // MACD 末值
  const macdAll = calcMACD(closes);
  const dif = macdAll.dif[lastIdx];
  const dea = macdAll.dea[lastIdx];
  const hist = macdAll.hist[lastIdx];

  // ─── 解讀文字產生器 ───
  const techDiag = (() => {
    const arr = [];
    // MA 排列
    if (price > ma20 && ma20 > ma60 && ma60 > ma120)
      arr.push({ type: "good", text: "MA 多頭排列完整,長短均線同步向上" });
    else if (price < ma20 && ma20 < ma60 && ma60 < ma120)
      arr.push({ type: "bad", text: "MA 空頭排列,均線壓力沉重" });
    else if (price > ma20 && ma20 > ma60)
      arr.push({ type: "good", text: "短中期 MA 多頭排列" });
    else if (price < ma20 && ma20 < ma60)
      arr.push({ type: "bad", text: "短中期 MA 空頭排列" });
    else arr.push({ type: "neutral", text: "MA 糾結,方向尚未明朗" });

    // RSI
    if (rsi >= 70)
      arr.push({
        type: "bad",
        text: `RSI ${fmt(rsi, 1)} 進入超買區,留意短線回檔`,
      });
    else if (rsi <= 30)
      arr.push({
        type: "good",
        text: `RSI ${fmt(rsi, 1)} 進入超賣區,具反彈機會`,
      });
    else if (rsi >= 50)
      arr.push({ type: "good", text: `RSI ${fmt(rsi, 1)} 多方掌控` });
    else arr.push({ type: "neutral", text: `RSI ${fmt(rsi, 1)} 動能偏弱` });

    // KD
    if (kdK != null && kdD != null) {
      if (kdK >= 80 && kdD >= 80)
        arr.push({
          type: "bad",
          text: `KD 雙線超買 (K=${fmt(kdK, 0)}, D=${fmt(kdD, 0)})`,
        });
      else if (kdK <= 20 && kdD <= 20)
        arr.push({
          type: "good",
          text: `KD 雙線超賣 (K=${fmt(kdK, 0)}, D=${fmt(kdD, 0)})`,
        });
      else if (kdK > kdD)
        arr.push({
          type: "good",
          text: `KD 黃金交叉持續 (K=${fmt(kdK, 0)} > D=${fmt(kdD, 0)})`,
        });
      else
        arr.push({
          type: "bad",
          text: `KD 死亡交叉持續 (K=${fmt(kdK, 0)} < D=${fmt(kdD, 0)})`,
        });
    }

    // MACD
    if (dif != null && dea != null) {
      if (dif > dea && dif > 0)
        arr.push({
          type: "good",
          text: `MACD 多頭區黃金交叉,DIF=${fmt(dif, 2)}`,
        });
      else if (dif < dea && dif < 0)
        arr.push({
          type: "bad",
          text: `MACD 空頭區死亡交叉,DIF=${fmt(dif, 2)}`,
        });
      else if (dif > dea)
        arr.push({ type: "neutral", text: `MACD 弱勢反彈,DIF=${fmt(dif, 2)}` });
      else
        arr.push({ type: "neutral", text: `MACD 弱勢回檔,DIF=${fmt(dif, 2)}` });
    }
    return arr;
  })();

  const valDiag = (() => {
    const arr = [];
    if (percentile90 >= 80)
      arr.push({
        type: "bad",
        text: `近季價格位階 PR${Math.round(
          percentile90
        )},逼近高點,追高勝率不佳`,
      });
    else if (percentile90 <= 20)
      arr.push({
        type: "good",
        text: `近季價格位階 PR${Math.round(
          percentile90
        )},接近低點,具不對稱報酬潛力`,
      });
    else
      arr.push({
        type: "neutral",
        text: `近季價格位階 PR${Math.round(percentile90)},位於中軸`,
      });

    if (percentile250 >= 80)
      arr.push({
        type: "bad",
        text: `年度位階 PR${Math.round(percentile250)},長期估值偏高`,
      });
    else if (percentile250 <= 20)
      arr.push({
        type: "good",
        text: `年度位階 PR${Math.round(percentile250)},長期估值偏低`,
      });
    else
      arr.push({
        type: "neutral",
        text: `年度位階 PR${Math.round(percentile250)}`,
      });

    // PE
    if (fundamentals && fundamentals.per && fundamentals.per > 0) {
      const per = fundamentals.per;
      if (per > 30)
        arr.push({
          type: "bad",
          text: `本益比 ${fmt(per, 1)} 倍偏高,需高速成長支撐`,
        });
      else if (per < 12)
        arr.push({ type: "good", text: `本益比 ${fmt(per, 1)} 倍偏低,折價區` });
      else
        arr.push({
          type: "neutral",
          text: `本益比 ${fmt(per, 1)} 倍,符合市場區間`,
        });
    }

    // 布林帶 %B
    if (pctB > 100)
      arr.push({
        type: "bad",
        text: `價格突破布林上軌 (%B=${fmt(pctB, 0)}),極短線過熱`,
      });
    else if (pctB < 0)
      arr.push({
        type: "good",
        text: `價格跌破布林下軌 (%B=${fmt(pctB, 0)}),極短線超賣`,
      });
    else if (pctB > 80)
      arr.push({ type: "neutral", text: `%B=${fmt(pctB, 0)},逼近布林上軌` });
    else if (pctB < 20)
      arr.push({ type: "neutral", text: `%B=${fmt(pctB, 0)},逼近布林下軌` });

    if (bbWidth < 10)
      arr.push({
        type: "neutral",
        text: `布林帶寬 ${fmt(bbWidth, 1)}%,波動收斂,留意方向突破`,
      });
    return arr;
  })();

  const chipDiag = (() => {
    const arr = [];
    if (instRows.length === 0) return arr;
    const sumF = instRows.reduce((s, r) => s + r.foreign, 0);
    const sumT = instRows.reduce((s, r) => s + r.trust, 0);
    const sumD = instRows.reduce((s, r) => s + r.dealer, 0);
    const last5 = instRows.slice(-5);
    const f5 = last5.reduce((s, r) => s + r.foreign, 0);
    const t5 = last5.reduce((s, r) => s + r.trust, 0);

    if (sumF > 0 && sumT > 0)
      arr.push({
        type: "good",
        text: `近 10 日外資+投信同步買超,主力認同 (外資 +${Math.round(
          sumF
        ).toLocaleString()} / 投信 +${Math.round(sumT).toLocaleString()} 張)`,
      });
    else if (sumF < 0 && sumT < 0)
      arr.push({
        type: "bad",
        text: `近 10 日外資+投信同步賣超,主力出貨 (外資 ${Math.round(
          sumF
        ).toLocaleString()} / 投信 ${Math.round(sumT).toLocaleString()} 張)`,
      });
    else if (sumF > 0)
      arr.push({
        type: "good",
        text: `外資近 10 日買超 +${Math.round(
          sumF
        ).toLocaleString()} 張,但投信動向分歧`,
      });
    else if (sumT > 0)
      arr.push({
        type: "neutral",
        text: `投信近 10 日買超 +${Math.round(sumT).toLocaleString()} 張`,
      });
    else
      arr.push({
        type: "neutral",
        text: "三大法人籌碼面分歧,缺乏明確主導方向",
      });

    // 近 5 日 vs 近 10 日對比(動能變化)
    if (f5 > 0 && sumF > 0 && f5 / 5 > (sumF - f5) / 5) {
      arr.push({ type: "good", text: "外資買超動能近 5 日加速" });
    } else if (f5 < 0 && sumF < 0 && f5 / 5 < (sumF - f5) / 5) {
      arr.push({ type: "bad", text: "外資賣超動能近 5 日加速" });
    }

    if (sumD > 0)
      arr.push({
        type: "neutral",
        text: `自營商近 10 日買超 +${Math.round(sumD).toLocaleString()} 張`,
      });
    else if (sumD < 0)
      arr.push({
        type: "neutral",
        text: `自營商近 10 日賣超 ${Math.round(sumD).toLocaleString()} 張`,
      });

    return arr;
  })();

  const riskDiag = (() => {
    const arr = [];
    // Sharpe
    if (sharpe > 2)
      arr.push({
        type: "good",
        text: `夏普比率 ${fmt(sharpe, 2)},卓越的風險調整後報酬`,
      });
    else if (sharpe > 1)
      arr.push({
        type: "good",
        text: `夏普比率 ${fmt(sharpe, 2)},優秀的風險報酬比`,
      });
    else if (sharpe > 0.5)
      arr.push({
        type: "neutral",
        text: `夏普比率 ${fmt(sharpe, 2)},尚可接受`,
      });
    else if (sharpe > 0)
      arr.push({
        type: "neutral",
        text: `夏普比率 ${fmt(sharpe, 2)},風險溢酬偏低`,
      });
    else
      arr.push({
        type: "bad",
        text: `夏普比率 ${fmt(sharpe, 2)},風險報酬不對稱,不建議重壓`,
      });

    // 波動率
    if (vol > 40)
      arr.push({
        type: "bad",
        text: `年化波動率 ${fmt(vol, 1)}% 偏高,需小幅曝險`,
      });
    else if (vol < 18)
      arr.push({
        type: "good",
        text: `年化波動率 ${fmt(vol, 1)}%,屬低波動標的`,
      });
    else
      arr.push({
        type: "neutral",
        text: `年化波動率 ${fmt(vol, 1)}%,中等水準`,
      });

    // 回撤
    if (dd < -30)
      arr.push({
        type: "bad",
        text: `歷史最大回撤 ${fmt(dd, 1)}%,曾出現深度修正`,
      });
    else if (dd > -10)
      arr.push({
        type: "good",
        text: `歷史最大回撤僅 ${fmt(dd, 1)}%,下行控制良好`,
      });

    // R/R
    if (riskRewardRatio >= 2.5)
      arr.push({
        type: "good",
        text: `風險報酬比 ${fmt(riskRewardRatio, 2)},不對稱有利上行`,
      });
    else if (riskRewardRatio < 1)
      arr.push({
        type: "bad",
        text: `風險報酬比 ${fmt(riskRewardRatio, 2)},下行風險大於上行空間`,
      });

    return arr;
  })();

  return (
    <div className={`atabs-wrap ${forceShowAll ? "atabs-export-all" : ""}`}>
      {/* Tab 列 */}
      {!forceShowAll && (
        <div className="atabs-nav">
          {[
            { key: "tech", label: "技術面", en: "TECHNICAL" },
            { key: "value", label: "估值面", en: "VALUATION" },
            { key: "chip", label: "籌碼面", en: "CHIPS" },
            { key: "risk", label: "風控面", en: "RISK" },
          ].map((t) => (
            <button
              key={t.key}
              className={`atab ${activeTab === t.key ? "active" : ""}`}
              onClick={() => setActiveTab(t.key)}
            >
              <span className="atab-label">{t.label}</span>
              <span className="atab-en">{t.en}</span>
            </button>
          ))}
        </div>
      )}

      {/* ─── 技術面 ─── */}
      {(forceShowAll || activeTab === "tech") && (
        <div className="atab-content">
          {forceShowAll && (
            <div className="atab-export-heading">技術面 · TECHNICAL</div>
          )}
          <div className="atab-stats-grid">
            <div className="atab-stat">
              <span>RSI(14)</span>
              <strong className={rsi > 70 ? "down" : rsi < 30 ? "up" : ""}>
                {fmt(rsi, 1)}
              </strong>
            </div>
            <div className="atab-stat">
              <span>K (9)</span>
              <strong className={kdK > 80 ? "down" : kdK < 20 ? "up" : ""}>
                {kdK != null ? fmt(kdK, 1) : "—"}
              </strong>
            </div>
            <div className="atab-stat">
              <span>D (9)</span>
              <strong className={kdD > 80 ? "down" : kdD < 20 ? "up" : ""}>
                {kdD != null ? fmt(kdD, 1) : "—"}
              </strong>
            </div>
            <div className="atab-stat">
              <span>MACD</span>
              <strong className={hist >= 0 ? "up" : "down"}>
                {hist != null ? fmt(hist, 2) : "—"}
              </strong>
            </div>
            <div className="atab-stat">
              <span>MA5</span>
              <strong>{fmt(ma5)}</strong>
            </div>
            <div className="atab-stat">
              <span>MA20</span>
              <strong>{fmt(ma20)}</strong>
            </div>
            <div className="atab-stat">
              <span>MA60</span>
              <strong>{fmt(ma60)}</strong>
            </div>
            <div className="atab-stat">
              <span>MA120</span>
              <strong>{fmt(ma120)}</strong>
            </div>
          </div>
          <DiagList items={techDiag} />
        </div>
      )}

      {/* ─── 估值面 ─── */}
      {(forceShowAll || activeTab === "value") && (
        <div className="atab-content">
          {forceShowAll && (
            <div className="atab-export-heading">估值面 · VALUATION</div>
          )}
          <div className="atab-stats-grid">
            <div className="atab-stat">
              <span>近季 PR</span>
              <strong>{Math.round(percentile90)}</strong>
            </div>
            <div className="atab-stat">
              <span>近年 PR</span>
              <strong>{Math.round(percentile250)}</strong>
            </div>
            <div className="atab-stat">
              <span>本益比</span>
              <strong>
                {fundamentals && fundamentals.per > 0
                  ? fmt(fundamentals.per, 1)
                  : "—"}
              </strong>
            </div>
            <div className="atab-stat">
              <span>30 日報酬</span>
              <strong className={ret30 >= 0 ? "up" : "down"}>
                {ret30 >= 0 ? "+" : ""}
                {fmt(ret30, 1)}%
              </strong>
            </div>
            <div className="atab-stat">
              <span>%B</span>
              <strong className={pctB > 100 ? "down" : pctB < 0 ? "up" : ""}>
                {fmt(pctB, 0)}
              </strong>
            </div>
            <div className="atab-stat">
              <span>布林帶寬</span>
              <strong>{fmt(bbWidth, 1)}%</strong>
            </div>
            <div className="atab-stat">
              <span>上軌</span>
              <strong>{bbU != null ? fmt(bbU) : "—"}</strong>
            </div>
            <div className="atab-stat">
              <span>下軌</span>
              <strong>{bbL != null ? fmt(bbL) : "—"}</strong>
            </div>
          </div>
          <DiagList items={valDiag} />
        </div>
      )}

      {/* ─── 籌碼面 ─── */}
      {(forceShowAll || activeTab === "chip") && (
        <div className="atab-content">
          {forceShowAll && (
            <div className="atab-export-heading">籌碼面 · CHIPS</div>
          )}
          {instRows.length === 0 ? (
            <div className="atab-empty">籌碼資料載入中或不可用…</div>
          ) : (
            <>
              <div className="atab-stats-grid">
                {(() => {
                  const sumF = instRows.reduce((s, r) => s + r.foreign, 0);
                  const sumT = instRows.reduce((s, r) => s + r.trust, 0);
                  const sumD = instRows.reduce((s, r) => s + r.dealer, 0);
                  const total = sumF + sumT + sumD;
                  const last = instRows[instRows.length - 1];
                  return (
                    <>
                      <div className="atab-stat">
                        <span>外資 10 日</span>
                        <strong className={sumF >= 0 ? "up" : "down"}>
                          {sumF >= 0 ? "+" : ""}
                          {Math.round(sumF).toLocaleString()}
                        </strong>
                      </div>
                      <div className="atab-stat">
                        <span>投信 10 日</span>
                        <strong className={sumT >= 0 ? "up" : "down"}>
                          {sumT >= 0 ? "+" : ""}
                          {Math.round(sumT).toLocaleString()}
                        </strong>
                      </div>
                      <div className="atab-stat">
                        <span>自營 10 日</span>
                        <strong className={sumD >= 0 ? "up" : "down"}>
                          {sumD >= 0 ? "+" : ""}
                          {Math.round(sumD).toLocaleString()}
                        </strong>
                      </div>
                      <div className="atab-stat">
                        <span>合計 10 日</span>
                        <strong className={total >= 0 ? "up" : "down"}>
                          {total >= 0 ? "+" : ""}
                          {Math.round(total).toLocaleString()}
                        </strong>
                      </div>
                      <div className="atab-stat">
                        <span>最新外資</span>
                        <strong className={last.foreign >= 0 ? "up" : "down"}>
                          {last.foreign >= 0 ? "+" : ""}
                          {Math.round(last.foreign).toLocaleString()}
                        </strong>
                      </div>
                      <div className="atab-stat">
                        <span>最新投信</span>
                        <strong className={last.trust >= 0 ? "up" : "down"}>
                          {last.trust >= 0 ? "+" : ""}
                          {Math.round(last.trust).toLocaleString()}
                        </strong>
                      </div>
                    </>
                  );
                })()}
              </div>
              <DiagList items={chipDiag} />
            </>
          )}
        </div>
      )}

      {/* ─── 風控面 ─── */}
      {(forceShowAll || activeTab === "risk") && (
        <div className="atab-content">
          {forceShowAll && (
            <div className="atab-export-heading">風控面 · RISK</div>
          )}
          <div className="atab-stats-grid">
            <div className="atab-stat">
              <span>夏普比率</span>
              <strong className={sharpe > 1 ? "up" : sharpe < 0 ? "down" : ""}>
                {fmt(sharpe, 2)}
              </strong>
            </div>
            <div className="atab-stat">
              <span>年化波動率</span>
              <strong>{fmt(vol, 1)}%</strong>
            </div>
            <div className="atab-stat">
              <span>最大回撤</span>
              <strong className="down">{fmt(dd, 1)}%</strong>
            </div>
            <div className="atab-stat">
              <span>風險報酬比</span>
              <strong
                className={
                  riskRewardRatio >= 2
                    ? "up"
                    : riskRewardRatio < 1
                    ? "down"
                    : ""
                }
              >
                {fmt(riskRewardRatio, 2)}
              </strong>
            </div>
            <div className="atab-stat">
              <span>建議曝險</span>
              <strong className="gold">{fmt(recommendedPosition, 1)}%</strong>
            </div>
            <div className="atab-stat">
              <span>預期上行</span>
              <strong className="up">+{fmt(expectedUpside)}</strong>
            </div>
            <div className="atab-stat">
              <span>預期回撤</span>
              <strong className="down">−{fmt(expectedDownside)}</strong>
            </div>
            <div className="atab-stat">
              <span>因子共識</span>
              <strong>{metrics.confidence}</strong>
            </div>
          </div>
          <DiagList items={riskDiag} />
          <div className="atab-disclaimer">
            ⚠ 部位建議採 Half-Kelly 模型(凱利公式保守變體),上限
            20%。回測未計入交易成本與滑價。
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── 解讀條目列表 (good / bad / neutral) ─── */
function DiagList({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="atab-diag-list">
      {items.map((it, i) => (
        <div key={i} className={`atab-diag-row ${it.type}`}>
          <span className="atab-diag-icon">
            {it.type === "good" ? "▲" : it.type === "bad" ? "▼" : "●"}
          </span>
          <span className="atab-diag-text">{it.text}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── ⭐️ 相關新聞面板 (Google News RSS) ⭐️ ──────────────────── */
function NewsPanel({ symbol, stockName, forceExpand = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    setError("");
    setRows([]);
    setExpanded(false);
    fetchStockNews(symbol, stockName).then((r) => {
      setRows(r);
      setLoading(false);
      if (!r.length) setError("近 7 日無 Google News 相關新聞");
    });
  }, [symbol, stockName]);

  function formatRelative(item) {
    if (!item.dateMs) return item.dateStr || "";
    const diffMs = Date.now() - item.dateMs;
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH < 1) return "剛剛";
    if (diffH < 24) return `${diffH} 小時前`;
    const diffD = Math.floor(diffMs / 86400000);
    if (diffD === 1) return "昨日";
    if (diffD < 7) return `${diffD} 日前`;
    return item.dateStr || "";
  }

  // 備援:整檔股票的 Google News 搜尋頁
  const fallbackSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(
    `${stockName || ""} ${symbol}`.trim()
  )}&tbm=nws`;

  const visible = expanded || forceExpand ? rows : rows.slice(0, 6);

  return (
    <div className="news-panel">
      <div className="news-header">
        <div className="news-title-group">
          <span className="news-eyebrow">
            RELATED NEWS · Google News · 近 7 日
          </span>
          <h3 className="news-title">相關新聞</h3>
          {rows.length > 0 && <span className="news-count">{rows.length}</span>}
        </div>
        <button
          className="panel-collapse-btn"
          onClick={() => setCollapsed((c) => !c)}
        >
          <span
            className={`panel-chevron ${
              collapsed && !forceExpand ? "" : "open"
            }`}
          >
            ›
          </span>
        </button>
      </div>

      <div className={`panel-body ${collapsed && !forceExpand ? "" : "open"}`}>
        <div className="panel-body-inner">
          {loading && (
            <div className="news-loading">
              <span className="dot">●</span>
              <span className="dot">●</span>
              <span className="dot">●</span>
              新聞抓取中…
            </div>
          )}

          {!loading && error && (
            <div className="news-error">
              <div className="news-error-text">{error}</div>
              <a
                className="news-fallback-btn"
                href={fallbackSearchUrl}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                Google 搜尋 {stockName || symbol} 最新新聞 ↗
              </a>
            </div>
          )}

          {!loading && rows.length > 0 && (
            <>
              <div className="news-list">
                {visible.map((n, i) => (
                  <a
                    key={i}
                    href={n.link || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                    className="news-item"
                  >
                    <div className="news-item-meta">
                      <span className="news-date">{formatRelative(n)}</span>
                      {n.source && (
                        <span className="news-source">{n.source}</span>
                      )}
                      <span className="news-arrow">↗</span>
                    </div>
                    <div className="news-title-text">{n.title}</div>
                  </a>
                ))}
              </div>

              {rows.length > 6 && (
                <button
                  className="news-expand-btn"
                  onClick={() => setExpanded((e) => !e)}
                >
                  {expanded
                    ? `收合(只看最新 6 則)`
                    : `查看全部 ${rows.length} 則 ↓`}
                </button>
              )}

              {/* 底部備援:跳到 Google News 看更多 */}
              <a
                className="news-more-link"
                href={fallbackSearchUrl}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                在 Google News 看更多 {stockName || symbol} 報導 →
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── ⭐️⭐️⭐️ 市場熱力地圖面板 ⭐️⭐️⭐️ ─────────────────────
 * Treemap 視覺化:每個方塊一檔股票
 *   - 大小 = 成交金額 (vol × close,反映市場關注度)
 *   - 顏色 = 漲跌幅 (深綠 ↔ 淺綠 ↔ 灰 ↔ 淺紅 ↔ 深紅)
 *   - 分組 = 產業類別 (用台股代碼推導)
 * 互動:點擊跳到個股研究頁、長按加入自選
 * ─────────────────────────────────────────────────────────── */
function HeatmapPanel({ stockMap, onPickSymbol, watchlist, onToggleWatch }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [topN, setTopN] = useState(100); // 顯示前 N 檔
  const [groupByIndustry, setGroupByIndustry] = useState(true);
  const [containerSize, setContainerSize] = useState({ w: 760, h: 460 });
  const [activeStock, setActiveStock] = useState(null); // hover / 點選顯示 tooltip
  const containerRef = useRef(null);
  const loadedRef = useRef(false);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const result = await fetchMarketDailyChange();
      const allRows = (result.rows || []).map((r) => ({
        ...r,
        displayName: r.name || (stockMap && stockMap[r.symbol]) || "",
        industry: getIndustry(r.symbol),
        turnover: (r.vol || 0) * (r.close || 0), // 成交金額
      }));
      if (!allRows.length) {
        if (result.sourceError) {
          setError(
            "TWSE 資料源暫時無回應(可能在維護中或週末/假日無更新)。請幾分鐘後重試。"
          );
        } else {
          setError("無法取得全市場資料");
        }
      } else if (result.stale) {
        // 用了過期快照,顯示溫和提示但不擋畫面
        setError(`TWSE 暫時無回應,目前顯示 ${result.staleMin} 分鐘前的快照`);
      }
      setRows(allRows);
      setMeta({
        dataDate: result.dataDate,
        isToday: result.isToday,
        fetchedAt: result.fetchedAt,
        stale: result.stale,
      });
    } catch (e) {
      setError("載入失敗:" + e.message);
    }
    setLoading(false);
  }

  // 第一次展開時自動載入
  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ⭐️ 快捷鍵 H:外部派發 quant:open-heatmap → 展開 + 滾入視野
  useEffect(() => {
    function onOpenSignal() {
      setOpen(true);
      requestAnimationFrame(() => {
        const el = document.querySelector(".hm-panel");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    window.addEventListener("quant:open-heatmap", onOpenSignal);
    return () => window.removeEventListener("quant:open-heatmap", onOpenSignal);
  }, []);

  // 量測容器寬高(響應式)
  useEffect(() => {
    if (!open) return;
    function measure() {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const w = Math.max(300, Math.round(r.width + 0));
      // 高度依寬度決定:寬螢幕 460,窄螢幕用 16:10 比例
      const h = w >= 700 ? 460 : Math.round(w * 0.72);
      setContainerSize({ w, h });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, rows.length]);

  // 取 Top N (依成交金額)
  const topRows = useMemo(() => {
    return [...rows]
      .filter((r) => r.turnover > 0)
      .sort((a, b) => b.turnover - a.turnover)
      .slice(0, topN);
  }, [rows, topN]);

  // 統計:上漲 / 下跌家數
  const stats = useMemo(() => {
    if (topRows.length === 0) return null;
    let up = 0,
      down = 0,
      flat = 0;
    topRows.forEach((r) => {
      if (r.chgPct > 0) up++;
      else if (r.chgPct < 0) down++;
      else flat++;
    });
    return { up, down, flat, total: topRows.length };
  }, [topRows]);

  // Treemap layout:分組 vs 不分組
  const tiles = useMemo(() => {
    if (topRows.length === 0) return [];
    const { w, h } = containerSize;
    if (!groupByIndustry) {
      // 平鋪
      const items = topRows.map((r) => ({ ...r, value: r.turnover }));
      return layoutTreemap(items, { x: 0, y: 0, w, h });
    }
    // 按產業分組:先 layout 產業大方塊,再各自 layout 內部股票
    const byInd = {};
    topRows.forEach((r) => {
      if (!byInd[r.industry]) byInd[r.industry] = [];
      byInd[r.industry].push(r);
    });
    const groups = Object.keys(byInd).map((ind) => ({
      industry: ind,
      stocks: byInd[ind],
      value: byInd[ind].reduce((s, r) => s + r.turnover, 0),
    }));
    const groupLayout = layoutTreemap(groups, { x: 0, y: 0, w, h });
    // 每個產業內再 layout 個股
    const allTiles = [];
    groupLayout.forEach((g) => {
      if (!g.rect) return;
      const labelH = 16; // 預留產業標籤高度
      const inner = {
        x: g.rect.x,
        y: g.rect.y + labelH,
        w: g.rect.w,
        h: Math.max(0, g.rect.h - labelH),
      };
      const items = g.stocks.map((r) => ({ ...r, value: r.turnover }));
      const placed = layoutTreemap(items, inner);
      allTiles.push({
        kind: "group",
        industry: g.industry,
        rect: { x: g.rect.x, y: g.rect.y, w: g.rect.w, h: labelH },
      });
      placed.forEach((p) => {
        allTiles.push({ kind: "stock", ...p });
      });
    });
    return allTiles;
  }, [topRows, containerSize, groupByIndustry]);

  // 漲跌幅 → 色彩 (台股慣例:紅漲綠跌)
  function chgToColor(chgPct) {
    if (chgPct == null || isNaN(chgPct)) return "#2a3142";
    const clamped = Math.max(-7, Math.min(7, chgPct)); // ±7% 飽和
    const t = Math.abs(clamped) / 7; // 0 ~ 1
    if (clamped > 0) {
      // 紅色階(漲)
      const r = Math.round(120 + 140 * t);
      const g = Math.round(45 + 5 * (1 - t));
      const b = Math.round(60 + 20 * (1 - t));
      return `rgb(${r},${g},${b})`;
    } else if (clamped < 0) {
      // 綠色階(跌)
      const r = Math.round(16 + 10 * (1 - t));
      const g = Math.round(120 + 90 * t);
      const b = Math.round(95 + 30 * (1 - t));
      return `rgb(${r},${g},${b})`;
    }
    return "#3a4153"; // 平盤
  }

  return (
    <div className="hm-panel">
      <div className="hm-header">
        <div className="hm-title-group">
          <span className="hm-eyebrow">MARKET HEATMAP · 全市場熱力地圖</span>
          <div className="hm-title">
            市場熱力地圖
            {stats && (
              <span className="hm-stat-pill">
                <span className="hm-stat-up">▲ {stats.up}</span>
                <span className="hm-stat-sep">·</span>
                <span className="hm-stat-down">▼ {stats.down}</span>
              </span>
            )}
          </div>
        </div>
        <button
          className="hm-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "收合" : "展開"}
        >
          {open ? "收合 ▲" : "展開 ▼"}
        </button>
      </div>

      {open && (
        <div className="hm-body">
          <div className="hm-toolbar">
            <div className="hm-control-group">
              <span className="hm-control-label">顯示</span>
              {[50, 100, 200].map((n) => (
                <button
                  key={n}
                  className={`hm-chip ${topN === n ? "active" : ""}`}
                  onClick={() => setTopN(n)}
                >
                  Top {n}
                </button>
              ))}
            </div>
            <div className="hm-control-group">
              <button
                className={`hm-chip ${groupByIndustry ? "active" : ""}`}
                onClick={() => setGroupByIndustry((v) => !v)}
              >
                {groupByIndustry ? "✓ 依產業分組" : "依產業分組"}
              </button>
              <button
                className="hm-chip hm-chip-refresh"
                onClick={loadData}
                disabled={loading}
              >
                {loading ? "載入中…" : "↻ 重新整理"}
              </button>
            </div>
          </div>

          {meta && (
            <div className="hm-meta">
              資料日:{meta.dataDate}
              {meta.isToday ? " (今日)" : " (前一交易日)"}
              {meta.fetchedAt &&
                ` · 取得時間:${new Date(meta.fetchedAt).toLocaleTimeString(
                  "zh-TW"
                )}`}
            </div>
          )}

          {error && (
            <div className={`hm-error ${meta && meta.stale ? "hm-warn" : ""}`}>
              {error}
            </div>
          )}

          <div
            className="hm-canvas"
            ref={containerRef}
            style={{ height: containerSize.h }}
          >
            {loading && topRows.length === 0 ? (
              <div className="hm-loading">
                <span className="dot">●</span>
                <span className="dot">●</span>
                <span className="dot">●</span>
                <span style={{ marginLeft: 8 }}>正在掃描全市場…</span>
              </div>
            ) : (
              tiles.map((t, idx) => {
                if (t.kind === "group") {
                  return (
                    <div
                      key={`g-${idx}-${t.industry}`}
                      className="hm-group-label"
                      style={{
                        left: t.rect.x,
                        top: t.rect.y,
                        width: t.rect.w,
                        height: t.rect.h,
                      }}
                    >
                      {t.industry}
                    </div>
                  );
                }
                // 個股 tile
                if (!t.rect || t.rect.w < 2 || t.rect.h < 2) return null;
                const isInWatch =
                  watchlist && watchlist.some((w) => w.sym === t.symbol);
                const tooSmall = t.rect.w < 36 || t.rect.h < 24;
                return (
                  <div
                    key={`s-${t.symbol}-${idx}`}
                    className={`hm-tile hm-tile-enter ${
                      isInWatch ? "in-watch" : ""
                    }`}
                    style={{
                      left: t.rect.x,
                      top: t.rect.y,
                      width: t.rect.w - 1.5,
                      height: t.rect.h - 1.5,
                      background: chgToColor(t.chgPct),
                      animationDelay: `${Math.min(idx * 12, 2000)}ms`,
                    }}
                    onClick={() => onPickSymbol && onPickSymbol(t.symbol)}
                    onMouseEnter={() => setActiveStock(t)}
                    onMouseLeave={() => setActiveStock(null)}
                    title={`${t.symbol} ${t.displayName} ${
                      t.chgPct >= 0 ? "+" : ""
                    }${t.chgPct.toFixed(2)}%`}
                  >
                    {!tooSmall && (
                      <>
                        <div className="hm-tile-sym">{t.symbol}</div>
                        {t.rect.h >= 38 && (
                          <div className="hm-tile-chg">
                            {t.chgPct >= 0 ? "+" : ""}
                            {t.chgPct.toFixed(2)}%
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })
            )}
            {activeStock && (
              <div className="hm-tooltip">
                <div className="hm-tt-head">
                  <span className="hm-tt-sym">{activeStock.symbol}</span>
                  <span className="hm-tt-name">{activeStock.displayName}</span>
                </div>
                <div className="hm-tt-body">
                  <div className="hm-tt-row">
                    <span>產業</span>
                    <span>{activeStock.industry}</span>
                  </div>
                  <div className="hm-tt-row">
                    <span>收盤</span>
                    <span>{activeStock.close.toFixed(2)}</span>
                  </div>
                  <div
                    className={`hm-tt-row ${
                      activeStock.chgPct >= 0 ? "up" : "down"
                    }`}
                  >
                    <span>漲跌幅</span>
                    <span>
                      {activeStock.chgPct >= 0 ? "+" : ""}
                      {activeStock.chgPct.toFixed(2)}%
                    </span>
                  </div>
                  <div className="hm-tt-row">
                    <span>成交量</span>
                    <span>{(activeStock.vol / 1000).toFixed(0)}K</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 圖例 */}
          <div className="hm-legend">
            <span className="hm-legend-label">漲跌幅</span>
            <div className="hm-legend-bar">
              {[-7, -5, -3, -1, 0, 1, 3, 5, 7].map((v) => (
                <div
                  key={v}
                  className="hm-legend-cell"
                  style={{ background: chgToColor(v) }}
                  title={`${v >= 0 ? "+" : ""}${v}%`}
                />
              ))}
            </div>
            <span className="hm-legend-tip">區塊大小 = 成交金額</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── 🎯 同業四軸雷達圖 ──────────────────────────────────────
 * IndustryCompare 專用,4 軸 percentile 視覺化
 * 底圖:同業中位數(灰色)  主圖:目標股(紫色)
 * 軸:北=漲跌幅 / 東=成交額 / 南=流動性(vol) / 西=波動度(|chgPct|)
 * --------------------------------------------------------- */
function PeerRadar({ pctiles, targetName }) {
  // pctiles: { chg, turnover, vol, vola } 各 0-100,代表目標股在同業中的 percentile
  // 中位數固定畫在 50(同業基準)
  const cx = 110,
    cy = 110,
    r = 75;
  const angles = [-90, 0, 90, 180]; // 上右下左
  const axes = [
    { key: "chg", label: "漲跌幅" },
    { key: "turnover", label: "成交額" },
    { key: "vol", label: "流動性" },
    { key: "vola", label: "波動度" },
  ];

  const scoreToPt = (score, angleDeg) => {
    const rad = (angleDeg * Math.PI) / 180;
    const d = (Math.max(0, Math.min(100, score)) / 100) * r;
    return [cx + Math.cos(rad) * d, cy + Math.sin(rad) * d];
  };

  // 目標股 polygon 點
  const targetPts = axes
    .map((a, i) => {
      const p = scoreToPt(pctiles[a.key] ?? 0, angles[i]);
      return `${p[0]},${p[1]}`;
    })
    .join(" ");

  // 同業中位 polygon 點(每軸固定 50)
  const medianPts = angles
    .map((ag) => {
      const p = scoreToPt(50, ag);
      return `${p[0]},${p[1]}`;
    })
    .join(" ");

  // 軸標籤位置
  const axisInfo = axes.map((a, i) => {
    const rad = (angles[i] * Math.PI) / 180;
    return {
      label: a.label,
      score: pctiles[a.key] ?? 0,
      x: cx + Math.cos(rad) * (r + 18),
      y: cy + Math.sin(rad) * (r + 18),
    };
  });

  return (
    <div className="ic-radar-wrap">
      <svg viewBox="0 0 220 220" className="ic-radar">
        <defs>
          <linearGradient id="icRadarFill" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.15" />
          </linearGradient>
        </defs>

        {/* 三圈背景刻度 25/50/75/100 */}
        {[0.25, 0.5, 0.75, 1].map((s, i) => {
          const pts = angles
            .map((ag) => {
              const rad = (ag * Math.PI) / 180;
              const d = s * r;
              return `${cx + Math.cos(rad) * d},${cy + Math.sin(rad) * d}`;
            })
            .join(" ");
          return (
            <polygon
              key={i}
              points={pts}
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="1"
            />
          );
        })}

        {/* 四條軸線 */}
        {angles.map((ag, i) => {
          const rad = (ag * Math.PI) / 180;
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={cx + Math.cos(rad) * r}
              y2={cy + Math.sin(rad) * r}
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="1"
            />
          );
        })}

        {/* 同業中位數多邊形(灰色底圖) */}
        <polygon
          points={medianPts}
          fill="rgba(139,148,167,0.1)"
          stroke="rgba(139,148,167,0.5)"
          strokeWidth="1"
          strokeDasharray="3,3"
        />

        {/* 目標股多邊形(主圖) */}
        <polygon
          points={targetPts}
          fill="url(#icRadarFill)"
          stroke="#8b5cf6"
          strokeWidth="2"
        />

        {/* 目標股四個頂點 */}
        {axes.map((a, i) => {
          const p = scoreToPt(pctiles[a.key] ?? 0, angles[i]);
          return (
            <circle
              key={i}
              cx={p[0]}
              cy={p[1]}
              r="3.5"
              fill="#a78bfa"
              stroke="#fff"
              strokeWidth="1.5"
            />
          );
        })}

        {/* 軸標籤 */}
        {axisInfo.map((info, i) => (
          <g key={i}>
            <text
              x={info.x}
              y={info.y - 2}
              textAnchor="middle"
              fontSize="10.5"
              fill="var(--text-muted)"
              fontFamily="Inter, sans-serif"
              fontWeight="600"
            >
              {info.label}
            </text>
            <text
              x={info.x}
              y={info.y + 11}
              textAnchor="middle"
              fontSize="11"
              fill="#a78bfa"
              fontFamily="JetBrains Mono, monospace"
              fontWeight="700"
            >
              {info.score}
            </text>
          </g>
        ))}
      </svg>

      {/* 圖例 */}
      <div className="ic-radar-legend">
        <div className="ic-radar-legend-item">
          <span className="ic-radar-dot ic-radar-dot-target" />
          <span>{targetName || "本檔"}</span>
        </div>
        <div className="ic-radar-legend-item">
          <span className="ic-radar-dot ic-radar-dot-median" />
          <span>同業中位</span>
        </div>
        <div className="ic-radar-note">數值 = percentile (0-100,越大越強)</div>
      </div>
    </div>
  );
}

/* ─── 🏢 同產業比較面板 ───────────────────────────────────────
 * 個股研究頁專用,預設摺疊;展開時拉 fetchMarketDailyChange() 結果,
 * 用 getIndustryPeers 篩出同業 Top 8 並計算 percentile,複用 30 分鐘快取。
 * --------------------------------------------------------- */
function IndustryComparePanel({
  symbol,
  stockName,
  onPickSymbol,
  forceExpand = false,
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [peers, setPeers] = useState([]);
  const [staleNote, setStaleNote] = useState("");
  const [sortBy, setSortBy] = useState("turnover"); // turnover | chgPct | close
  const loadedSymRef = useRef(null);

  const industry = symbol ? getIndustry(symbol) : "";
  const nonComparable = industry === "ETF" || industry === "其他";

  async function loadPeers() {
    if (!symbol || nonComparable) return;
    setLoading(true);
    setError("");
    setStaleNote("");
    try {
      const result = await fetchMarketDailyChange();
      const rows = result.rows || [];
      if (!rows.length) {
        if (result.sourceError) {
          setError("TWSE 資料源暫時無回應(可能在維護中)。請幾分鐘後重試。");
        } else {
          setError("無法取得市場資料");
        }
        setPeers([]);
        return;
      }
      if (result.stale && result.staleMin != null) {
        setStaleNote(`目前顯示 ${result.staleMin} 分鐘前的快照`);
      }
      const list = getIndustryPeers(symbol, rows, { limit: 8, sortBy });
      setPeers(list);
      if (!list.length) {
        setError("同產業可比個數不足");
      }
      loadedSymRef.current = symbol;
    } catch (e) {
      dlog(`[同業比較] 載入失敗: ${e?.message || e}`);
      setError("載入失敗,請重試");
      setPeers([]);
    } finally {
      setLoading(false);
    }
  }

  // 展開時觸發載入(切股後需重抓)
  useEffect(() => {
    if (
      (open || forceExpand) &&
      symbol &&
      loadedSymRef.current !== symbol &&
      !nonComparable
    ) {
      loadPeers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, forceExpand, symbol]);

  // sortBy 改變時若已展開就重排(不用重抓,只是 client-side sort)
  useEffect(() => {
    if (peers.length > 1) {
      const sorted = [...peers].sort((a, b) => {
        // 維持 forcedLast 釘在尾巴
        if (a.forcedLast && !b.forcedLast) return 1;
        if (!a.forcedLast && b.forcedLast) return -1;
        return (b[sortBy] ?? 0) - (a[sortBy] ?? 0);
      });
      setPeers(sorted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortBy]);

  // 切股時收起並清狀態(避免使用者點下一檔還看到上一檔的同業)
  useEffect(() => {
    if (loadedSymRef.current && loadedSymRef.current !== symbol) {
      setPeers([]);
      setError("");
      setStaleNote("");
      loadedSymRef.current = null;
    }
  }, [symbol]);

  // 算 percentile 與中位數(只算非 forcedLast 進統計池,避免被擠下來的目標股扭曲基準)
  const stats = useMemo(() => {
    if (!peers.length) return null;
    const pool = peers.filter((p) => !p.forcedLast);
    const chgArr = pool.map((p) => p.chgPct);
    const turnoverArr = pool.map((p) => p.turnover);
    const closeArr = pool.map((p) => p.close);
    const volArr = pool.map((p) => p.vol);
    const volaArr = pool.map((p) => Math.abs(p.chgPct));
    const target = peers.find((p) => p.isTarget);
    return {
      medianChg: peerMedian(chgArr),
      medianTurnover: peerMedian(turnoverArr),
      medianClose: peerMedian(closeArr),
      target,
      targetChgPctile: target ? computePercentile(target.chgPct, chgArr) : null,
      targetTurnoverPctile: target
        ? computePercentile(target.turnover, turnoverArr)
        : null,
      targetVolPctile: target ? computePercentile(target.vol, volArr) : null,
      targetVolaPctile: target
        ? computePercentile(Math.abs(target.chgPct), volaArr)
        : null,
      poolSize: pool.length,
    };
  }, [peers]);

  function fmtTurnover(v) {
    if (!Number.isFinite(v) || v <= 0) return "—";
    if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 億`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(1)} 萬`;
    return v.toFixed(0);
  }
  function fmtChg(v) {
    if (!Number.isFinite(v)) return "—";
    const s = v >= 0 ? "+" : "";
    return `${s}${v.toFixed(2)}%`;
  }

  return (
    <div className="ic-panel">
      <div className="ic-header" onClick={() => setOpen((v) => !v)}>
        <div className="ic-title-group">
          <span className="ic-eyebrow">INDUSTRY PEERS · 同業比較</span>
          <div className="ic-title">
            {industry ? `${industry} · 同業` : "同產業比較"}
            {peers.length > 0 && (
              <span className="ic-count-badge">{peers.length}</span>
            )}
          </div>
        </div>
        <button
          className="ic-toggle-btn"
          type="button"
          aria-expanded={open || forceExpand}
        >
          {open || forceExpand ? "收起 ▲" : "展開 ▼"}
        </button>
      </div>

      {(open || forceExpand) && (
        <div className="ic-body">
          {nonComparable ? (
            <div className="ic-notice">
              {industry === "ETF"
                ? "ETF 不適用同業比較(指數型商品)"
                : "此股無法歸類產業,無法做同業比較"}
            </div>
          ) : loading ? (
            <div className="ic-notice">載入中…</div>
          ) : error ? (
            <div className={`ic-notice ${staleNote ? "ic-warn" : "ic-error"}`}>
              {error}
            </div>
          ) : peers.length === 0 ? (
            <div className="ic-notice">同產業可比個數不足</div>
          ) : (
            <>
              {staleNote && <div className="ic-stale-note">{staleNote}</div>}

              {/* 排序工具列 */}
              <div className="ic-toolbar">
                <span className="ic-toolbar-label">排序:</span>
                <button
                  className={`ic-sort-btn ${
                    sortBy === "turnover" ? "is-active" : ""
                  }`}
                  onClick={() => setSortBy("turnover")}
                  type="button"
                >
                  成交金額
                </button>
                <button
                  className={`ic-sort-btn ${
                    sortBy === "chgPct" ? "is-active" : ""
                  }`}
                  onClick={() => setSortBy("chgPct")}
                  type="button"
                >
                  漲跌幅
                </button>
                <button
                  className={`ic-sort-btn ${
                    sortBy === "close" ? "is-active" : ""
                  }`}
                  onClick={() => setSortBy("close")}
                  type="button"
                >
                  股價
                </button>
                <button
                  className="ic-refresh-btn"
                  onClick={loadPeers}
                  type="button"
                  title="重新拉取"
                >
                  ⟳
                </button>
              </div>

              {/* 表格 */}
              <div className="ic-table-wrap">
                <table className="ic-table">
                  <thead>
                    <tr>
                      <th className="ic-col-sym">代碼</th>
                      <th className="ic-col-name">名稱</th>
                      <th className="ic-col-num">收盤</th>
                      <th className="ic-col-num">漲跌幅</th>
                      <th className="ic-col-num">成交金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {peers.map((p) => {
                      const up = p.chgPct > 0;
                      const down = p.chgPct < 0;
                      return (
                        <tr
                          key={p.symbol}
                          className={`${p.isTarget ? "is-target" : ""} ${
                            p.forcedLast ? "is-forced" : ""
                          }`}
                          onClick={() => onPickSymbol && onPickSymbol(p.symbol)}
                          title={p.isTarget ? "目前個股" : `查看 ${p.symbol}`}
                        >
                          <td className="ic-col-sym">
                            {p.symbol}
                            {p.isTarget && (
                              <span className="ic-target-tag">本檔</span>
                            )}
                          </td>
                          <td className="ic-col-name">{p.name || "—"}</td>
                          <td className="ic-col-num">{p.close.toFixed(2)}</td>
                          <td
                            className={`ic-col-num ${
                              up ? "ic-up" : down ? "ic-down" : ""
                            }`}
                          >
                            {fmtChg(p.chgPct)}
                          </td>
                          <td className="ic-col-num">
                            {fmtTurnover(p.turnover)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* 四軸雷達圖(只在有統計池且 target 存在時顯示) */}
              {stats && stats.target && stats.poolSize >= 3 && (
                <PeerRadar
                  pctiles={{
                    chg: stats.targetChgPctile ?? 50,
                    turnover: stats.targetTurnoverPctile ?? 50,
                    vol: stats.targetVolPctile ?? 50,
                    vola: stats.targetVolaPctile ?? 50,
                  }}
                  targetName={stats.target.symbol}
                />
              )}

              {/* 統計摘要 */}
              {stats && stats.target && stats.poolSize >= 2 && (
                <div className="ic-stats">
                  <div className="ic-stat-row">
                    <span className="ic-stat-label">同業中位漲跌幅</span>
                    <span
                      className={`ic-stat-val ${
                        stats.medianChg > 0
                          ? "ic-up"
                          : stats.medianChg < 0
                          ? "ic-down"
                          : ""
                      }`}
                    >
                      {fmtChg(stats.medianChg)}
                    </span>
                  </div>
                  <div className="ic-stat-row">
                    <span className="ic-stat-label">本檔漲跌幅 vs 同業</span>
                    <span className="ic-stat-val">
                      {stats.targetChgPctile != null
                        ? `贏過 ${stats.targetChgPctile}% 同業`
                        : "—"}
                    </span>
                  </div>
                  <div className="ic-stat-row">
                    <span className="ic-stat-label">本檔成交額 vs 同業</span>
                    <span className="ic-stat-val">
                      {stats.targetTurnoverPctile != null
                        ? `贏過 ${stats.targetTurnoverPctile}% 同業`
                        : "—"}
                    </span>
                  </div>
                </div>
              )}

              <div className="ic-footnote">
                資料源 · TWSE MI_INDEX(成交金額 = 成交量 × 收盤價)
                {peers.some((p) => p.forcedLast) && (
                  <span className="ic-footnote-note">
                    {" "}
                    · 本檔未進同業 Top 8,顯示在末列供對照
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── 🔍 智能選股器面板 ──────────────────────────────────────
 * 主面板區工具,預設摺疊;展開時拉 fetchMarketDailyChange 結果,
 * 套 applyScreener 篩選,顯示 Top 20。複用 30 分鐘快取,零新 API。
 * 設計取捨:每次展開恢復預設值(使用者明確選擇),條件改動即時重算。
 * --------------------------------------------------------- */
function ScreenerPanel({ stockMap, watchlist, onPickSymbol }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [staleNote, setStaleNote] = useState("");
  const [marketRows, setMarketRows] = useState([]); // 原始 rows 快取(供本面板用)
  const [criteria, setCriteria] = useState(SCREENER_DEFAULT_CRITERIA);
  const [activePresetId, setActivePresetId] = useState(null);
  const loadedRef = useRef(false);

  const watchlistSyms = useMemo(
    () => (watchlist || []).map((w) => w.sym),
    [watchlist]
  );

  // 即時計算符合結果(不依賴按鈕)
  const filtered = useMemo(() => {
    if (!marketRows.length) return [];
    return applyScreener(marketRows, criteria, watchlistSyms);
  }, [marketRows, criteria, watchlistSyms]);

  // 取 Top 20(依成交金額降冪)
  const displayRows = useMemo(() => {
    return [...filtered]
      .sort((a, b) => (b.turnover || 0) - (a.turnover || 0))
      .slice(0, 20);
  }, [filtered]);

  async function loadMarket(force = false) {
    if (loadedRef.current && !force) return;
    setLoading(true);
    setError("");
    setStaleNote("");
    try {
      const result = await fetchMarketDailyChange();
      const rows = result.rows || [];
      if (!rows.length) {
        if (result.sourceError) {
          setError("TWSE 資料源暫時無回應(可能在維護中)。請幾分鐘後重試。");
        } else {
          setError("無法取得市場資料");
        }
        setMarketRows([]);
        return;
      }
      if (result.stale && result.staleMin != null) {
        setStaleNote(`目前顯示 ${result.staleMin} 分鐘前的快照`);
      }
      setMarketRows(rows);
      loadedRef.current = true;
    } catch (e) {
      dlog(`[選股器] 載入失敗: ${e?.message || e}`);
      setError("載入失敗,請重試");
      setMarketRows([]);
    } finally {
      setLoading(false);
    }
  }

  // 第一次展開時載入
  useEffect(() => {
    if (open && !loadedRef.current) {
      loadMarket();
    }
  }, [open]);

  // 展開時恢復預設條件(依設計決策:每次展開都是預設值)
  useEffect(() => {
    if (open) {
      setCriteria(SCREENER_DEFAULT_CRITERIA);
      setActivePresetId(null);
    }
  }, [open]);

  function applyPreset(preset) {
    setCriteria(preset.criteria);
    setActivePresetId(preset.id);
  }

  function resetCriteria() {
    setCriteria(SCREENER_DEFAULT_CRITERIA);
    setActivePresetId(null);
  }

  function updateCriteria(patch) {
    setCriteria((c) => ({ ...c, ...patch }));
    setActivePresetId(null); // 手改參數視為脫離 preset
  }

  function fmtTurnover(v) {
    if (!Number.isFinite(v) || v <= 0) return "—";
    if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 億`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(0)} 萬`;
    return v.toFixed(0);
  }
  function fmtChg(v) {
    if (!Number.isFinite(v)) return "—";
    const s = v >= 0 ? "+" : "";
    return `${s}${v.toFixed(2)}%`;
  }

  return (
    <div className="sc-panel">
      <div className="sc-header" onClick={() => setOpen((v) => !v)}>
        <div className="sc-title-group">
          <span className="sc-eyebrow">SMART SCREENER · 智能選股器</span>
          <div className="sc-title">
            🔍 智能選股器
            {open && filtered.length > 0 && (
              <span className="sc-count-badge">符合 {filtered.length} 檔</span>
            )}
          </div>
        </div>
        <button className="sc-toggle-btn" type="button" aria-expanded={open}>
          {open ? "收起 ▲" : "展開 ▼"}
        </button>
      </div>

      {open && (
        <div className="sc-body">
          {/* 預設套組 */}
          <div className="sc-presets">
            <div className="sc-presets-label">快選</div>
            <div className="sc-presets-list">
              {SCREENER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className={`sc-preset-btn ${
                    activePresetId === preset.id ? "is-active" : ""
                  }`}
                  onClick={() => applyPreset(preset)}
                  title={preset.desc}
                  type="button"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* 條件區 */}
          <div className="sc-criteria">
            {/* 股價區間 */}
            <div className="sc-row">
              <label className="sc-label">💰 股價區間 (元)</label>
              <div className="sc-input-pair">
                <input
                  type="number"
                  className="sc-input"
                  value={criteria.priceMin}
                  min={0}
                  max={3000}
                  step={1}
                  onChange={(e) =>
                    updateCriteria({ priceMin: +e.target.value || 0 })
                  }
                />
                <span className="sc-dash">—</span>
                <input
                  type="number"
                  className="sc-input"
                  value={criteria.priceMax}
                  min={0}
                  max={3000}
                  step={1}
                  onChange={(e) =>
                    updateCriteria({ priceMax: +e.target.value || 0 })
                  }
                />
              </div>
            </div>

            {/* 漲跌幅 */}
            <div className="sc-row">
              <label className="sc-label">📈 漲跌幅 (%)</label>
              <div className="sc-input-pair">
                <input
                  type="number"
                  className="sc-input"
                  value={criteria.chgMin}
                  min={-10}
                  max={10}
                  step={0.1}
                  onChange={(e) =>
                    updateCriteria({ chgMin: +e.target.value || 0 })
                  }
                />
                <span className="sc-dash">—</span>
                <input
                  type="number"
                  className="sc-input"
                  value={criteria.chgMax}
                  min={-10}
                  max={10}
                  step={0.1}
                  onChange={(e) =>
                    updateCriteria({ chgMax: +e.target.value || 0 })
                  }
                />
              </div>
            </div>

            {/* 產業 */}
            <div className="sc-row">
              <label className="sc-label">🏭 產業類別</label>
              <select
                className="sc-select"
                value={criteria.industry}
                onChange={(e) => updateCriteria({ industry: e.target.value })}
              >
                {SCREENER_INDUSTRIES.map((ind) => (
                  <option key={ind} value={ind}>
                    {ind}
                  </option>
                ))}
              </select>
            </div>

            {/* 成交金額下限 */}
            <div className="sc-row">
              <label className="sc-label">💵 成交金額下限</label>
              <select
                className="sc-select"
                value={criteria.minTurnover}
                onChange={(e) =>
                  updateCriteria({ minTurnover: +e.target.value })
                }
              >
                {SCREENER_TURNOVER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 僅自選股 */}
            <div className="sc-row sc-row-toggle">
              <label className="sc-label">⭐ 僅顯示自選股</label>
              <button
                type="button"
                className={`sc-switch ${criteria.watchlistOnly ? "is-on" : ""}`}
                onClick={() =>
                  updateCriteria({ watchlistOnly: !criteria.watchlistOnly })
                }
                aria-pressed={criteria.watchlistOnly}
              >
                <span className="sc-switch-dot" />
              </button>
            </div>
          </div>

          {/* 動作列 */}
          <div className="sc-actions">
            <button
              className="sc-reset-btn"
              onClick={resetCriteria}
              type="button"
            >
              ↺ 重置
            </button>
            <button
              className="sc-refresh-btn"
              onClick={() => loadMarket(true)}
              type="button"
              title="重新拉取市場資料"
            >
              ⟳ 重新整理資料
            </button>
            <div className="sc-result-summary">
              {loading
                ? "載入中…"
                : marketRows.length
                ? `符合 ${filtered.length} 檔 · 顯示 Top ${Math.min(
                    20,
                    filtered.length
                  )}`
                : ""}
            </div>
          </div>

          {/* 提示區 */}
          {staleNote && <div className="sc-stale-note">{staleNote}</div>}
          {error && <div className="sc-error">{error}</div>}

          {/* 結果表 */}
          {loading ? (
            <div className="sc-notice">載入市場資料中…</div>
          ) : !marketRows.length ? (
            <div className="sc-notice">請點「重新整理資料」</div>
          ) : displayRows.length === 0 ? (
            <div className="sc-notice">
              無符合條件的股票,試試放寬條件或點「重置」
            </div>
          ) : (
            <div className="sc-table-wrap">
              <table className="sc-table">
                <thead>
                  <tr>
                    <th className="sc-col-sym">代碼</th>
                    <th className="sc-col-name">名稱</th>
                    <th className="sc-col-num">股價</th>
                    <th className="sc-col-num">漲跌</th>
                    <th className="sc-col-ind">產業</th>
                    <th className="sc-col-num">成交額</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((r) => {
                    const up = r.chgPct > 0;
                    const down = r.chgPct < 0;
                    const isWatched = watchlistSyms.includes(r.symbol);
                    return (
                      <tr
                        key={r.symbol}
                        onClick={() => onPickSymbol && onPickSymbol(r.symbol)}
                        title={`查看 ${r.symbol}`}
                      >
                        <td className="sc-col-sym">
                          {r.symbol}
                          {isWatched && (
                            <span className="sc-watch-mark">⭐</span>
                          )}
                        </td>
                        <td className="sc-col-name">
                          {r.name || stockMap[r.symbol] || "—"}
                        </td>
                        <td className="sc-col-num">{r.close.toFixed(2)}</td>
                        <td
                          className={`sc-col-num ${
                            up ? "sc-up" : down ? "sc-down" : ""
                          }`}
                        >
                          {fmtChg(r.chgPct)}
                        </td>
                        <td className="sc-col-ind">{r.industry}</td>
                        <td className="sc-col-num">
                          {fmtTurnover(r.turnover)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="sc-footnote">
            資料源 · TWSE MI_INDEX · 結果依成交金額降冪排序
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── 🌟 BatchExportModal:自選股批次匯出選擇 ─────────────── */
function BatchExportModal({ watchlist, stockMap, onConfirm, onCancel }) {
  const [selectedSet, setSelectedSet] = useState(
    () => new Set((watchlist || []).map((w) => w.sym))
  );

  function toggle(sym) {
    const next = new Set(selectedSet);
    if (next.has(sym)) next.delete(sym);
    else next.add(sym);
    setSelectedSet(next);
  }

  function selectAll() {
    setSelectedSet(new Set((watchlist || []).map((w) => w.sym)));
  }
  function clearAll() {
    setSelectedSet(new Set());
  }

  const selectedCount = selectedSet.size;
  const canConfirm = selectedCount > 0;

  return (
    <div className="be-modal-backdrop" onClick={onCancel}>
      <div className="be-modal" onClick={(e) => e.stopPropagation()}>
        <div className="be-modal-header">
          <div>
            <div className="be-modal-eyebrow">BATCH EXPORT · 批次匯出</div>
            <h3 className="be-modal-title">自選股批次匯出 PDF</h3>
          </div>
          <button className="be-modal-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="be-modal-body">
          <p className="be-modal-desc">
            勾選要匯出的個股,每檔會單獨產生一份 PDF 自動下載。
            <br />
            <span className="be-modal-desc-faint">預計耗時:每檔約 2-3 秒</span>
          </p>

          <div className="be-toolbar">
            <button className="be-tool-btn" onClick={selectAll} type="button">
              全選
            </button>
            <button className="be-tool-btn" onClick={clearAll} type="button">
              全不選
            </button>
            <div className="be-selected-count">
              已選 <b>{selectedCount}</b> / {watchlist.length} 檔
            </div>
          </div>

          <div className="be-list">
            {!watchlist || !watchlist.length ? (
              <div className="be-empty">尚未加入任何自選股</div>
            ) : (
              watchlist.map((item) => {
                const checked = selectedSet.has(item.sym);
                const name = item.name || stockMap[item.sym] || item.sym;
                return (
                  <label
                    key={item.sym}
                    className={`be-row ${checked ? "is-checked" : ""}`}
                  >
                    <input
                      type="checkbox"
                      className="be-checkbox"
                      checked={checked}
                      onChange={() => toggle(item.sym)}
                    />
                    <span className="be-row-sym">{item.sym}</span>
                    <span className="be-row-name">{name}</span>
                  </label>
                );
              })
            )}
          </div>

          {selectedCount > 5 && (
            <div className="be-warn">
              ⚠️ 一次匯出 {selectedCount}{" "}
              檔,瀏覽器可能會提示「允許多檔下載」,請點允許
            </div>
          )}
        </div>

        <div className="be-modal-footer">
          <button className="be-btn-cancel" onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="be-btn-confirm"
            onClick={() => onConfirm(Array.from(selectedSet))}
            disabled={!canConfirm}
            type="button"
          >
            開始匯出 {selectedCount > 0 && `(${selectedCount} 檔)`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── 🌟 BatchExportProgress:批次匯出進度面板 ──────────── */
function BatchExportProgress({ progress, stockMap, onClose }) {
  const { current, total, currentSym, status, errors } = progress;
  const isDone = status === "done";
  const isError = isDone && errors.length > 0;
  const pct = total ? Math.round((current / total) * 100) : 0;

  const statusText =
    status === "starting"
      ? "準備中…"
      : status === "loading"
      ? `載入 ${currentSym}…`
      : status === "exporting"
      ? `匯出 ${currentSym}…`
      : isError
      ? `完成,${errors.length} 檔失敗`
      : "全部完成 ✓";

  return (
    <div className="bep-wrap">
      <div className="bep-card">
        <div className="bep-header">
          <span className="bep-eyebrow">BATCH EXPORT</span>
          <span className="bep-counter">
            {current} / {total}
          </span>
        </div>

        <div className="bep-status">{statusText}</div>

        <div className="bep-progress-track">
          <div
            className={`bep-progress-fill ${
              isDone ? (isError ? "is-error" : "is-success") : ""
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>

        {errors.length > 0 && (
          <div className="bep-errors">
            <div className="bep-errors-title">失敗的個股:</div>
            {errors.map((e, i) => (
              <div key={i} className="bep-error-row">
                <span className="bep-error-sym">{e.sym}</span>
                <span className="bep-error-name">
                  {stockMap[e.sym] || e.name}
                </span>
                <span className="bep-error-msg">{e.msg}</span>
              </div>
            ))}
          </div>
        )}

        {isDone && (
          <button className="bep-close-btn" onClick={onClose} type="button">
            關閉
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── ⭐️ Top10 排行榜面板 (D 方案:兩階段) ─────────────────── */
function Top10Panel({ stockMap, onPickSymbol }) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("market"); // "market" | "elite"
  const [marketRows, setMarketRows] = useState([]);
  const [marketMeta, setMarketMeta] = useState(null); // { dataDate, isToday, fetchedAt }
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [eliteRows, setEliteRows] = useState([]);
  const [eliteLoading, setEliteLoading] = useState(false);
  const [eliteError, setEliteError] = useState("");
  const [eliteProgress, setEliteProgress] = useState(0);
  const eliteLoadedRef = useRef(false);
  const exportRef = useRef(null); // 匯出截圖目標

  async function loadMarket() {
    setMarketLoading(true);
    setMarketError("");
    try {
      const result = await fetchMarketDailyChange();
      const rows = result.rows || [];
      if (!rows.length) {
        if (result.sourceError) {
          setMarketError(
            "TWSE 資料源暫時無回應(可能維護中或週末/假日)。請幾分鐘後重試。"
          );
        } else {
          setMarketError("無法取得全市場資料(可能假日或資料源延遲)");
        }
      } else if (result.stale) {
        setMarketError(
          `TWSE 暫時無回應,目前顯示 ${result.staleMin} 分鐘前的快照`
        );
      }
      // 補上中文名稱
      const enriched = rows.map((r) => ({
        ...r,
        displayName: r.name || (stockMap && stockMap[r.symbol]) || "",
      }));
      setMarketRows(enriched);
      setMarketMeta({
        dataDate: result.dataDate,
        isToday: result.isToday,
        fetchedAt: result.fetchedAt,
        stale: result.stale,
      });
    } catch (e) {
      setMarketError("載入失敗: " + e.message);
    }
    setMarketLoading(false);
  }

  async function loadElite() {
    setEliteLoading(true);
    setEliteError("");
    setEliteProgress(0);
    eliteLoadedRef.current = true;
    try {
      // 進度顯示用一個假動畫
      const total = ELITE_POOL_UNIQ.length;
      let done = 0;
      const progressTimer = setInterval(() => {
        done = Math.min(done + 1, total - 5);
        setEliteProgress(Math.round((done / total) * 100));
      }, 350);
      const rows = await fetchEliteRanking(stockMap);
      clearInterval(progressTimer);
      setEliteProgress(100);
      if (!rows.length) setEliteError("無法取得精選評級資料");
      setEliteRows(rows);
    } catch (e) {
      setEliteError("載入失敗: " + e.message);
    }
    setEliteLoading(false);
  }

  // 第一次展開時自動載入當前 Tab
  useEffect(() => {
    if (!open) return;
    if (activeTab === "market" && marketRows.length === 0 && !marketLoading) {
      loadMarket();
    } else if (
      activeTab === "elite" &&
      !eliteLoadedRef.current &&
      !eliteLoading
    ) {
      loadElite();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeTab]);

  // ⭐️ 快捷鍵 G:外部派發 quant:open-top10 → 展開 + 滾入視野
  useEffect(() => {
    function onOpenSignal() {
      setOpen(true);
      // 下一個 tick 才能找到展開後的元素，等 React 重 render
      requestAnimationFrame(() => {
        const el = document.querySelector(".t10-panel");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    window.addEventListener("quant:open-top10", onOpenSignal);
    return () => window.removeEventListener("quant:open-top10", onOpenSignal);
  }, []);

  // 全市場榜 Top10 / Bottom10
  const marketTop = useMemo(() => {
    return [...marketRows].sort((a, b) => b.chgPct - a.chgPct).slice(0, 10);
  }, [marketRows]);
  const marketBottom = useMemo(() => {
    return [...marketRows].sort((a, b) => a.chgPct - b.chgPct).slice(0, 10);
  }, [marketRows]);

  // 精選榜 Top10 / Bottom10 (綜合分數)
  const eliteTop = useMemo(() => {
    return [...eliteRows]
      .sort((a, b) => b.composite - a.composite)
      .slice(0, 10);
  }, [eliteRows]);
  const eliteBottom = useMemo(() => {
    return [...eliteRows]
      .sort((a, b) => a.composite - b.composite)
      .slice(0, 10);
  }, [eliteRows]);

  return (
    <div className="t10-panel">
      <div className="t10-header">
        <div className="t10-title-group">
          <span className="t10-eyebrow">MARKET RANKINGS · 當日排行</span>
          <div className="t10-title">
            Top 10 投資標的
            {(marketRows.length > 0 || eliteRows.length > 0) && (
              <span className="t10-cnt-badge">
                {activeTab === "market" ? marketRows.length : eliteRows.length}
              </span>
            )}
          </div>
        </div>
        <div className="t10-header-right">
          {open &&
            ((activeTab === "market" && marketRows.length > 0) ||
              (activeTab === "elite" && eliteRows.length > 0)) && (
              <ExportButtons
                targetRef={exportRef}
                baseName={
                  activeTab === "market"
                    ? "QUANTEDGE_全市場榜"
                    : "QUANTEDGE_精選評級榜"
                }
                tag={activeTab === "market" ? "MARKET TOP10" : "ELITE RANKING"}
                compact
              />
            )}
          <button
            className="t10-toggle"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "收合" : "展開"}
          >
            <span className={`t10-chevron ${open ? "open" : ""}`}>›</span>
          </button>
        </div>
      </div>

      {open && (
        <div className="t10-body" ref={exportRef}>
          {/* Tab 切換 */}
          <div className="t10-tabs">
            <button
              className={`t10-tab ${activeTab === "market" ? "active" : ""}`}
              onClick={() => setActiveTab("market")}
            >
              <span className="t10-tab-label">全市場漲跌幅</span>
              <span className="t10-tab-sub">1700+ 檔 · 5 秒</span>
            </button>
            <button
              className={`t10-tab ${activeTab === "elite" ? "active" : ""}`}
              onClick={() => setActiveTab("elite")}
            >
              <span className="t10-tab-label">精選綜合評級</span>
              <span className="t10-tab-sub">大型股 ~70 檔 · 深入打分</span>
            </button>
          </div>

          {/* 全市場 Tab */}
          {activeTab === "market" && (
            <div className="t10-content">
              {marketLoading && (
                <div className="t10-loading">
                  <div className="t10-spinner"></div>
                  <span>正在抓取全市場 1700+ 檔資料...約 10-15 秒</span>
                </div>
              )}
              {marketError && !marketLoading && (
                <div className="t10-error">
                  {marketError}
                  <button className="t10-retry-btn" onClick={loadMarket}>
                    重試
                  </button>
                </div>
              )}
              {!marketLoading && !marketError && marketRows.length > 0 && (
                <>
                  <FreshnessBar
                    meta={marketMeta}
                    onRefresh={() => {
                      try {
                        localStorage.removeItem(SK.MARKET_DAILY);
                      } catch (e) {}
                      loadMarket();
                    }}
                  />
                  <div className="t10-grid">
                    <RankList
                      title="漲幅 Top 10"
                      badge="▲"
                      badgeClass="up"
                      rows={marketTop}
                      metricKey="chgPct"
                      metricLabel="當日漲跌"
                      onPick={onPickSymbol}
                    />
                    <RankList
                      title="跌幅 Top 10"
                      badge="▼"
                      badgeClass="down"
                      rows={marketBottom}
                      metricKey="chgPct"
                      metricLabel="當日漲跌"
                      onPick={onPickSymbol}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* 精選評級 Tab */}
          {activeTab === "elite" && (
            <div className="t10-content">
              {eliteLoading && (
                <div className="t10-loading">
                  <div className="t10-spinner"></div>
                  <div className="t10-progress-wrap">
                    <div className="t10-progress-label">
                      <span>正在打分 0050 + 0056 成分股</span>
                      <span className="t10-progress-pct">{eliteProgress}%</span>
                    </div>
                    <div className="t10-progress-track">
                      <div
                        className="t10-progress-fill"
                        style={{ width: `${eliteProgress}%` }}
                      ></div>
                    </div>
                    <div className="t10-progress-hint">
                      首次載入約 60 秒,之後 30 分鐘內走快取
                    </div>
                  </div>
                </div>
              )}
              {eliteError && !eliteLoading && (
                <div className="t10-error">
                  {eliteError}
                  <button className="t10-retry-btn" onClick={loadElite}>
                    重試
                  </button>
                </div>
              )}
              {!eliteLoading && !eliteError && eliteRows.length > 0 && (
                <div className="t10-grid">
                  <RankList
                    title="推薦買進 Top 10"
                    badge="✓"
                    badgeClass="up"
                    rows={eliteTop}
                    metricKey="composite"
                    metricLabel="綜合分數"
                    ratingMode={true}
                    onPick={onPickSymbol}
                  />
                  <RankList
                    title="建議賣出 Top 10"
                    badge="✕"
                    badgeClass="down"
                    rows={eliteBottom}
                    metricKey="composite"
                    metricLabel="綜合分數"
                    ratingMode={true}
                    onPick={onPickSymbol}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Top10 子元件:資料新鮮度狀態條 ─────────────────────── */
function FreshnessBar({ meta, onRefresh }) {
  if (!meta || !meta.dataDate) return null;

  // 解析 yyyymmdd → 顯示用 yyyy/mm/dd
  const d = meta.dataDate;
  const display = `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;

  // 資料時間屬性:即時 / 收盤 / 歷史
  const marketOpenNow = isMarketOpen();
  let label, cssClass;
  if (!meta.isToday) {
    // 抓到的不是今天(假日 / 跨日 / 失敗回推)
    label = "歷史快照";
    cssClass = "stale";
  } else if (marketOpenNow) {
    label = "● 即時 LIVE";
    cssClass = "live";
  } else {
    label = "✦ 收盤資料";
    cssClass = "closed";
  }

  // 抓取時間(相對)
  const ago = Date.now() - (meta.fetchedAt || 0);
  let agoStr = "";
  if (ago < 60000) agoStr = "剛剛";
  else if (ago < 3600000) agoStr = `${Math.floor(ago / 60000)} 分鐘前`;
  else agoStr = `${Math.floor(ago / 3600000)} 小時前`;

  return (
    <div className={`fresh-bar fresh-${cssClass}`}>
      <span className={`fresh-pill fresh-pill-${cssClass}`}>{label}</span>
      <span className="fresh-date">資料日期: {display}</span>
      <span className="fresh-sep">·</span>
      <span className="fresh-ago">{agoStr}更新</span>
      <button
        className="fresh-refresh"
        onClick={onRefresh}
        title="強制重新抓取"
      >
        ↻
      </button>
    </div>
  );
}

/* ─── Top10 子元件:單側排行清單 ───────────────────────────── */
function RankList({
  title,
  badge,
  badgeClass,
  rows,
  metricKey,
  metricLabel,
  secondaryKey,
  secondaryLabel,
  onPick,
  ratingMode,
}) {
  return (
    <div className="rank-col">
      <div className={`rank-col-head rank-${badgeClass}`}>
        <span className="rank-col-badge">{badge}</span>
        <span className="rank-col-title">{title}</span>
      </div>
      <div className="rank-rows">
        {rows.map((r, i) => {
          const mv = r[metricKey];
          const sv = secondaryKey ? r[secondaryKey] : null;
          const isUp = badgeClass === "up";
          return (
            <button
              key={r.symbol}
              className="rank-row"
              onClick={() => onPick && onPick(r.symbol)}
              title={`點擊查詢 ${r.symbol}`}
            >
              <span className="rank-no">{i + 1}</span>
              <div className="rank-stock">
                <div className="rank-stock-sym">{r.symbol}</div>
                <div className="rank-stock-name">
                  {r.displayName || r.name || "—"}
                </div>
              </div>
              <div className="rank-metric">
                {ratingMode ? (
                  // 推薦標籤模式(精選評級榜)
                  <>
                    <div
                      className={`rating-tag rating-${r.ratingClass || "hold"}`}
                    >
                      {r.rating || "—"}
                    </div>
                    <div className="rank-metric-sub neutral">
                      分數 {fmt(r.composite, 1)} · RSI {fmt(r.rsi, 0)}
                    </div>
                  </>
                ) : (
                  // 數值模式(全市場榜)
                  <>
                    <div className={`rank-metric-main ${isUp ? "up" : "down"}`}>
                      {metricKey === "chgPct"
                        ? `${mv >= 0 ? "+" : ""}${fmt(mv, 2)}%`
                        : fmt(mv, 1)}
                    </div>
                    {secondaryKey != null && (
                      <div
                        className={`rank-metric-sub ${sv >= 0 ? "up" : "down"}`}
                      >
                        {secondaryLabel} {sv >= 0 ? "+" : ""}
                        {fmt(sv, 2)}%
                      </div>
                    )}
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ⭐️ 投資組合模擬器 (PortfolioPanel)
   ═══════════════════════════════════════════════════════════════════ */
function PortfolioPanel({ stockMap, onPickSymbol }) {
  const [collapsed, setCollapsed] = useState(true);
  const [holdings, setHoldings] = useState([]);
  const [range, setRange] = useState("1Y");
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const exportRef = useRef(null); // 匯出截圖目標

  // 新增持倉的輸入欄位
  const [newSymbol, setNewSymbol] = useState("");
  const [newShares, setNewShares] = useState("");
  const [newCost, setNewCost] = useState("");

  // 載入持倉 (localStorage)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PORTFOLIO_HOLDINGS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setHoldings(arr);
      }
    } catch (e) {
      /* ignore */
    }
  }, []);

  // 持倉異動時自動存
  useEffect(() => {
    try {
      localStorage.setItem(PORTFOLIO_HOLDINGS_KEY, JSON.stringify(holdings));
    } catch (e) {}
  }, [holdings]);

  // ⭐️ 快捷鍵 P:外部派發 quant:open-portfolio → 展開 + 滾入視野
  useEffect(() => {
    function onOpenSignal() {
      setCollapsed(false);
      requestAnimationFrame(() => {
        const el = document.querySelector(".port-panel");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    window.addEventListener("quant:open-portfolio", onOpenSignal);
    return () =>
      window.removeEventListener("quant:open-portfolio", onOpenSignal);
  }, []);

  // 持倉或範圍變動時自動重算
  useEffect(() => {
    if (collapsed || holdings.length === 0) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const result = await computePortfolio(
          holdings,
          PORTFOLIO_RANGE_DAYS[range]
        );
        if (alive) {
          if (result) setAnalysis(result);
          else setError("無法計算組合(資料不足或抓取失敗)");
        }
      } catch (e) {
        if (alive) setError(`計算失敗: ${e.message}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [holdings, range, collapsed]);

  function addHolding() {
    const sym = newSymbol.trim();
    const sh = parseFloat(newShares);
    const co = parseFloat(newCost);
    if (!sym) {
      setError("請輸入股票代號");
      return;
    }
    if (!sh || sh <= 0) {
      setError("請輸入有效的股數");
      return;
    }
    if (!co || co <= 0) {
      setError("請輸入有效的成本價");
      return;
    }
    // 不重複加同一檔
    if (holdings.find((h) => h.symbol === sym)) {
      setError(`${sym} 已在組合中,請先刪除舊持倉`);
      return;
    }
    setError("");
    setHoldings([...holdings, { symbol: sym, shares: sh, cost: co }]);
    setNewSymbol("");
    setNewShares("");
    setNewCost("");
  }

  function removeHolding(symbol) {
    setHoldings(holdings.filter((h) => h.symbol !== symbol));
  }

  function clearAll() {
    if (window.confirm("確定要清空所有持倉嗎?")) {
      setHoldings([]);
      setAnalysis(null);
    }
  }

  const RANGE_OPTIONS = [
    { key: "1M", label: "1月" },
    { key: "3M", label: "3月" },
    { key: "1Y", label: "1年" },
    { key: "3Y", label: "3年" },
  ];

  return (
    <div className="port-panel">
      <div className="port-panel-head">
        <div className="port-panel-eyebrow">PORTFOLIO SIMULATOR</div>
        <div className="port-panel-titlebar">
          <h2 className="port-panel-title">投資組合模擬器</h2>
          <div className="port-panel-actions">
            {!collapsed && analysis && holdings.length > 0 && (
              <ExportButtons
                targetRef={exportRef}
                baseName="QUANTEDGE_投資組合"
                tag="PORTFOLIO"
                compact
              />
            )}
            <button
              className="port-panel-toggle"
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? "展開 ▼" : "收合 ▲"}
              {holdings.length > 0 && (
                <span className="port-count-badge">{holdings.length}</span>
              )}
            </button>
          </div>
        </div>
      </div>

      {!collapsed && (
        <div className="port-panel-body" ref={exportRef}>
          {/* 新增持倉 */}
          <div className="port-add-row">
            <input
              type="text"
              className="port-input port-input-sym"
              placeholder="股票代號 (如 2330)"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addHolding()}
            />
            <input
              type="number"
              className="port-input"
              placeholder="股數"
              value={newShares}
              onChange={(e) => setNewShares(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addHolding()}
              min="1"
            />
            <input
              type="number"
              className="port-input"
              placeholder="成本價"
              value={newCost}
              onChange={(e) => setNewCost(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addHolding()}
              step="0.01"
              min="0.01"
            />
            <button className="port-add-btn" onClick={addHolding}>
              + 加入
            </button>
          </div>

          {error && <div className="port-error">{error}</div>}

          {/* 持倉列表 */}
          {holdings.length === 0 ? (
            <div className="port-empty">
              <div className="port-empty-icon">📊</div>
              <div className="port-empty-title">尚未建立投資組合</div>
              <div className="port-empty-hint">
                輸入股票代號、股數、成本價後點「加入」開始
              </div>
            </div>
          ) : (
            <>
              {/* 範圍選擇 */}
              <div className="port-controls">
                <div className="port-range-tabs">
                  {RANGE_OPTIONS.map((r) => (
                    <button
                      key={r.key}
                      className={`port-range-tab ${
                        range === r.key ? "active" : ""
                      }`}
                      onClick={() => setRange(r.key)}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                <button className="port-clear-btn" onClick={clearAll}>
                  清空
                </button>
              </div>

              {/* 摘要卡 */}
              {analysis && analysis.summary && (
                <PortfolioSummary summary={analysis.summary} />
              )}

              {/* 持倉表 */}
              <PortfolioHoldingsTable
                holdings={holdings}
                positions={analysis?.positions || []}
                stockMap={stockMap}
                onRemove={removeHolding}
                onPick={onPickSymbol}
              />

              {loading && (
                <div className="port-loading">
                  <div className="port-spinner"></div>
                  <span>正在計算組合績效...</span>
                </div>
              )}

              {/* 圖表區 */}
              {!loading && analysis && (
                <div className="port-charts">
                  <PortfolioEquityChart curve={analysis.equityCurve} />
                  <div className="port-charts-row">
                    <PortfolioPieChart positions={analysis.positions} />
                    <PortfolioCorrHeatmap
                      matrix={analysis.corrMatrix}
                      symbols={analysis.corrSymbols}
                      stockMap={stockMap}
                    />
                  </div>
                  <PortfolioVsBenchmark curve={analysis.equityCurve} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── PortfolioPanel 子元件:摘要卡 ────────────────────── */
function PortfolioSummary({ summary }) {
  const pnlPos = summary.totalPnL >= 0;
  const alphaPos = summary.alpha >= 0;
  return (
    <div className="port-summary">
      <div className="port-sum-card">
        <div className="port-sum-label">總成本</div>
        <div className="port-sum-value">
          <AnimatedNumber value={summary.totalCost} decimals={0} prefix="$" />
        </div>
      </div>
      <div className="port-sum-card">
        <div className="port-sum-label">總市值</div>
        <div className="port-sum-value">
          <AnimatedNumber
            value={summary.totalMarketValue}
            decimals={0}
            prefix="$"
          />
        </div>
      </div>
      <div className="port-sum-card">
        <div className="port-sum-label">總損益</div>
        <div className={`port-sum-value ${pnlPos ? "up" : "down"}`}>
          {pnlPos ? "▲" : "▼"}{" "}
          <AnimatedNumber
            value={Math.abs(summary.totalPnL)}
            decimals={0}
            prefix="$"
          />
        </div>
        <div className={`port-sum-sub ${pnlPos ? "up" : "down"}`}>
          <AnimatedNumber
            value={summary.totalPnLPct}
            decimals={2}
            signed={true}
            suffix="%"
          />
        </div>
      </div>
      <div className="port-sum-card">
        <div className="port-sum-label">vs 0050 (Alpha)</div>
        <div className={`port-sum-value ${alphaPos ? "up" : "down"}`}>
          <AnimatedNumber
            value={summary.alpha}
            decimals={2}
            signed={true}
            suffix="%"
          />
        </div>
        <div className="port-sum-sub neutral">
          {summary.positionsCount} 檔 · {summary.dataDays} 日
        </div>
      </div>
    </div>
  );
}

/* ─── PortfolioPanel 子元件:持倉表 ────────────────────── */
function PortfolioHoldingsTable({
  holdings,
  positions,
  stockMap,
  onRemove,
  onPick,
}) {
  // 用 positions 為主(有市值資料),holdings 為輔(沒抓到時的 fallback)
  const rows = holdings.map((h) => {
    const p = positions.find((x) => x.symbol === h.symbol);
    return {
      symbol: h.symbol,
      shares: h.shares,
      cost: h.cost,
      currentPrice: p?.currentPrice || 0,
      marketValue: p?.marketValue || 0,
      pnl: p?.pnl || 0,
      pnlPct: p?.pnlPct || 0,
      weight: p?.weight || 0,
    };
  });
  return (
    <div className="port-table-wrap">
      <table className="port-table">
        <thead>
          <tr>
            <th>代號</th>
            <th>名稱</th>
            <th className="num">股數</th>
            <th className="num">成本</th>
            <th className="num">現價</th>
            <th className="num">市值</th>
            <th className="num">損益</th>
            <th className="num">權重</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pnlPos = r.pnl >= 0;
            return (
              <tr key={r.symbol}>
                <td>
                  <button
                    className="port-row-symbol"
                    onClick={() => onPick && onPick(r.symbol)}
                    title="點擊查詢"
                  >
                    {r.symbol}
                  </button>
                </td>
                <td className="port-row-name">{stockMap[r.symbol] || "—"}</td>
                <td className="num">{fmt(r.shares, 0)}</td>
                <td className="num">{fmt(r.cost, 2)}</td>
                <td className="num">
                  {r.currentPrice > 0 ? fmt(r.currentPrice, 2) : "—"}
                </td>
                <td className="num">
                  {r.marketValue > 0 ? `$${fmt(r.marketValue, 0)}` : "—"}
                </td>
                <td className={`num ${pnlPos ? "up" : "down"}`}>
                  {r.marketValue > 0 ? (
                    <>
                      {pnlPos ? "+" : ""}${fmt(r.pnl, 0)}
                      <div className="port-pnl-pct">
                        {pnlPos ? "+" : ""}
                        {fmt(r.pnlPct, 2)}%
                      </div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="num">
                  {r.weight > 0 ? `${fmt(r.weight, 1)}%` : "—"}
                </td>
                <td>
                  <button
                    className="port-remove-btn"
                    onClick={() => onRemove(r.symbol)}
                    title="刪除"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─── PortfolioPanel 子元件:組合淨值曲線 ────────────────────── */
function PortfolioEquityChart({ curve }) {
  if (!curve || curve.length < 2) return null;
  const W = 720,
    H = 240,
    P = 40;
  const xs = curve.map((_, i) => i);
  const ys = curve.map((p) => p.portfolioReturn);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const yRange = maxY - minY || 1;
  const xScale = (i) => P + (i / (curve.length - 1)) * (W - 2 * P);
  const yScale = (v) => H - P - ((v - minY) / yRange) * (H - 2 * P);
  const path = ys
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${xScale(i).toFixed(1)} ${yScale(v).toFixed(1)}`
    )
    .join(" ");
  const areaPath = `${path} L${xScale(curve.length - 1).toFixed(1)} ${(
    H - P
  ).toFixed(1)} L${xScale(0).toFixed(1)} ${(H - P).toFixed(1)} Z`;
  const finalRet = ys[ys.length - 1];
  const isPos = finalRet >= 0;
  const lineColor = isPos ? "#34d399" : "#f87171";
  const fillColor = isPos
    ? "rgba(52, 211, 153, 0.15)"
    : "rgba(248, 113, 113, 0.15)";
  // 零軸
  const zeroY = yScale(0);
  return (
    <div className="port-chart-box">
      <div className="port-chart-header">
        <span className="port-chart-title">組合淨值曲線</span>
        <span className={`port-chart-pill ${isPos ? "up" : "down"}`}>
          {isPos ? "+" : ""}
          {fmt(finalRet, 2)}%
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="port-chart-svg"
        preserveAspectRatio="none"
      >
        {/* 零軸 */}
        <line
          x1={P}
          y1={zeroY}
          x2={W - P}
          y2={zeroY}
          stroke="rgba(148, 163, 184, 0.3)"
          strokeDasharray="3 3"
        />
        {/* 填色面積 */}
        <path d={areaPath} fill={fillColor} />
        {/* 主曲線 */}
        <path d={path} fill="none" stroke={lineColor} strokeWidth="2" />
        {/* Y 軸標籤 */}
        <text x={4} y={P + 4} fontSize="10" fill="rgba(148, 163, 184, 0.7)">
          {maxY.toFixed(1)}%
        </text>
        <text x={4} y={H - P + 4} fontSize="10" fill="rgba(148, 163, 184, 0.7)">
          {minY.toFixed(1)}%
        </text>
        <text x={4} y={zeroY + 4} fontSize="10" fill="rgba(148, 163, 184, 0.5)">
          0%
        </text>
        {/* X 軸日期 */}
        <text x={P} y={H - 8} fontSize="9" fill="rgba(148, 163, 184, 0.7)">
          {curve[0].date}
        </text>
        <text
          x={W - P}
          y={H - 8}
          fontSize="9"
          fill="rgba(148, 163, 184, 0.7)"
          textAnchor="end"
        >
          {curve[curve.length - 1].date}
        </text>
      </svg>
    </div>
  );
}

/* ─── PortfolioPanel 子元件:個股權重圓餅 ────────────────────── */
function PortfolioPieChart({ positions }) {
  if (!positions || positions.length === 0) return null;
  const sorted = [...positions].sort((a, b) => b.weight - a.weight);
  const cx = 100,
    cy = 100,
    r = 80;
  const colors = [
    "#60a5fa",
    "#34d399",
    "#f87171",
    "#fbbf24",
    "#a78bfa",
    "#fb923c",
    "#22d3ee",
    "#f472b6",
    "#84cc16",
    "#fb7185",
  ];
  let cumAngle = -Math.PI / 2;
  const slices = sorted.map((p, idx) => {
    const sliceAngle = (p.weight / 100) * Math.PI * 2;
    const x1 = cx + r * Math.cos(cumAngle);
    const y1 = cy + r * Math.sin(cumAngle);
    const endAngle = cumAngle + sliceAngle;
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = sliceAngle > Math.PI ? 1 : 0;
    const d = `M${cx} ${cy} L${x1} ${y1} A${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    // 中點 (給標籤定位)
    const midAngle = cumAngle + sliceAngle / 2;
    const lx = cx + r * 0.65 * Math.cos(midAngle);
    const ly = cy + r * 0.65 * Math.sin(midAngle);
    cumAngle = endAngle;
    return {
      d,
      color: colors[idx % colors.length],
      symbol: p.symbol,
      weight: p.weight,
      lx,
      ly,
    };
  });
  return (
    <div className="port-chart-box port-pie-box">
      <div className="port-chart-header">
        <span className="port-chart-title">個股權重</span>
      </div>
      <div className="port-pie-wrap">
        <svg viewBox="0 0 200 200" className="port-pie-svg">
          {slices.map((s, i) => (
            <g key={i}>
              <path
                d={s.d}
                fill={s.color}
                stroke="rgba(15, 23, 42, 0.5)"
                strokeWidth="1"
              />
              {s.weight >= 5 && (
                <text
                  x={s.lx}
                  y={s.ly}
                  fontSize="10"
                  fill="white"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontWeight="600"
                >
                  {s.weight.toFixed(0)}%
                </text>
              )}
            </g>
          ))}
        </svg>
        <div className="port-pie-legend">
          {slices.map((s, i) => (
            <div key={i} className="port-pie-legend-item">
              <span
                className="port-pie-dot"
                style={{ background: s.color }}
              ></span>
              <span className="port-pie-sym">{s.symbol}</span>
              <span className="port-pie-pct">{s.weight.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── PortfolioPanel 子元件:相關性熱力圖 ────────────────────── */
function PortfolioCorrHeatmap({ matrix, symbols, stockMap }) {
  if (!matrix || !symbols || symbols.length < 2) {
    return (
      <div className="port-chart-box">
        <div className="port-chart-header">
          <span className="port-chart-title">相關性矩陣</span>
        </div>
        <div className="port-corr-empty">至少需 2 檔以上才能計算相關性</div>
      </div>
    );
  }
  // 把相關係數 -1~1 映射到顏色 (紅低相關 - 灰中性 - 綠高相關)
  function corrColor(c) {
    if (c >= 0.7) return "rgba(16, 185, 129, 0.7)";
    if (c >= 0.4) return "rgba(16, 185, 129, 0.4)";
    if (c >= 0.1) return "rgba(16, 185, 129, 0.2)";
    if (c <= -0.4) return "rgba(239, 68, 68, 0.5)";
    if (c <= -0.1) return "rgba(239, 68, 68, 0.25)";
    return "rgba(148, 163, 184, 0.15)";
  }
  return (
    <div className="port-chart-box">
      <div className="port-chart-header">
        <span className="port-chart-title">相關性矩陣 (Pearson)</span>
      </div>
      <div className="port-corr-wrap">
        <table className="port-corr-table">
          <thead>
            <tr>
              <th></th>
              {symbols.map((s) => (
                <th key={s} className="port-corr-th">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {symbols.map((s1, i) => (
              <tr key={s1}>
                <th className="port-corr-th">{s1}</th>
                {symbols.map((s2, j) => {
                  const c = matrix[i][j];
                  return (
                    <td
                      key={s2}
                      className="port-corr-cell"
                      style={{ background: corrColor(c) }}
                      title={`${s1} vs ${s2}: ${c.toFixed(3)}`}
                    >
                      {c.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="port-corr-legend">
          <span className="port-corr-legend-item">
            <span
              className="port-corr-swatch"
              style={{ background: "rgba(16, 185, 129, 0.7)" }}
            ></span>
            強正相關 (&ge;0.7)
          </span>
          <span className="port-corr-legend-item">
            <span
              className="port-corr-swatch"
              style={{ background: "rgba(148, 163, 184, 0.15)" }}
            ></span>
            低相關
          </span>
          <span className="port-corr-legend-item">
            <span
              className="port-corr-swatch"
              style={{ background: "rgba(239, 68, 68, 0.5)" }}
            ></span>
            負相關 (&le;-0.4)
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─── PortfolioPanel 子元件:vs 0050 對比圖 ────────────────────── */
function PortfolioVsBenchmark({ curve }) {
  if (!curve || curve.length < 2) return null;
  const W = 720,
    H = 220,
    P = 40;
  const portRets = curve.map((p) => p.portfolioReturn);
  const benchRets = curve.map((p) => p.benchmarkReturn);
  const allYs = [...portRets, ...benchRets];
  const minY = Math.min(0, ...allYs);
  const maxY = Math.max(0, ...allYs);
  const yRange = maxY - minY || 1;
  const xScale = (i) => P + (i / (curve.length - 1)) * (W - 2 * P);
  const yScale = (v) => H - P - ((v - minY) / yRange) * (H - 2 * P);
  const portPath = portRets
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${xScale(i).toFixed(1)} ${yScale(v).toFixed(1)}`
    )
    .join(" ");
  const benchPath = benchRets
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${xScale(i).toFixed(1)} ${yScale(v).toFixed(1)}`
    )
    .join(" ");
  const finalPort = portRets[portRets.length - 1];
  const finalBench = benchRets[benchRets.length - 1];
  const alpha = finalPort - finalBench;
  const alphaPos = alpha >= 0;
  const zeroY = yScale(0);
  return (
    <div className="port-chart-box">
      <div className="port-chart-header">
        <span className="port-chart-title">組合 vs 0050 績效對比</span>
        <span className={`port-chart-pill ${alphaPos ? "up" : "down"}`}>
          Alpha {alphaPos ? "+" : ""}
          {fmt(alpha, 2)}%
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="port-chart-svg"
        preserveAspectRatio="none"
      >
        <line
          x1={P}
          y1={zeroY}
          x2={W - P}
          y2={zeroY}
          stroke="rgba(148, 163, 184, 0.3)"
          strokeDasharray="3 3"
        />
        {/* benchmark (0050) - 紫色虛線 */}
        <path
          d={benchPath}
          fill="none"
          stroke="#a78bfa"
          strokeWidth="1.8"
          strokeDasharray="5 3"
        />
        {/* portfolio - 主色實線 */}
        <path d={portPath} fill="none" stroke="#60a5fa" strokeWidth="2.2" />
        <text x={4} y={P + 4} fontSize="10" fill="rgba(148, 163, 184, 0.7)">
          {maxY.toFixed(1)}%
        </text>
        <text x={4} y={H - P + 4} fontSize="10" fill="rgba(148, 163, 184, 0.7)">
          {minY.toFixed(1)}%
        </text>
      </svg>
      <div className="port-bench-legend">
        <span className="port-bench-legend-item">
          <span className="port-bench-line port-bench-port"></span>
          我的組合{" "}
          <strong className={alphaPos ? "up" : "down"}>
            {finalPort >= 0 ? "+" : ""}
            {fmt(finalPort, 2)}%
          </strong>
        </span>
        <span className="port-bench-legend-item">
          <span className="port-bench-line port-bench-bench"></span>
          0050 大盤{" "}
          <strong>
            {finalBench >= 0 ? "+" : ""}
            {fmt(finalBench, 2)}%
          </strong>
        </span>
      </div>
    </div>
  );
}

function BacktestPanel({ fullData, perValue }) {
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [range, setRange] = useState(750);
  const [hasRun, setHasRun] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const RANGES = [
    { label: "1 年", days: 250 },
    { label: "3 年", days: 750 },
    { label: "全部", days: 0 },
  ];

  // 換股時清空回測結果
  useEffect(() => {
    setResult(null);
    setHasRun(false);
  }, [fullData]);

  function run(days) {
    setRange(days);
    setRunning(true);
    setHasRun(true);
    // 讓「運算中」狀態先 render,再做同步運算
    setTimeout(() => {
      const r = runBacktest(fullData, perValue, days || null);
      setResult(r);
      setRunning(false);
    }, 40);
  }

  const beat = result && result.excessReturn >= 0;

  return (
    <div className="backtest-panel">
      <div className="backtest-header">
        <div className="backtest-title-group">
          <span className="backtest-eyebrow">STRATEGY BACKTEST</span>
          <h3 className="backtest-title">評級策略歷史回測</h3>
        </div>
        <div className="backtest-header-right">
          {hasRun && !running && (
            <div className="backtest-range-tabs">
              {RANGES.map((r) => (
                <button
                  key={r.label}
                  className={`bt-range-btn ${range === r.days ? "active" : ""}`}
                  onClick={() => run(r.days)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          <button
            className="panel-collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "展開" : "收合"}
          >
            <span className={`panel-chevron ${collapsed ? "" : "open"}`}>
              ›
            </span>
          </button>
        </div>
      </div>

      <div className={`panel-body ${collapsed ? "" : "open"}`}>
        <div className="panel-body-inner">
          <p className="backtest-method">
            將四因子評級套用到歷史上的每一個交易日,依評級動態調整部位 (STRONG
            BUY 滿倉 → SELL 空手),對照「買進持有」同一檔股票。 含 120
            日暖身、無前視偏誤。
          </p>

          {!hasRun && (
            <button className="backtest-run-btn" onClick={() => run(750)}>
              ▶ 執行歷史回測
            </button>
          )}

          {running && (
            <div className="backtest-loading">
              <span className="dot">●</span>
              <span className="dot">●</span>
              <span className="dot">●</span>
              回測引擎運算中 · 逐日重算四因子評級
            </div>
          )}

          {hasRun && !running && !result && (
            <div className="backtest-empty">
              歷史資料不足,無法回測(至少需約 160 個交易日)。
            </div>
          )}

          {result && !running && (
            <>
              <div className={`backtest-verdict ${beat ? "win" : "lose"}`}>
                <span className="verdict-icon">{beat ? "✦" : "△"}</span>
                <span>
                  在此區間,評級策略{" "}
                  <strong>
                    {beat ? "領先" : "落後"}買進持有{" "}
                    {fmt(Math.abs(result.excessReturn), 1)}
                    個百分點
                  </strong>
                  {beat
                    ? `,且最大回撤由 ${fmt(result.bhMDD, 1)}% 收斂至 ${fmt(
                        result.stratMDD,
                        1
                      )}%。`
                    : `,主動調整部位未能勝過單純持有。`}
                </span>
              </div>

              <div className="backtest-stats">
                <div className="bt-stat highlight">
                  <span className="bt-stat-label">評級策略總報酬</span>
                  <span
                    className={`bt-stat-value ${
                      result.stratRet >= 0 ? "up" : "down"
                    }`}
                  >
                    {result.stratRet >= 0 ? "+" : ""}
                    {fmt(result.stratRet, 1)}%
                  </span>
                  <span className="bt-stat-sub">
                    年化 {result.stratCAGR >= 0 ? "+" : ""}
                    {fmt(result.stratCAGR, 1)}%
                  </span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label">買進持有總報酬</span>
                  <span
                    className={`bt-stat-value ${
                      result.bhRet >= 0 ? "up" : "down"
                    }`}
                  >
                    {result.bhRet >= 0 ? "+" : ""}
                    {fmt(result.bhRet, 1)}%
                  </span>
                  <span className="bt-stat-sub">
                    年化 {result.bhCAGR >= 0 ? "+" : ""}
                    {fmt(result.bhCAGR, 1)}%
                  </span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label">超額報酬 (Alpha)</span>
                  <span className={`bt-stat-value ${beat ? "up" : "down"}`}>
                    {result.excessReturn >= 0 ? "+" : ""}
                    {fmt(result.excessReturn, 1)}%
                  </span>
                  <span className="bt-stat-sub">策略 − 持有</span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label">策略最大回撤</span>
                  <span className="bt-stat-value down">
                    {fmt(result.stratMDD, 1)}%
                  </span>
                  <span className="bt-stat-sub">
                    持有 {fmt(result.bhMDD, 1)}%
                  </span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label">交易勝率</span>
                  <span className="bt-stat-value">
                    {fmt(result.winRate, 0)}%
                  </span>
                  <span className="bt-stat-sub">
                    {result.tradeCount} 筆進出
                  </span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label">在場時間</span>
                  <span className="bt-stat-value">
                    {fmt(result.timeInMarket, 0)}%
                  </span>
                  <span className="bt-stat-sub">
                    {result.tradingDays} 交易日
                  </span>
                </div>
              </div>

              <EquityChart result={result} />

              <div className="backtest-disclaimer">
                ⚠
                回測績效以歷史資料模擬,未計入交易成本、滑價與稅費,不代表未來表現。
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── 互動圖表 (沿用) ───────────────────────────────────────── */
/* ─── ⭐️ 計算移動平均線 ⭐️ ─── */
function calcMA(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j].close;
    return sum / period;
  });
}

/* ─── ⭐️ 指數移動平均 (EMA) ⭐️ ─── */
function calcEMA(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  values.forEach((v, i) => {
    if (i === 0) {
      out.push(v);
    } else {
      prev = v * k + prev * (1 - k);
      out.push(prev);
    }
  });
  return out;
}

/* ─── ⭐️ MACD 指標 (標準參數 12 / 26 / 9) ⭐️
 * DIF  = EMA12 − EMA26      (快線)
 * DEA  = EMA9(DIF)          (慢線 / 訊號線)
 * HIST = (DIF − DEA) × 2    (柱狀體,放大 2 倍便於觀察)
 * ─────────────────────────────────────────────────────────── */
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (!closes || closes.length === 0) return { dif: [], dea: [], hist: [] };
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const dif = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const dea = calcEMA(dif, signal);
  const hist = dif.map((d, i) => (d - dea[i]) * 2);
  return { dif, dea, hist };
}

/* ─── ⭐️ 布林通道 (Bollinger Bands) ⭐️
 * 中軌: MA20  上軌: MA20 + 2σ  下軌: MA20 − 2σ
 * 回傳: { upper[], mid[], lower[] }，與 data 等長，不足時 null
 * ─────────────────────────────────────────────────────────── */
function calcBollinger(data, period = 20, mult = 2) {
  const n = data.length;
  const upper = new Array(n).fill(null);
  const mid = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const slice = data.slice(i - period + 1, i + 1).map((d) => d.close);
    const m = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - m) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    mid[i] = m;
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { upper, mid, lower };
}

/* ─── ⭐️ KD 隨機指標 (Stochastic Oscillator) ⭐️
 * 標準參數: RSV(9), K=SMA(RSV,3), D=SMA(K,3)
 * 回傳: { k[], d[], rsv[] }，與 data 等長
 * ─────────────────────────────────────────────────────────── */
function calcKD(data, rsvPeriod = 9, kSmooth = 3, dSmooth = 3) {
  const n = data.length;
  const rsv = new Array(n).fill(null);
  const k = new Array(n).fill(null);
  const d = new Array(n).fill(null);

  for (let i = rsvPeriod - 1; i < n; i++) {
    const slice = data.slice(i - rsvPeriod + 1, i + 1);
    const hh = Math.max(...slice.map((x) => x.high || x.close));
    const ll = Math.min(...slice.map((x) => x.low || x.close));
    rsv[i] = hh === ll ? 50 : ((data[i].close - ll) / (hh - ll)) * 100;
  }

  // K 值:RSV 的指數平滑(等效 SMA-3 用 1/3 平滑因子)
  let kPrev = 50;
  for (let i = 0; i < n; i++) {
    if (rsv[i] == null) continue;
    kPrev = (kPrev * (kSmooth - 1) + rsv[i]) / kSmooth;
    k[i] = kPrev;
  }

  // D 值:K 值的指數平滑
  let dPrev = 50;
  for (let i = 0; i < n; i++) {
    if (k[i] == null) continue;
    dPrev = (dPrev * (dSmooth - 1) + k[i]) / dSmooth;
    d[i] = dPrev;
  }

  return { k, d, rsv };
}

/* ─── ⭐️ K 線能量點偵測(粗標期間高低 + 細標重要轉折)⭐️ ───
 * 規則:
 *   - 粗標:期間絕對最高 / 最低(必有,最多 2 個)
 *   - 細標:左右各 5 根都嚴格高/低於它的轉折點,且當日量 ≥ 20 日均量 × 2.0
 *           最多 6 個,按量倍數降序;互相 < 3 天的密集細標只保留量大者
 *           與粗標 < 3 天的細標自動避讓
 *   - 同時是高/低點(巨大波動日):依當日漲跌方向決定主類型
 *   - 資料 < 11 天無法判定轉折,只回粗標
 * ───────────────────────────────────────────────────── */
function computeVolRatio(candles, idx) {
  const lookback = Math.min(20, idx);
  if (lookback === 0) return 1; // 第一天無歷史,給中性值
  let sum = 0;
  for (let i = idx - lookback; i < idx; i++) sum += candles[i].volume;
  const avg = sum / lookback;
  if (avg === 0) return 0;
  return candles[idx].volume / avg;
}
function detectEnergyPoints(candles, opts = {}) {
  const N = opts.N || 5;
  const VOL = opts.volThreshold || 2.0;
  const MAX_FINE = opts.maxFine || 6;
  const MIN_GAP = opts.minGap || 3;

  if (!Array.isArray(candles) || candles.length === 0) {
    return { bold: [], fine: [] };
  }

  // Step 1:期間絕對高低點
  let highIdx = 0,
    lowIdx = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].high > candles[highIdx].high) highIdx = i;
    if (candles[i].low < candles[lowIdx].low) lowIdx = i;
  }
  const bold = [];
  bold.push({
    idx: highIdx,
    date: candles[highIdx].date,
    price: candles[highIdx].high,
    type: "high",
    tier: "bold",
    volRatio: computeVolRatio(candles, highIdx),
  });
  if (lowIdx !== highIdx) {
    bold.push({
      idx: lowIdx,
      date: candles[lowIdx].date,
      price: candles[lowIdx].low,
      type: "low",
      tier: "bold",
      volRatio: computeVolRatio(candles, lowIdx),
    });
  }

  // Step 2:局部轉折候選
  let candidates = [];
  if (candles.length >= 2 * N + 1) {
    for (let j = N; j <= candles.length - 1 - N; j++) {
      const ch = candles[j].high;
      const cl = candles[j].low;
      let isHigh = true,
        isLow = true;
      for (let k = 1; k <= N; k++) {
        if (candles[j - k].high >= ch) isHigh = false;
        if (candles[j + k].high >= ch) isHigh = false;
        if (candles[j - k].low <= cl) isLow = false;
        if (candles[j + k].low <= cl) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh || isLow) {
        const vr = computeVolRatio(candles, j);
        if (vr >= VOL) {
          let pickHigh = isHigh;
          if (isHigh && isLow) {
            pickHigh = candles[j].close >= candles[j].open;
          }
          candidates.push({
            idx: j,
            date: candles[j].date,
            price: pickHigh ? ch : cl,
            type: pickHigh ? "high" : "low",
            tier: "fine",
            volRatio: vr,
          });
        }
      }
    }
  }

  // Step 3:去除與 bold 重複的 idx
  const boldIdxSet = {};
  bold.forEach((b) => {
    boldIdxSet[b.idx] = true;
  });
  candidates = candidates.filter((c) => !boldIdxSet[c.idx]);

  // Step 4:細標離粗標 < MIN_GAP 自動避讓
  candidates = candidates.filter((c) => {
    for (let x = 0; x < bold.length; x++) {
      if (Math.abs(c.idx - bold[x].idx) < MIN_GAP) return false;
    }
    return true;
  });

  // Step 5:按 volRatio 降序排
  candidates.sort((a, b) => b.volRatio - a.volRatio);

  // Step 6:細標彼此避讓(從量大到量小逐一加入)
  const accepted = [];
  for (let f = 0; f < candidates.length && accepted.length < MAX_FINE; f++) {
    let ok = true;
    for (let a = 0; a < accepted.length; a++) {
      if (Math.abs(candidates[f].idx - accepted[a].idx) < MIN_GAP) {
        ok = false;
        break;
      }
    }
    if (ok) accepted.push(candidates[f]);
  }

  return { bold, fine: accepted };
}

/* ─── ⭐️ K 棒蠟燭圖 + MA 均線 ⭐️ ─── */
function InteractiveChart({ fullData, rangeDays }) {
  const containerRef = useRef(null);
  const macdRef = useRef(null);
  const kdRef = useRef(null);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [showMA, setShowMA] = useState({ ma5: true, ma20: true, ma60: true });
  const [showBB, setShowBB] = useState(true);
  const [showMACD, setShowMACD] = useState(true);
  const [showKD, setShowKD] = useState(true);
  // K 線能量點:長期模式(>=250 天)預設開、短期可選關;狀態存 localStorage
  const [showEP, setShowEP] = useState(() => {
    try {
      const v = localStorage.getItem(SK.ENERGY_POINTS);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch (e) {}
    return rangeDays >= 250;
  });
  const [epHoverIdx, setEpHoverIdx] = useState(null);
  useEffect(() => {
    try {
      localStorage.setItem(SK.ENERGY_POINTS, showEP ? "1" : "0");
    } catch (e) {}
  }, [showEP]);

  if (!fullData || fullData.length === 0)
    return <div className="no-data">資料載入中...</div>;

  let rawData = fullData.slice(-rangeDays);
  if (rawData.length === 0) rawData = fullData;
  let data = [];
  let chartType = "日線";
  if (rangeDays >= 750) {
    chartType = "週線";
    for (let i = 0; i < rawData.length; i += 5) {
      const chunk = rawData.slice(i, i + 5);
      const first = chunk[0];
      const lastDay = chunk[chunk.length - 1];
      const avgVol = chunk.reduce((s, d) => s + d.volume, 0) / chunk.length;
      data.push({
        date: lastDay.date,
        open: first.open || first.close,
        close: lastDay.close,
        high: Math.max(...chunk.map((d) => d.high || d.close)),
        low: Math.min(...chunk.map((d) => d.low || d.close)),
        volume: Math.round(avgVol),
      });
    }
  } else {
    data = rawData;
  }

  useEffect(() => {
    setHoverIdx(null);
  }, [data.length, rangeDays]);
  if (!data || data.length < 2) return <div className="no-data">資料不足</div>;

  // 計算三條均線
  const ma5 = calcMA(data, 5);
  const ma20 = calcMA(data, 20);
  const ma60 = calcMA(data, 60);

  // 計算 MACD (12,26,9) — 日線模式用 fullData 暖身後對齊,週線直接算
  let macd;
  if (chartType === "週線") {
    macd = calcMACD(data.map((d) => d.close));
  } else {
    const full = calcMACD(fullData.map((d) => d.close));
    macd = {
      dif: full.dif.slice(-data.length),
      dea: full.dea.slice(-data.length),
      hist: full.hist.slice(-data.length),
    };
  }
  const { dif, dea, hist } = macd;

  // 計算布林通道 (Bollinger Bands, 20, ±2σ)
  const bb = calcBollinger(data, 20, 2);
  const { upper: bbUpper, mid: bbMid, lower: bbLower } = bb;

  // 計算 KD 隨機指標 (9,3,3) — 日線用 fullData 暖身後對齊
  let kdResult;
  if (chartType === "週線") {
    kdResult = calcKD(data);
  } else {
    const fullKD = calcKD(fullData);
    kdResult = {
      k: fullKD.k.slice(-data.length),
      d: fullKD.d.slice(-data.length),
      rsv: fullKD.rsv.slice(-data.length),
    };
  }
  const { k: kdK, d: kdD } = kdResult;

  const W = 400,
    H = 150;
  const padTop = 12,
    padBottom = 38;
  const graphH = H - padTop - padBottom;

  // 價格範圍:涵蓋高低點 + 均線 + 布林通道
  const allHighs = data.map((d) => d.high || d.close);
  const allLows = data.map((d) => d.low || d.close);
  const maValues = [...ma5, ...ma20, ...ma60].filter((v) => v != null);
  const bbValues = [...bbUpper, ...bbLower].filter((v) => v != null);
  const minC = Math.min(...allLows, ...maValues, ...bbValues);
  const maxC = Math.max(...allHighs, ...maValues, ...bbValues);
  const rngC = maxC - minC || 1;
  const vols = data.map((d) => d.volume);
  const maxV = Math.max(...vols) || 1;

  const yOf = (price) => padTop + graphH - ((price - minC) / rngC) * graphH;
  const xOf = (i) => (i / (data.length - 1)) * W;

  // K 棒寬度
  const candleW = Math.max((W / data.length) * 0.62, 0.8);

  // ─── ⭐️ K 線能量點偵測 ⭐️ ───
  // 用 useMemo 避免每次 hover 都重算(計算頗有開銷)
  const energyPoints = useMemo(
    () => (showEP ? detectEnergyPoints(data) : { bold: [], fine: [] }),
    [data, showEP]
  );

  // 均線路徑
  const maPath = (maArr) => {
    let path = "";
    let started = false;
    maArr.forEach((v, i) => {
      if (v == null) return;
      const cmd = started ? "L" : "M";
      path += `${cmd}${xOf(i).toFixed(2)},${yOf(v).toFixed(2)} `;
      started = true;
    });
    return path.trim();
  };

  // ─── MACD 副圖幾何 ───
  const H_MACD = 92;
  const macdPadT = 14,
    macdPadB = 8;
  const macdGraphH = H_MACD - macdPadT - macdPadB;
  const macdVals = [...dif, ...dea, ...hist].filter(
    (v) => v != null && isFinite(v)
  );
  let mMax = Math.max(...macdVals, 0);
  let mMin = Math.min(...macdVals, 0);
  if (mMax === mMin) {
    mMax += 1;
    mMin -= 1;
  }
  const mPad = (mMax - mMin) * 0.12;
  mMax += mPad;
  mMin -= mPad;
  const mRange = mMax - mMin || 1;
  const yM = (v) => macdPadT + macdGraphH - ((v - mMin) / mRange) * macdGraphH;
  const macdZeroY = yM(0);
  const macdHistW = Math.max((W / data.length) * 0.62, 0.8);
  const macdLinePath = (arr) =>
    arr
      .map(
        (v, i) =>
          `${i === 0 ? "M" : "L"}${xOf(i).toFixed(2)},${yM(v).toFixed(2)}`
      )
      .join(" ");
  // 柱狀體配色:正紅負綠;放大中=飽和、縮小中=淡色 (台股慣例)
  const histStyle = (i) => {
    const v = hist[i];
    const prev = i > 0 ? hist[i - 1] : v;
    const up = v >= 0;
    const growing = up ? v >= prev : v <= prev;
    return {
      fill: up ? "var(--up)" : "var(--down)",
      opacity: growing ? 0.92 : 0.4,
    };
  };

  const handleMove = (e) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left;
    let idx = Math.round((x / rect.width) * (data.length - 1));
    idx = Math.max(0, Math.min(idx, data.length - 1));
    setHoverIdx(idx);
  };
  const handleLeave = () => setHoverIdx(null);

  const handleMoveMACD = (e) => {
    if (!macdRef.current) return;
    const rect = macdRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left;
    let idx = Math.round((x / rect.width) * (data.length - 1));
    idx = Math.max(0, Math.min(idx, data.length - 1));
    setHoverIdx(idx);
  };

  const handleMoveKD = (e) => {
    if (!kdRef.current) return;
    const rect = kdRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left;
    let idx = Math.round((x / rect.width) * (data.length - 1));
    idx = Math.max(0, Math.min(idx, data.length - 1));
    setHoverIdx(idx);
  };

  // ─── KD 副圖幾何 ───
  const H_KD = 92;
  const kdPadT = 14,
    kdPadB = 8;
  const kdGraphH = H_KD - kdPadT - kdPadB;
  const yK = (v) => kdPadT + kdGraphH - ((v - 0) / 100) * kdGraphH;
  const kdLinePath = (arr) =>
    arr
      .map((v, i) =>
        v == null
          ? null
          : `${i === 0 || arr[i - 1] == null ? "M" : "L"}${xOf(i).toFixed(
              2
            )},${yK(v).toFixed(2)}`
      )
      .filter(Boolean)
      .join(" ");

  let hoverX = 0,
    tooltipSide = "left";
  if (hoverIdx !== null) {
    hoverX = (hoverIdx / (data.length - 1)) * 100;
    if (hoverX > 55) tooltipSide = "right";
  }

  const hoverData = hoverIdx !== null ? data[hoverIdx] : null;
  const hoverChg = hoverData
    ? hoverData.close - (hoverData.open || hoverData.close)
    : 0;

  return (
    <>
      <div className="chart-header-row">
        <span className="chart-mode-badge">{chartType} · K 線</span>
        <span className="chart-date-range">
          {data[0].date} ~ {data[data.length - 1].date}
        </span>
      </div>

      {/* MA 圖例 — 可點擊開關 */}
      <div className="ma-legend">
        <button
          className={`ma-legend-item ma5 ${showMA.ma5 ? "active" : ""}`}
          onClick={() => setShowMA((s) => ({ ...s, ma5: !s.ma5 }))}
        >
          <span className="ma-dot"></span>MA5
          {hoverIdx !== null && ma5[hoverIdx] != null && (
            <span className="ma-val">{fmt(ma5[hoverIdx])}</span>
          )}
        </button>
        <button
          className={`ma-legend-item ma20 ${showMA.ma20 ? "active" : ""}`}
          onClick={() => setShowMA((s) => ({ ...s, ma20: !s.ma20 }))}
        >
          <span className="ma-dot"></span>MA20
          {hoverIdx !== null && ma20[hoverIdx] != null && (
            <span className="ma-val">{fmt(ma20[hoverIdx])}</span>
          )}
        </button>
        <button
          className={`ma-legend-item ma60 ${showMA.ma60 ? "active" : ""}`}
          onClick={() => setShowMA((s) => ({ ...s, ma60: !s.ma60 }))}
        >
          <span className="ma-dot"></span>MA60
          {hoverIdx !== null && ma60[hoverIdx] != null && (
            <span className="ma-val">{fmt(ma60[hoverIdx])}</span>
          )}
        </button>
        {/* 布林通道開關 */}
        <button
          className={`ma-legend-item bb ${showBB ? "active" : ""}`}
          onClick={() => setShowBB((s) => !s)}
        >
          <span className="ma-dot bb-dot"></span>BOLL
          {hoverIdx !== null && bbUpper[hoverIdx] != null && showBB && (
            <span className="ma-val bb-val">
              {fmt(bbUpper[hoverIdx])} / {fmt(bbLower[hoverIdx])}
            </span>
          )}
        </button>
        {/* 能量點開關 — 標出期間高低與重要爆量轉折 */}
        <button
          className={`ma-legend-item ep ${showEP ? "active" : ""}`}
          onClick={() => setShowEP((s) => !s)}
          title="能量點:標示期間高低與重要爆量轉折(量≥20日均量2x)"
        >
          <span className="ma-dot ep-dot"></span>能量點
          {showEP && (
            <span className="ma-val ep-count">
              {energyPoints.bold.length + energyPoints.fine.length}
            </span>
          )}
        </button>
      </div>

      <div
        className="interactive-chart-container"
        ref={containerRef}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onTouchMove={handleMove}
        onTouchStart={handleMove}
        onTouchEnd={handleLeave}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="candle-svg"
        >
          {/* 成交量 bar(底部) */}
          {data.map((d, i) => {
            const vH = (d.volume / maxV) * 26;
            const isUp = d.close >= (d.open || d.close);
            return (
              <rect
                key={`v${i}`}
                x={xOf(i) - candleW / 2}
                y={H - vH}
                width={candleW}
                height={vH}
                fill={isUp ? "var(--up)" : "var(--down)"}
                opacity={hoverIdx === i ? "0.55" : "0.22"}
              />
            );
          })}

          {/* K 棒 */}
          {data.map((d, i) => {
            const o = d.open || d.close;
            const c = d.close;
            const h = d.high || Math.max(o, c);
            const l = d.low || Math.min(o, c);
            const isUp = c >= o;
            const color = isUp ? "var(--up)" : "var(--down)";
            const x = xOf(i);
            const bodyTop = yOf(Math.max(o, c));
            const bodyBot = yOf(Math.min(o, c));
            const bodyH = Math.max(bodyBot - bodyTop, 0.6);
            return (
              <g
                key={`k${i}`}
                opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.45}
              >
                {/* 影線 */}
                <line
                  x1={x}
                  y1={yOf(h)}
                  x2={x}
                  y2={yOf(l)}
                  stroke={color}
                  strokeWidth="0.8"
                />
                {/* 實體 */}
                <rect
                  x={x - candleW / 2}
                  y={bodyTop}
                  width={candleW}
                  height={bodyH}
                  fill={color}
                />
              </g>
            );
          })}

          {/* MA 均線 */}
          {showMA.ma5 && (
            <path
              d={maPath(ma5)}
              fill="none"
              stroke="var(--ma5)"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          )}
          {showMA.ma20 && (
            <path
              d={maPath(ma20)}
              fill="none"
              stroke="var(--ma20)"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          )}
          {showMA.ma60 && (
            <path
              d={maPath(ma60)}
              fill="none"
              stroke="var(--ma60)"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          )}

          {/* ─── 布林通道 (Bollinger Bands) ─── */}
          {showBB &&
            (() => {
              // 建立上軌路徑、下軌路徑，用來 fill 中間區域
              let upperPts = "",
                lowerPts = "",
                hasStart = false;
              const lowerReverse = [];
              bbUpper.forEach((v, i) => {
                if (v == null) return;
                const x = xOf(i).toFixed(2),
                  yu = yOf(v).toFixed(2),
                  yl = yOf(bbLower[i]).toFixed(2);
                if (!hasStart) {
                  upperPts += `M${x},${yu}`;
                  hasStart = true;
                } else upperPts += ` L${x},${yu}`;
                lowerReverse.unshift(`${x},${yl}`);
              });
              const fillPath =
                upperPts +
                (lowerReverse.length ? ` L${lowerReverse.join(" L")} Z` : "");
              return (
                <>
                  {/* 填充帶 */}
                  <path
                    d={fillPath}
                    fill="rgba(139,92,246,0.06)"
                    stroke="none"
                  />
                  {/* 上軌 */}
                  <path
                    d={maPath(bbUpper)}
                    fill="none"
                    stroke="rgba(139,92,246,0.55)"
                    strokeWidth="0.9"
                    strokeDasharray="3 2"
                    strokeLinejoin="round"
                  />
                  {/* 中軌 (MA20) */}
                  <path
                    d={maPath(bbMid)}
                    fill="none"
                    stroke="rgba(139,92,246,0.35)"
                    strokeWidth="0.8"
                    strokeLinejoin="round"
                  />
                  {/* 下軌 */}
                  <path
                    d={maPath(bbLower)}
                    fill="none"
                    stroke="rgba(139,92,246,0.55)"
                    strokeWidth="0.9"
                    strokeDasharray="3 2"
                    strokeLinejoin="round"
                  />
                </>
              );
            })()}

          {/* ─── ⭐️ 能量點 overlay(粗標期間高低 + 細標重要轉折)⭐️ ─── */}
          {showEP &&
            (() => {
              const allEps = [...energyPoints.bold, ...energyPoints.fine];
              return (
                <g className="ep-layer">
                  {allEps.map((ep, k) => {
                    const x = xOf(ep.idx);
                    const y = yOf(ep.price);
                    const isHigh = ep.type === "high";
                    const isBold = ep.tier === "bold";
                    const r = isBold ? 4 : 2.6;
                    const strokeW = isBold ? 1.6 : 1;
                    // 高點:標籤放上方;低點:標籤放下方
                    const labelDy = isHigh ? -8 : 14;
                    const volDy = isHigh ? -20 : 26;
                    const showVolLabel = ep.volRatio >= 2.0; // 規格:量倍≥2.0 才顯示
                    const isHovered = epHoverIdx === ep.idx;
                    // 進場 delay:粗標先(0.3s)、細標每點 +60ms
                    const animDelay = isBold
                      ? 0.3
                      : 0.55 + (k - energyPoints.bold.length) * 0.06;
                    return (
                      <g
                        key={`ep-${ep.tier}-${ep.idx}`}
                        className={`ep-mark ${
                          isBold ? "ep-bold" : "ep-fine"
                        } ep-${ep.type}`}
                        style={{ animationDelay: `${animDelay}s` }}
                        onMouseEnter={() => setEpHoverIdx(ep.idx)}
                        onMouseLeave={() => setEpHoverIdx(null)}
                      >
                        {/* 描邊光暈(讓點脫穎於 K 棒)*/}
                        <circle
                          cx={x}
                          cy={y}
                          r={r + 1.2}
                          fill="none"
                          stroke="#fff"
                          strokeWidth={strokeW + 0.6}
                          opacity={0.85}
                          className="ep-halo"
                        />
                        {/* 主點 */}
                        <circle
                          cx={x}
                          cy={y}
                          r={r}
                          fill={isHigh ? "var(--up)" : "var(--down)"}
                          stroke="#fff"
                          strokeWidth={strokeW}
                          className="ep-dot-circle"
                        />
                        {/* 價格標籤 */}
                        <text
                          x={x}
                          y={y + labelDy}
                          textAnchor="middle"
                          className={`ep-label ${
                            isBold ? "ep-label-bold" : ""
                          }`}
                        >
                          {fmt(ep.price)}
                        </text>
                        {/* 量倍標籤(僅 ≥2.0x 顯示)*/}
                        {showVolLabel && (
                          <text
                            x={x}
                            y={y + volDy}
                            textAnchor="middle"
                            className="ep-vol-label"
                          >
                            {ep.volRatio.toFixed(1)}x
                          </text>
                        )}
                        {/* hover 偵測圈(放大命中區域)*/}
                        <circle
                          cx={x}
                          cy={y}
                          r={10}
                          fill="transparent"
                          style={{ cursor: "pointer" }}
                        />
                      </g>
                    );
                  })}
                </g>
              );
            })()}

          {/* hover 標記點 */}
          {hoverIdx !== null && (
            <circle
              cx={xOf(hoverIdx)}
              cy={yOf(data[hoverIdx].close)}
              r="2.6"
              fill="var(--accent)"
              stroke="#fff"
              strokeWidth="1.2"
            />
          )}
        </svg>

        {hoverIdx !== null && hoverData && (
          <>
            <div
              className="crosshair-vline"
              style={{ left: `${hoverX}%` }}
            ></div>
            <div
              className={`chart-tooltip ${tooltipSide}`}
              style={{
                left:
                  tooltipSide === "left"
                    ? `calc(${hoverX}% + 12px)`
                    : `calc(${hoverX}% - 142px)`,
              }}
            >
              <div className="tt-date">{hoverData.date}</div>
              <div className="tt-row">
                <span>開</span>
                <b>{fmt(hoverData.open || hoverData.close)}</b>
              </div>
              <div className="tt-row">
                <span>高</span>
                <b className="up">{fmt(hoverData.high || hoverData.close)}</b>
              </div>
              <div className="tt-row">
                <span>低</span>
                <b className="down">{fmt(hoverData.low || hoverData.close)}</b>
              </div>
              <div className="tt-row">
                <span>收</span>
                <b className={hoverChg >= 0 ? "up" : "down"}>
                  {fmt(hoverData.close)}
                </b>
              </div>
              <div className="tt-row tt-vol-row">
                <span>量</span>
                <b>{fmt(hoverData.volume, 0)} 張</b>
              </div>
              {showBB && bbUpper[hoverIdx] != null && (
                <>
                  <div className="tt-row tt-bb-row">
                    <span>上軌</span>
                    <b className="bb-u">{fmt(bbUpper[hoverIdx])}</b>
                  </div>
                  <div className="tt-row">
                    <span>下軌</span>
                    <b className="bb-l">{fmt(bbLower[hoverIdx])}</b>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* ─── 能量點 hover tooltip ─── */}
        {epHoverIdx !== null &&
          data[epHoverIdx] &&
          (() => {
            const d = data[epHoverIdx];
            const epInfo = [...energyPoints.bold, ...energyPoints.fine].find(
              (e) => e.idx === epHoverIdx
            );
            if (!epInfo) return null;
            const o = d.open || d.close;
            const chg = ((d.close - o) / o) * 100;
            const epX = (
              (epHoverIdx / Math.max(data.length - 1, 1)) *
              100
            ).toFixed(2);
            const epSide = epHoverIdx > data.length / 2 ? "left" : "right";
            const isHigh = epInfo.type === "high";
            return (
              <div
                className={`ep-tooltip ${epSide}`}
                style={{
                  left:
                    epSide === "left"
                      ? `calc(${epX}% - 154px)`
                      : `calc(${epX}% + 12px)`,
                }}
              >
                <div className="ep-tt-head">
                  <span className={`ep-tt-badge ${isHigh ? "high" : "low"}`}>
                    {epInfo.tier === "bold"
                      ? isHigh
                        ? "期間最高"
                        : "期間最低"
                      : isHigh
                      ? "重要轉折高"
                      : "重要轉折低"}
                  </span>
                </div>
                <div className="ep-tt-date">{d.date}</div>
                <div className="ep-tt-row">
                  <span>價位</span>
                  <b className={isHigh ? "up" : "down"}>{fmt(epInfo.price)}</b>
                </div>
                <div className="ep-tt-row">
                  <span>量倍</span>
                  <b className={epInfo.volRatio >= 2.0 ? "ep-vol-hot" : ""}>
                    {epInfo.volRatio.toFixed(2)}x
                  </b>
                </div>
                <div className="ep-tt-row">
                  <span>當日</span>
                  <b className={chg >= 0 ? "up" : "down"}>
                    {chg >= 0 ? "+" : ""}
                    {chg.toFixed(2)}%
                  </b>
                </div>
              </div>
            );
          })()}
      </div>

      {/* ─── ⭐️ MACD 副圖 ⭐️ ─── */}
      <div className="macd-section">
        <div className="macd-legend">
          <button
            className={`macd-toggle ${showMACD ? "active" : ""}`}
            onClick={() => setShowMACD((s) => !s)}
          >
            <span className="macd-chevron">{showMACD ? "▾" : "▸"}</span>
            MACD <span className="macd-params">(12,26,9)</span>
          </button>
          {showMACD && (
            <div className="macd-vals">
              <span className="macd-leg-item dif">
                <span className="macd-dot"></span>DIF
                {hoverIdx !== null && dif[hoverIdx] != null && (
                  <span className="macd-v">{fmt(dif[hoverIdx], 2)}</span>
                )}
              </span>
              <span className="macd-leg-item dea">
                <span className="macd-dot"></span>DEA
                {hoverIdx !== null && dea[hoverIdx] != null && (
                  <span className="macd-v">{fmt(dea[hoverIdx], 2)}</span>
                )}
              </span>
              <span className="macd-leg-item hist">
                <span className="macd-dot"></span>MACD
                {hoverIdx !== null && hist[hoverIdx] != null && (
                  <span
                    className={`macd-v ${hist[hoverIdx] >= 0 ? "up" : "down"}`}
                  >
                    {fmt(hist[hoverIdx], 2)}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>

        {showMACD && (
          <div
            className="macd-chart-container"
            ref={macdRef}
            onMouseMove={handleMoveMACD}
            onMouseLeave={handleLeave}
            onTouchMove={handleMoveMACD}
            onTouchStart={handleMoveMACD}
            onTouchEnd={handleLeave}
          >
            <svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${W} ${H_MACD}`}
              preserveAspectRatio="none"
              className="macd-svg"
            >
              {/* 零軸 */}
              <line
                x1="0"
                y1={macdZeroY}
                x2={W}
                y2={macdZeroY}
                stroke="var(--border-strong)"
                strokeWidth="0.6"
                strokeDasharray="2 2"
              />
              {/* 柱狀體 */}
              {hist.map((v, i) => {
                const st = histStyle(i);
                const y1 = yM(v);
                const top = Math.min(macdZeroY, y1);
                const barH = Math.max(Math.abs(y1 - macdZeroY), 0.4);
                return (
                  <rect
                    key={`mh${i}`}
                    x={xOf(i) - macdHistW / 2}
                    y={top}
                    width={macdHistW}
                    height={barH}
                    fill={st.fill}
                    opacity={
                      hoverIdx === null || hoverIdx === i
                        ? st.opacity
                        : st.opacity * 0.5
                    }
                  />
                );
              })}
              {/* DIF / DEA 線 */}
              <path
                d={macdLinePath(dif)}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <path
                d={macdLinePath(dea)}
                fill="none"
                stroke="var(--ma5)"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              {/* hover 垂直線 + 點 */}
              {hoverIdx !== null && (
                <>
                  <line
                    x1={xOf(hoverIdx)}
                    y1="0"
                    x2={xOf(hoverIdx)}
                    y2={H_MACD}
                    stroke="var(--accent)"
                    strokeWidth="0.6"
                    strokeDasharray="2 2"
                    opacity="0.5"
                  />
                  {dif[hoverIdx] != null && (
                    <circle
                      cx={xOf(hoverIdx)}
                      cy={yM(dif[hoverIdx])}
                      r="2"
                      fill="var(--accent)"
                    />
                  )}
                  {dea[hoverIdx] != null && (
                    <circle
                      cx={xOf(hoverIdx)}
                      cy={yM(dea[hoverIdx])}
                      r="2"
                      fill="var(--ma5)"
                    />
                  )}
                </>
              )}
            </svg>
          </div>
        )}
      </div>

      {/* ─── ⭐️ KD 隨機指標副圖 ⭐️ ─── */}
      <div className="kd-section">
        <div className="kd-legend">
          <button
            className={`macd-toggle ${showKD ? "active" : ""}`}
            onClick={() => setShowKD((s) => !s)}
          >
            <span className="macd-chevron">{showKD ? "▾" : "▸"}</span>
            KD <span className="macd-params">(9,3,3)</span>
          </button>
          {showKD && (
            <div className="macd-vals">
              <span className="macd-leg-item kd-k">
                <span className="macd-dot"></span>K
                {hoverIdx !== null && kdK[hoverIdx] != null && (
                  <span className="macd-v">{fmt(kdK[hoverIdx], 1)}</span>
                )}
              </span>
              <span className="macd-leg-item kd-d">
                <span className="macd-dot"></span>D
                {hoverIdx !== null && kdD[hoverIdx] != null && (
                  <span className="macd-v">{fmt(kdD[hoverIdx], 1)}</span>
                )}
              </span>
              {/* 超買超賣提示 */}
              {hoverIdx !== null && kdK[hoverIdx] != null && (
                <span
                  className={`kd-zone-badge ${
                    kdK[hoverIdx] >= 80
                      ? "overbought"
                      : kdK[hoverIdx] <= 20
                      ? "oversold"
                      : ""
                  }`}
                >
                  {kdK[hoverIdx] >= 80
                    ? "超買"
                    : kdK[hoverIdx] <= 20
                    ? "超賣"
                    : "中性"}
                </span>
              )}
            </div>
          )}
        </div>

        {showKD && (
          <div
            className="macd-chart-container kd-chart-container"
            ref={kdRef}
            onMouseMove={handleMoveKD}
            onMouseLeave={handleLeave}
            onTouchMove={handleMoveKD}
            onTouchStart={handleMoveKD}
            onTouchEnd={handleLeave}
          >
            <svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${W} ${H_KD}`}
              preserveAspectRatio="none"
              className="macd-svg"
            >
              {/* 超買線 80 / 超賣線 20 */}
              <line
                x1="0"
                y1={yK(80)}
                x2={W}
                y2={yK(80)}
                stroke="rgba(244,63,94,0.3)"
                strokeWidth="0.7"
                strokeDasharray="3 2"
              />
              <line
                x1="0"
                y1={yK(50)}
                x2={W}
                y2={yK(50)}
                stroke="var(--border-strong)"
                strokeWidth="0.5"
                strokeDasharray="2 2"
              />
              <line
                x1="0"
                y1={yK(20)}
                x2={W}
                y2={yK(20)}
                stroke="rgba(16,185,129,0.3)"
                strokeWidth="0.7"
                strokeDasharray="3 2"
              />

              {/* 超買 / 超賣區著色 */}
              <rect
                x="0"
                y={kdPadT}
                width={W}
                height={yK(80) - kdPadT}
                fill="rgba(244,63,94,0.04)"
              />
              <rect
                x="0"
                y={yK(20)}
                width={W}
                height={H_KD - kdPadB - yK(20)}
                fill="rgba(16,185,129,0.04)"
              />

              {/* K 線 */}
              <path
                d={kdLinePath(kdK)}
                fill="none"
                stroke="var(--up)"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              {/* D 線 */}
              <path
                d={kdLinePath(kdD)}
                fill="none"
                stroke="var(--ma5)"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />

              {/* hover 垂直線 + 端點圓 */}
              {hoverIdx !== null && (
                <>
                  <line
                    x1={xOf(hoverIdx)}
                    y1="0"
                    x2={xOf(hoverIdx)}
                    y2={H_KD}
                    stroke="var(--accent)"
                    strokeWidth="0.6"
                    strokeDasharray="2 2"
                    opacity="0.5"
                  />
                  {kdK[hoverIdx] != null && (
                    <circle
                      cx={xOf(hoverIdx)}
                      cy={yK(kdK[hoverIdx])}
                      r="2"
                      fill="var(--up)"
                    />
                  )}
                  {kdD[hoverIdx] != null && (
                    <circle
                      cx={xOf(hoverIdx)}
                      cy={yK(kdD[hoverIdx])}
                      r="2"
                      fill="var(--ma5)"
                    />
                  )}
                </>
              )}

              {/* Y 軸標籤 */}
              {[20, 50, 80].map((v) => (
                <text
                  key={v}
                  x={W - 1}
                  y={yK(v) - 1.5}
                  textAnchor="end"
                  fontSize="7"
                  fill={
                    v === 80
                      ? "rgba(244,63,94,0.5)"
                      : v === 20
                      ? "rgba(16,185,129,0.5)"
                      : "var(--text-faint)"
                  }
                  fontFamily="JetBrains Mono, monospace"
                >
                  {v}
                </text>
              ))}
            </svg>
          </div>
        )}
      </div>
    </>
  );
}

/* ─── 📈 B 月營收面板 ─────────────────────────────────────── */
function RevenuePanel({ symbol, candles, forceExpand = false }) {
  const [open, setOpen] = React.useState(() => {
    try {
      const v = localStorage.getItem(SK.REVENUE_OPEN);
      return v === "1";
    } catch (_) {
      return false;
    }
  });
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [raw, setRaw] = React.useState([]);
  const [overlayRange, setOverlayRange] = React.useState(() => {
    try {
      const v = localStorage.getItem(SK.REVENUE_OVERLAY_RANGE);
      return v && ["1Y", "2Y", "3Y"].includes(v) ? v : "2Y";
    } catch (_) {
      return "2Y";
    }
  });
  const [hoverIdx, setHoverIdx] = React.useState(null);

  React.useEffect(() => {
    try {
      localStorage.setItem(SK.REVENUE_OPEN, open ? "1" : "0");
    } catch (_) {}
  }, [open]);
  React.useEffect(() => {
    try {
      localStorage.setItem(SK.REVENUE_OVERLAY_RANGE, overlayRange);
    } catch (_) {}
  }, [overlayRange]);

  // 載入月營收(快取 1 天,失敗用過期快照 fallback)
  React.useEffect(() => {
    if (!symbol) return;
    if (!open && !forceExpand) return; // 收合時不主動拉,展開或匯出時才拉
    const cacheKey = SK.revenue(symbol);
    const now = Date.now();
    const TTL = 86400 * 1000; // 1 天
    // 先嘗試讀快取
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (c && c.data && now - c.timestamp < TTL) {
        setRaw(c.data);
        return;
      }
    } catch (_) {}
    setLoading(true);
    setErr("");
    // 月營收抓最近 40 個月,後面可以裁切;FinMind 不需 end_date
    const startDate = new Date(now - 40 * 31 * 86400000)
      .toISOString()
      .split("T")[0];
    const url = viaProxy(
      finmindUrl(
        `dataset=TaiwanStockMonthRevenue&data_id=${symbol}&start_date=${startDate}`
      )
    );
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        const data = (j && j.data) || [];
        if (data.length === 0) {
          // 嘗試過期快照
          try {
            const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
            if (c && c.data && c.data.length > 0) {
              setRaw(c.data);
              setErr("API 暫時無資料,顯示快取版本");
              setLoading(false);
              return;
            }
          } catch (_) {}
          setRaw([]);
          setErr("查無月營收資料");
          setLoading(false);
          return;
        }
        setRaw(data);
        try {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({ timestamp: now, data })
          );
        } catch (_) {}
        setLoading(false);
      })
      .catch((e) => {
        // 失敗用過期快照
        try {
          const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
          if (c && c.data && c.data.length > 0) {
            setRaw(c.data);
            setErr("API 失敗,顯示過期快取");
            setLoading(false);
            return;
          }
        } catch (_) {}
        setErr("載入失敗:" + (e.message || "未知錯誤"));
        setLoading(false);
      });
  }, [symbol, open, forceExpand]);

  const processed = React.useMemo(() => processRevenue(raw), [raw]);
  const tail24 = React.useMemo(
    () => tailRevenueMonths(processed, 24),
    [processed]
  );
  const overlayMonths =
    overlayRange === "1Y" ? 12 : overlayRange === "2Y" ? 24 : 36;
  const overlayRevenue = React.useMemo(
    () => tailRevenueMonths(processed, overlayMonths),
    [processed, overlayMonths]
  );
  const overlayAligned = React.useMemo(
    () => alignRevenuePrice(overlayRevenue, candles),
    [overlayRevenue, candles]
  );

  const effectivelyOpen = open || forceExpand;

  // 計算柱狀圖 y 軸範圍
  const revs = tail24.map((r) => r.revenue);
  const maxRev = revs.length > 0 ? Math.max(...revs) : 1;
  const minRev = 0;

  function fmtRev(v) {
    // 月營收單位是「元」(FinMind),轉成億
    const oku = v / 1e8;
    if (oku >= 1000) return (oku / 1000).toFixed(2) + " 千億";
    if (oku >= 1) return oku.toFixed(2) + " 億";
    return (v / 1e4).toFixed(0) + " 萬";
  }

  // 疊圖 SVG 計算
  const overlayW = 720;
  const overlayH = 220;
  const padL = 50,
    padR = 50,
    padT = 12,
    padB = 32;
  const innerW = overlayW - padL - padR;
  const innerH = overlayH - padT - padB;
  const overlayRevs = overlayAligned.map((r) => r.revenue);
  const overlayPrices = overlayAligned
    .map((r) => r.price)
    .filter((p) => p != null && p > 0);
  const revMax = overlayRevs.length > 0 ? Math.max(...overlayRevs) : 1;
  const priceMax = overlayPrices.length > 0 ? Math.max(...overlayPrices) : 1;
  const priceMin = overlayPrices.length > 0 ? Math.min(...overlayPrices) : 0;
  const priceRange = priceMax - priceMin || 1;
  const xStep =
    overlayAligned.length > 1 ? innerW / (overlayAligned.length - 1) : 0;

  return (
    <div className="fund-panel">
      <div className="fund-panel-header">
        <button
          className="fund-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={effectivelyOpen}
        >
          <span className="fund-eyebrow">MONTHLY REVENUE</span>
          <span className="fund-title">月營收 YoY / MoM · 24 個月</span>
          <span className={`fund-chevron ${effectivelyOpen ? "open" : ""}`}>
            ›
          </span>
        </button>
      </div>
      <div className={`fund-body ${effectivelyOpen ? "open" : ""}`}>
        <div className="fund-body-inner">
          {loading && <div className="fund-loading">載入中…</div>}
          {err && <div className="fund-error">{err}</div>}
          {!loading && tail24.length === 0 && !err && (
            <div className="fund-empty">無月營收資料</div>
          )}
          {tail24.length > 0 && (
            <>
              {/* === 月營收柱狀圖 === */}
              <div className="fund-section-label">
                月營收柱狀圖(最近 24 個月)
              </div>
              <div className="rev-bars">
                <svg
                  viewBox={`0 0 ${tail24.length * 26 + 40} 160`}
                  preserveAspectRatio="xMinYMid meet"
                  className="rev-bars-svg"
                >
                  {/* 0 軸 */}
                  <line
                    x1={20}
                    x2={tail24.length * 26 + 20}
                    y1={140}
                    y2={140}
                    stroke="var(--border)"
                    strokeWidth="1"
                  />
                  {tail24.map((r, i) => {
                    const h =
                      ((r.revenue - minRev) / (maxRev - minRev || 1)) * 110;
                    const x = 20 + i * 26;
                    const y = 140 - h;
                    const isHover = hoverIdx === i;
                    // YoY > 0 紅(成長)、< 0 綠(衰退)、null 灰
                    const color =
                      r.yoy == null
                        ? "var(--text-faint)"
                        : r.yoy >= 0
                        ? "var(--up)"
                        : "var(--down)";
                    return (
                      <g
                        key={r.ym}
                        onMouseEnter={() => setHoverIdx(i)}
                        onMouseLeave={() => setHoverIdx(null)}
                      >
                        <rect
                          x={x}
                          y={y}
                          width={18}
                          height={h}
                          fill={color}
                          opacity={isHover ? 1 : 0.85}
                          rx={2}
                          className="rev-bar"
                        />
                        {/* 每 3 個月顯示月份 label */}
                        {(i === tail24.length - 1 || i % 3 === 0) && (
                          <text
                            x={x + 9}
                            y={155}
                            fontSize="8.5"
                            fill="var(--text-faint)"
                            textAnchor="middle"
                          >
                            {r.ym.slice(2)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
                {hoverIdx != null && tail24[hoverIdx] && (
                  <div className="rev-tooltip">
                    <div className="rev-tt-ym">{tail24[hoverIdx].ym}</div>
                    <div className="rev-tt-row">
                      <span>營收</span>
                      <span className="rev-tt-val">
                        {fmtRev(tail24[hoverIdx].revenue)}
                      </span>
                    </div>
                    {tail24[hoverIdx].yoy != null && (
                      <div className="rev-tt-row">
                        <span>YoY</span>
                        <span
                          className={`rev-tt-val ${
                            tail24[hoverIdx].yoy >= 0 ? "up" : "down"
                          }`}
                        >
                          {tail24[hoverIdx].yoy >= 0 ? "+" : ""}
                          {tail24[hoverIdx].yoy.toFixed(2)}%
                        </span>
                      </div>
                    )}
                    {tail24[hoverIdx].mom != null && (
                      <div className="rev-tt-row">
                        <span>MoM</span>
                        <span
                          className={`rev-tt-val ${
                            tail24[hoverIdx].mom >= 0 ? "up" : "down"
                          }`}
                        >
                          {tail24[hoverIdx].mom >= 0 ? "+" : ""}
                          {tail24[hoverIdx].mom.toFixed(2)}%
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* === YoY/MoM 表格(最近 6 個月) === */}
              <div className="fund-section-label" style={{ marginTop: 18 }}>
                近 6 個月詳細
              </div>
              <div className="rev-table-wrap">
                <table className="rev-table">
                  <thead>
                    <tr>
                      <th>月份</th>
                      <th>營收</th>
                      <th>YoY</th>
                      <th>MoM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tail24
                      .slice(-6)
                      .reverse()
                      .map((r) => (
                        <tr key={r.ym}>
                          <td>{r.ym}</td>
                          <td>{fmtRev(r.revenue)}</td>
                          <td
                            className={
                              r.yoy == null ? "" : r.yoy >= 0 ? "up" : "down"
                            }
                          >
                            {r.yoy == null
                              ? "—"
                              : (r.yoy >= 0 ? "+" : "") +
                                r.yoy.toFixed(2) +
                                "%"}
                          </td>
                          <td
                            className={
                              r.mom == null ? "" : r.mom >= 0 ? "up" : "down"
                            }
                          >
                            {r.mom == null
                              ? "—"
                              : (r.mom >= 0 ? "+" : "") +
                                r.mom.toFixed(2) +
                                "%"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              {/* === 營收-股價疊圖 === */}
              <div className="fund-section-label-row" style={{ marginTop: 18 }}>
                <span className="fund-section-label" style={{ margin: 0 }}>
                  營收 × 股價 疊圖(看領先性)
                </span>
                <div className="overlay-range-tabs">
                  {["1Y", "2Y", "3Y"].map((r) => (
                    <button
                      key={r}
                      className={`overlay-range-btn ${
                        overlayRange === r ? "active" : ""
                      }`}
                      onClick={() => setOverlayRange(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              {overlayAligned.length > 0 && (
                <div className="rev-overlay">
                  <svg
                    viewBox={`0 0 ${overlayW} ${overlayH}`}
                    preserveAspectRatio="xMidYMid meet"
                    className="rev-overlay-svg"
                  >
                    {/* 左 Y 軸(營收) */}
                    <line
                      x1={padL}
                      x2={padL}
                      y1={padT}
                      y2={padT + innerH}
                      stroke="var(--border)"
                      strokeWidth="1"
                    />
                    {/* 右 Y 軸(股價) */}
                    <line
                      x1={padL + innerW}
                      x2={padL + innerW}
                      y1={padT}
                      y2={padT + innerH}
                      stroke="var(--border)"
                      strokeWidth="1"
                    />
                    {/* X 軸 */}
                    <line
                      x1={padL}
                      x2={padL + innerW}
                      y1={padT + innerH}
                      y2={padT + innerH}
                      stroke="var(--border)"
                      strokeWidth="1"
                    />
                    {/* 營收柱 */}
                    {overlayAligned.map((r, i) => {
                      const h = (r.revenue / (revMax || 1)) * innerH;
                      const cx = padL + i * xStep;
                      const barW = Math.max(2, xStep * 0.55);
                      return (
                        <rect
                          key={`bar-${r.ym}`}
                          x={cx - barW / 2}
                          y={padT + innerH - h}
                          width={barW}
                          height={h}
                          fill="rgba(59, 130, 246, 0.32)"
                          stroke="rgba(59, 130, 246, 0.55)"
                          strokeWidth="0.5"
                        />
                      );
                    })}
                    {/* 股價折線 */}
                    {(() => {
                      const pts = overlayAligned
                        .map((r, i) => {
                          if (r.price == null) return null;
                          const x = padL + i * xStep;
                          const y =
                            padT +
                            innerH -
                            ((r.price - priceMin) / priceRange) * innerH;
                          return `${x},${y}`;
                        })
                        .filter(Boolean);
                      if (pts.length < 2) return null;
                      return (
                        <polyline
                          points={pts.join(" ")}
                          fill="none"
                          stroke="rgba(244, 63, 94, 0.85)"
                          strokeWidth="1.8"
                        />
                      );
                    })()}
                    {/* X 軸標籤 */}
                    {overlayAligned.map((r, i) => {
                      if (
                        i !== 0 &&
                        i !== overlayAligned.length - 1 &&
                        i %
                          Math.max(1, Math.floor(overlayAligned.length / 6)) !==
                          0
                      )
                        return null;
                      const x = padL + i * xStep;
                      return (
                        <text
                          key={`xl-${r.ym}`}
                          x={x}
                          y={padT + innerH + 16}
                          fontSize="9"
                          fill="var(--text-faint)"
                          textAnchor="middle"
                        >
                          {r.ym.slice(2)}
                        </text>
                      );
                    })}
                    {/* 左軸 label */}
                    <text
                      x={padL - 4}
                      y={padT + 10}
                      fontSize="9"
                      fill="rgba(59, 130, 246, 0.85)"
                      textAnchor="end"
                    >
                      營收
                    </text>
                    {/* 右軸 label */}
                    <text
                      x={padL + innerW + 4}
                      y={padT + 10}
                      fontSize="9"
                      fill="rgba(244, 63, 94, 0.95)"
                      textAnchor="start"
                    >
                      股價
                    </text>
                  </svg>
                  <div className="rev-overlay-legend">
                    <span className="legend-bar"></span>月營收
                    <span className="legend-line"></span>月底收盤價
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── 💰 B 股利政策面板 ────────────────────────────────────── */
function DividendPanel({ symbol, candles, forceExpand = false }) {
  const [open, setOpen] = React.useState(() => {
    try {
      return localStorage.getItem(SK.DIVIDEND_OPEN) === "1";
    } catch (_) {
      return false;
    }
  });
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [raw, setRaw] = React.useState([]);

  React.useEffect(() => {
    try {
      localStorage.setItem(SK.DIVIDEND_OPEN, open ? "1" : "0");
    } catch (_) {}
  }, [open]);

  React.useEffect(() => {
    if (!symbol) return;
    if (!open && !forceExpand) return;
    const cacheKey = SK.dividend(symbol);
    const now = Date.now();
    const TTL = 7 * 86400 * 1000; // 7 天
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (c && c.data && now - c.timestamp < TTL) {
        setRaw(c.data);
        return;
      }
    } catch (_) {}
    setLoading(true);
    setErr("");
    // 近 12 年(預留 buffer)
    const startDate = new Date(now - 12 * 365 * 86400000)
      .toISOString()
      .split("T")[0];
    const url = viaProxy(
      finmindUrl(
        `dataset=TaiwanStockDividend&data_id=${symbol}&start_date=${startDate}`
      )
    );
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        const data = (j && j.data) || [];
        if (data.length === 0) {
          try {
            const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
            if (c && c.data && c.data.length > 0) {
              setRaw(c.data);
              setErr("API 暫時無資料,顯示快取版本");
              setLoading(false);
              return;
            }
          } catch (_) {}
          setRaw([]);
          setErr("查無股利資料");
          setLoading(false);
          return;
        }
        setRaw(data);
        try {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({ timestamp: now, data })
          );
        } catch (_) {}
        setLoading(false);
      })
      .catch((e) => {
        try {
          const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
          if (c && c.data && c.data.length > 0) {
            setRaw(c.data);
            setErr("API 失敗,顯示過期快取");
            setLoading(false);
            return;
          }
        } catch (_) {}
        setErr("載入失敗:" + (e.message || "未知錯誤"));
        setLoading(false);
      });
  }, [symbol, open, forceExpand]);

  const yearlyAvgPrice = React.useMemo(
    () => buildYearlyAvgPrice(candles),
    [candles]
  );
  const dividends = React.useMemo(() => {
    const base = processDividend(raw);
    return attachDividendYield(base, yearlyAvgPrice).slice(0, 10); // 取近 10 年
  }, [raw, yearlyAvgPrice]);

  const effectivelyOpen = open || forceExpand;

  // 計算殖利率平均(忽略 null)
  const yields = dividends.map((d) => d.yield).filter((y) => y != null);
  const avgYield =
    yields.length > 0
      ? yields.reduce((a, b) => a + b, 0) / yields.length
      : null;

  // 柱狀圖最大值
  const maxTotal =
    dividends.length > 0 ? Math.max(...dividends.map((d) => d.total || 0)) : 1;

  return (
    <div className="fund-panel">
      <div className="fund-panel-header">
        <button
          className="fund-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={effectivelyOpen}
        >
          <span className="fund-eyebrow">DIVIDEND POLICY</span>
          <span className="fund-title">股利政策 · 近 10 年</span>
          <span className={`fund-chevron ${effectivelyOpen ? "open" : ""}`}>
            ›
          </span>
        </button>
      </div>
      <div className={`fund-body ${effectivelyOpen ? "open" : ""}`}>
        <div className="fund-body-inner">
          {loading && <div className="fund-loading">載入中…</div>}
          {err && <div className="fund-error">{err}</div>}
          {!loading && dividends.length === 0 && !err && (
            <div className="fund-empty">無股利資料</div>
          )}
          {dividends.length > 0 && (
            <>
              <div className="div-summary">
                <div className="div-stat">
                  <div className="div-stat-label">近 10 年平均殖利率</div>
                  <div className="div-stat-val">
                    {avgYield != null ? avgYield.toFixed(2) + "%" : "—"}
                  </div>
                </div>
                <div className="div-stat">
                  <div className="div-stat-label">最近一年現金股利</div>
                  <div className="div-stat-val">
                    {dividends[0].cash
                      ? dividends[0].cash.toFixed(2) + " 元"
                      : "—"}
                  </div>
                </div>
                <div className="div-stat">
                  <div className="div-stat-label">最近一年股票股利</div>
                  <div className="div-stat-val">
                    {dividends[0].stock
                      ? dividends[0].stock.toFixed(2) + " 元"
                      : "—"}
                  </div>
                </div>
              </div>

              {/* 股利柱狀圖(現金 + 股票 stacked) */}
              <div className="fund-section-label" style={{ marginTop: 16 }}>
                歷年股利分配
              </div>
              <div className="div-bars-wrap">
                <svg
                  viewBox={`0 0 ${dividends.length * 50 + 40} 170`}
                  preserveAspectRatio="xMinYMid meet"
                  className="div-bars-svg"
                >
                  <line
                    x1={20}
                    x2={dividends.length * 50 + 20}
                    y1={140}
                    y2={140}
                    stroke="var(--border)"
                    strokeWidth="1"
                  />
                  {dividends
                    .slice()
                    .reverse()
                    .map((d, i) => {
                      const cashH = (d.cash / (maxTotal || 1)) * 110;
                      const stockH = (d.stock / (maxTotal || 1)) * 110;
                      const x = 20 + i * 50;
                      return (
                        <g key={d.year}>
                          {/* 現金 */}
                          <rect
                            x={x}
                            y={140 - cashH}
                            width={36}
                            height={cashH}
                            fill="var(--accent)"
                            opacity="0.85"
                            rx={2}
                          />
                          {/* 股票疊在現金上 */}
                          {stockH > 0 && (
                            <rect
                              x={x}
                              y={140 - cashH - stockH}
                              width={36}
                              height={stockH}
                              fill="rgba(96, 165, 250, 0.7)"
                              rx={2}
                            />
                          )}
                          {/* 年份 */}
                          <text
                            x={x + 18}
                            y={155}
                            fontSize="9"
                            fill="var(--text-faint)"
                            textAnchor="middle"
                          >
                            {d.year}
                          </text>
                          {/* 總額 label */}
                          <text
                            x={x + 18}
                            y={140 - cashH - stockH - 4}
                            fontSize="8.5"
                            fill="var(--text-strong)"
                            textAnchor="middle"
                            fontWeight="600"
                          >
                            {d.total.toFixed(1)}
                          </text>
                        </g>
                      );
                    })}
                </svg>
                <div className="div-legend">
                  <span className="legend-cash"></span>現金股利
                  <span className="legend-stock"></span>股票股利
                </div>
              </div>

              {/* 股利明細表 */}
              <div className="fund-section-label" style={{ marginTop: 18 }}>
                歷年明細
              </div>
              <div className="div-table-wrap">
                <table className="div-table">
                  <thead>
                    <tr>
                      <th>年度</th>
                      <th>現金股利</th>
                      <th>股票股利</th>
                      <th>合計</th>
                      <th>殖利率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dividends.map((d) => (
                      <tr key={d.year}>
                        <td>{d.year}</td>
                        <td>{d.cash ? d.cash.toFixed(2) : "—"}</td>
                        <td>{d.stock ? d.stock.toFixed(2) : "—"}</td>
                        <td className="strong">{d.total.toFixed(2)}</td>
                        <td
                          className={
                            d.yield != null && d.yield >= avgYield ? "up" : ""
                          }
                        >
                          {d.yield != null ? d.yield.toFixed(2) + "%" : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── 📊 B EPS 季趨勢面板 ──────────────────────────────────── */
function EPSPanel({ symbol, forceExpand = false }) {
  const [open, setOpen] = React.useState(() => {
    try {
      return localStorage.getItem(SK.EPS_OPEN) === "1";
    } catch (_) {
      return false;
    }
  });
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [raw, setRaw] = React.useState([]);
  const [hoverIdx, setHoverIdx] = React.useState(null);

  React.useEffect(() => {
    try {
      localStorage.setItem(SK.EPS_OPEN, open ? "1" : "0");
    } catch (_) {}
  }, [open]);

  React.useEffect(() => {
    if (!symbol) return;
    if (!open && !forceExpand) return;
    const cacheKey = SK.eps(symbol);
    const now = Date.now();
    const TTL = 86400 * 1000;
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (c && c.data && now - c.timestamp < TTL) {
        setRaw(c.data);
        return;
      }
    } catch (_) {}
    setLoading(true);
    setErr("");
    // 撈 4 年資料,確保 12 季可取(預留 1 季 buffer)
    const startDate = new Date(now - 4 * 365 * 86400000)
      .toISOString()
      .split("T")[0];
    const url = viaProxy(
      finmindUrl(
        `dataset=TaiwanStockFinancialStatements&data_id=${symbol}&start_date=${startDate}`
      )
    );
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        const all = (j && j.data) || [];
        // 篩 type === 'EPS'
        const data = all.filter((r) => r.type === "EPS");
        if (data.length === 0) {
          try {
            const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
            if (c && c.data && c.data.length > 0) {
              setRaw(c.data);
              setErr("API 暫時無資料,顯示快取版本");
              setLoading(false);
              return;
            }
          } catch (_) {}
          setRaw([]);
          setErr("查無 EPS 資料");
          setLoading(false);
          return;
        }
        setRaw(data);
        try {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({ timestamp: now, data })
          );
        } catch (_) {}
        setLoading(false);
      })
      .catch((e) => {
        try {
          const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
          if (c && c.data && c.data.length > 0) {
            setRaw(c.data);
            setErr("API 失敗,顯示過期快取");
            setLoading(false);
            return;
          }
        } catch (_) {}
        setErr("載入失敗:" + (e.message || "未知錯誤"));
        setLoading(false);
      });
  }, [symbol, open, forceExpand]);

  const processed = React.useMemo(() => processEPS(raw), [raw]);
  const tail12 = React.useMemo(() => processed.slice(-12), [processed]);
  const effectivelyOpen = open || forceExpand;

  // 計算柱狀圖範圍(EPS 可能為負)
  const epsValues = tail12.map((r) => r.eps);
  const epsMax = epsValues.length > 0 ? Math.max(...epsValues, 0) : 1;
  const epsMin = epsValues.length > 0 ? Math.min(...epsValues, 0) : 0;
  const epsRange = epsMax - epsMin || 1;

  // 4 季累計 EPS(最後 4 季)
  const ttmEPS = tail12.slice(-4).reduce((acc, r) => acc + r.eps, 0);

  return (
    <div className="fund-panel">
      <div className="fund-panel-header">
        <button
          className="fund-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={effectivelyOpen}
        >
          <span className="fund-eyebrow">EPS QUARTERLY</span>
          <span className="fund-title">EPS 季趨勢 · 12 季</span>
          <span className={`fund-chevron ${effectivelyOpen ? "open" : ""}`}>
            ›
          </span>
        </button>
      </div>
      <div className={`fund-body ${effectivelyOpen ? "open" : ""}`}>
        <div className="fund-body-inner">
          {loading && <div className="fund-loading">載入中…</div>}
          {err && <div className="fund-error">{err}</div>}
          {!loading && tail12.length === 0 && !err && (
            <div className="fund-empty">無 EPS 資料</div>
          )}
          {tail12.length > 0 && (
            <>
              <div className="div-summary">
                <div className="div-stat">
                  <div className="div-stat-label">最近 4 季累計 EPS</div>
                  <div className="div-stat-val">{ttmEPS.toFixed(2)} 元</div>
                </div>
                <div className="div-stat">
                  <div className="div-stat-label">最新一季 EPS</div>
                  <div className="div-stat-val">
                    {tail12[tail12.length - 1].eps.toFixed(2)} 元
                  </div>
                </div>
                <div className="div-stat">
                  <div className="div-stat-label">最新一季 YoY</div>
                  <div
                    className={`div-stat-val ${
                      tail12[tail12.length - 1].yoy == null
                        ? ""
                        : tail12[tail12.length - 1].yoy >= 0
                        ? "up"
                        : "down"
                    }`}
                  >
                    {tail12[tail12.length - 1].yoy == null
                      ? "—"
                      : (tail12[tail12.length - 1].yoy >= 0 ? "+" : "") +
                        tail12[tail12.length - 1].yoy.toFixed(1) +
                        "%"}
                  </div>
                </div>
              </div>

              <div className="fund-section-label" style={{ marginTop: 16 }}>
                12 季 EPS 趨勢
              </div>
              <div className="eps-bars">
                <svg
                  viewBox={`0 0 ${tail12.length * 48 + 40} 180`}
                  preserveAspectRatio="xMinYMid meet"
                  className="eps-bars-svg"
                >
                  {/* 0 軸計算 */}
                  {(() => {
                    const zeroY = 150 - ((0 - epsMin) / epsRange) * 120;
                    return (
                      <line
                        x1={20}
                        x2={tail12.length * 48 + 20}
                        y1={zeroY}
                        y2={zeroY}
                        stroke="var(--border-strong)"
                        strokeWidth="1"
                        strokeDasharray="2,2"
                      />
                    );
                  })()}
                  {tail12.map((r, i) => {
                    const zeroY = 150 - ((0 - epsMin) / epsRange) * 120;
                    const valY = 150 - ((r.eps - epsMin) / epsRange) * 120;
                    const x = 20 + i * 48;
                    const isHover = hoverIdx === i;
                    const isPositive = r.eps >= 0;
                    const color = isPositive ? "var(--up)" : "var(--down)";
                    const top = Math.min(zeroY, valY);
                    const h = Math.abs(zeroY - valY);
                    return (
                      <g
                        key={r.q}
                        onMouseEnter={() => setHoverIdx(i)}
                        onMouseLeave={() => setHoverIdx(null)}
                      >
                        <rect
                          x={x}
                          y={top}
                          width={36}
                          height={h}
                          fill={color}
                          opacity={isHover ? 1 : 0.85}
                          rx={2}
                        />
                        <text
                          x={x + 18}
                          y={isPositive ? top - 4 : top + h + 11}
                          fontSize="9"
                          fill="var(--text-strong)"
                          textAnchor="middle"
                          fontWeight="600"
                        >
                          {r.eps.toFixed(2)}
                        </text>
                        <text
                          x={x + 18}
                          y={170}
                          fontSize="8.5"
                          fill="var(--text-faint)"
                          textAnchor="middle"
                        >
                          {r.q.replace("Q", "Q")}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                {hoverIdx != null && tail12[hoverIdx] && (
                  <div className="eps-tooltip">
                    <div className="rev-tt-ym">{tail12[hoverIdx].q}</div>
                    <div className="rev-tt-row">
                      <span>EPS</span>
                      <span className="rev-tt-val">
                        {tail12[hoverIdx].eps.toFixed(2)} 元
                      </span>
                    </div>
                    {tail12[hoverIdx].yoy != null && (
                      <div className="rev-tt-row">
                        <span>YoY</span>
                        <span
                          className={`rev-tt-val ${
                            tail12[hoverIdx].yoy >= 0 ? "up" : "down"
                          }`}
                        >
                          {tail12[hoverIdx].yoy >= 0 ? "+" : ""}
                          {tail12[hoverIdx].yoy.toFixed(1)}%
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── ⭐️ 四因子雷達圖元件 V2.0(viewBox 擴大版)⭐️ ─────────────
 * 改動:viewBox 從 0 0 200 200 擴成 -40 -50 280 290
 * 解決:原 viewBox 邊界距標籤中心僅 10px,VALUE/TREND 必被裁
 * 額外:三層標籤(EN/CN/分數)垂直排列、currentColor 主題感知、
 *      資料點加 halo glow
 * ─────────────────────────────────────────────────────────── */
function FactorRadar({ factors }) {
  const { momentum, value, quality, trend } = factors;
  const cx = 100,
    cy = 100,
    r = 70;
  const angles = [-90, 0, 90, 180]; // 上右下左
  const labels = [
    { en: "MOMENTUM", cn: "動能" },
    { en: "VALUE", cn: "估值" },
    { en: "QUALITY", cn: "品質" },
    { en: "TREND", cn: "趨勢" },
  ];
  const scores = [momentum, value, quality, trend];

  const points = scores
    .map((s, i) => {
      const angle = (angles[i] * Math.PI) / 180;
      const dist = (s / 100) * r;
      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;
      return `${x},${y}`;
    })
    .join(" ");

  const labelPositions = angles.map((angle, i) => {
    const rad = (angle * Math.PI) / 180;
    return {
      x: cx + Math.cos(rad) * (r + 22),
      y: cy + Math.sin(rad) * (r + 22),
      label: labels[i],
      score: scores[i],
      angle: angles[i],
    };
  });

  return (
    <svg
      viewBox="-40 -50 280 290"
      className="factor-radar"
      style={{ overflow: "visible" }}
    >
      <defs>
        <linearGradient id="radarFill" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#818cf8" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0.08" />
        </linearGradient>
        <radialGradient id="radarDotGlow">
          <stop offset="0%" stopColor="#a5b4fc" stopOpacity="0.9" />
          <stop offset="60%" stopColor="#818cf8" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 背景同心圓 */}
      {[0.25, 0.5, 0.75, 1].map((scale, i) => (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={r * scale}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.14}
          strokeWidth="0.7"
        />
      ))}

      {/* 軸線 */}
      {angles.map((a, i) => {
        const rad = (a * Math.PI) / 180;
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={cx + Math.cos(rad) * r}
            y2={cy + Math.sin(rad) * r}
            stroke="currentColor"
            strokeOpacity={0.14}
            strokeWidth="0.7"
          />
        );
      })}

      {/* 資料面 polygon */}
      <polygon
        points={points}
        fill="url(#radarFill)"
        stroke="#818cf8"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />

      {/* 資料點 + halo glow */}
      {scores.map((s, i) => {
        const angle = (angles[i] * Math.PI) / 180;
        const dist = (s / 100) * r;
        const px = cx + Math.cos(angle) * dist;
        const py = cy + Math.sin(angle) * dist;
        return (
          <g key={i}>
            <circle cx={px} cy={py} r="7" fill="url(#radarDotGlow)" />
            <circle
              cx={px}
              cy={py}
              r="3.2"
              fill="#818cf8"
              stroke="#fff"
              strokeWidth="1.5"
            />
          </g>
        );
      })}

      {/* 三層標籤:EN(上,小灰)+ CN(中,亮)+ 分數(下,indigo 強)*/}
      {labelPositions.map((p, i) => {
        const isTop = p.angle === -90;
        const isBottom = p.angle === 90;
        const baseDy = isTop ? -18 : isBottom ? 6 : -8;

        return (
          <g key={i}>
            <text
              x={p.x}
              y={p.y + baseDy}
              textAnchor="middle"
              fontSize="7.5"
              fill="currentColor"
              fillOpacity={0.55}
              fontWeight="600"
              fontFamily="JetBrains Mono, monospace"
              letterSpacing="0.6"
            >
              {p.label.en}
            </text>
            <text
              x={p.x}
              y={p.y + baseDy + 10}
              textAnchor="middle"
              fontSize="9"
              fill="currentColor"
              fillOpacity={0.92}
              fontWeight="700"
              letterSpacing="0.5"
            >
              {p.label.cn}
            </text>
            <text
              x={p.x}
              y={p.y + baseDy + 24}
              textAnchor="middle"
              fontSize="11"
              fill="#818cf8"
              fontWeight="800"
              fontFamily="JetBrains Mono, monospace"
              letterSpacing="0.4"
            >
              {Math.round(p.score)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ─── ⭐️ 星等顯示元件 ⭐️ ─────────────────────────────────── */
/* ─── 展開/收合動畫容器 ────────────────────────────────────── */
function CollapsibleSection({
  label,
  open,
  onToggle,
  children,
  defaultBorder = true,
}) {
  return (
    <div className={`cs-wrap ${defaultBorder ? "cs-border" : ""}`}>
      <button className="cs-toggle" onClick={onToggle}>
        <span className="cs-label">{label}</span>
        <span className={`cs-chevron ${open ? "open" : ""}`}>›</span>
      </button>
      <div className={`cs-inner ${open ? "open" : ""}`}>
        <div className="cs-content">{children}</div>
      </div>
    </div>
  );
}

function StarRating({ stars }) {
  const fullStars = Math.floor(stars);
  const hasHalf = stars - fullStars >= 0.5;
  return (
    <div className="star-rating">
      {[1, 2, 3, 4, 5].map((n) => {
        if (n <= fullStars)
          return (
            <span key={n} className="star filled">
              ★
            </span>
          );
        if (n === fullStars + 1 && hasHalf)
          return (
            <span key={n} className="star half">
              ★
            </span>
          );
        return (
          <span key={n} className="star">
            ★
          </span>
        );
      })}
    </div>
  );
}

/* ─── 迷你走勢圖 (SVG sparkline) ───────────────────────────── */
function Sparkline({ data, up }) {
  if (!data || data.length < 2) {
    return <div className="spark-empty">···</div>;
  }
  const w = 120;
  const h = 38;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const coords = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return [x, y];
  });
  const line = coords
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  const color = up ? "var(--up)" : "var(--down)";
  const gid = up ? "spark-up" : "spark-down";
  const [lx, ly] = coords[coords.length - 1];
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lx} cy={ly} r="2.4" fill={color} />
    </svg>
  );
}

/* ─── 📊 升級版 Sparkline (Dashboard 大卡專用) ────────────
 * 跟現有 Sparkline 差別:
 *   - 高度 70px(現有 38px)
 *   - 加 MA20 副線(虛線、淡灰)
 *   - 標示 90 日最高 / 最低點(圓圈+字母 H/L)
 *   - 漲跌色保持台股慣例(紅漲綠跌)
 * 不打新 API,純複用現有 spark 資料(90 日 close)
 * --------------------------------------------------------- */
function SparklineEnhanced({ data, up }) {
  if (!data || data.length < 2) {
    return <div className="spk-enh-empty">資料載入中…</div>;
  }
  const w = 220;
  const h = 70;
  const padX = 12;
  const padT = 8;
  const padB = 8;
  const innerW = w - padX * 2;
  const innerH = h - padT - padB;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  // MA20:每點往前 20 日平均(不足 20 日就用 SMA 短期)
  const ma20 = data.map((_, i) => {
    if (i < 4) return null; // 前 5 點不畫 MA 太短不準
    const start = Math.max(0, i - 19);
    const slice = data.slice(start, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });

  const xOf = (i) => padX + (i / (data.length - 1)) * innerW;
  const yOf = (v) => padT + (1 - (v - min) / range) * innerH;

  const linePts = data
    .map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(" ");
  const areaPts = `${padX},${h - padB} ${linePts} ${w - padX},${h - padB}`;

  const maPath = ma20
    .map((v, i) =>
      v == null
        ? null
        : `${i === 0 || ma20[i - 1] == null ? "M" : "L"}${xOf(i).toFixed(
            1
          )},${yOf(v).toFixed(1)}`
    )
    .filter(Boolean)
    .join(" ");

  // 找最高 / 最低點位置
  let hiIdx = 0,
    loIdx = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i] > data[hiIdx]) hiIdx = i;
    if (data[i] < data[loIdx]) loIdx = i;
  }

  const color = up ? "var(--up)" : "var(--down)";
  const gid = up ? "spk-enh-up" : "spk-enh-down";
  const [lastX, lastY] = [xOf(data.length - 1), yOf(data[data.length - 1])];

  return (
    <svg
      className="spk-enh"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* 填色區 */}
      <polygon points={areaPts} fill={`url(#${gid})`} />

      {/* MA20 虛線 */}
      {maPath && (
        <path
          d={maPath}
          fill="none"
          stroke="rgba(139, 148, 167, 0.5)"
          strokeWidth="1"
          strokeDasharray="3 2"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {/* 主收盤線 */}
      <polyline
        points={linePts}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />

      {/* 最高點 */}
      <g>
        <circle
          cx={xOf(hiIdx)}
          cy={yOf(data[hiIdx])}
          r="3"
          fill="var(--up)"
          stroke="#fff"
          strokeWidth="0.8"
        />
        <text
          x={xOf(hiIdx)}
          y={yOf(data[hiIdx]) - 6}
          textAnchor="middle"
          fontSize="8.5"
          fontFamily="JetBrains Mono, monospace"
          fontWeight="700"
          fill="var(--up)"
        >
          H
        </text>
      </g>

      {/* 最低點 */}
      <g>
        <circle
          cx={xOf(loIdx)}
          cy={yOf(data[loIdx])}
          r="3"
          fill="var(--down)"
          stroke="#fff"
          strokeWidth="0.8"
        />
        <text
          x={xOf(loIdx)}
          y={yOf(data[loIdx]) + 11}
          textAnchor="middle"
          fontSize="8.5"
          fontFamily="JetBrains Mono, monospace"
          fontWeight="700"
          fill="var(--down)"
        >
          L
        </text>
      </g>

      {/* 末點 */}
      <circle cx={lastX} cy={lastY} r="2.8" fill={color} />
    </svg>
  );
}

/* ─── 📋 自選股大卡片 (Dashboard 專用) ──────────────────────
 * 比首頁 WatchlistCard 大、資訊更完整
 *   - 名稱 / 代號 / 移除鈕
 *   - SparklineEnhanced K 線縮圖(含 MA20、高低點標記)
 *   - 即時報價 + 漲跌
 *   - 評級徽章(BUY 82)
 * 點卡片 → 進入個股研究頁 (search + setViewMode)
 * --------------------------------------------------------- */
function WatchlistDashboardCard({ item, data, alertCount, onOpen, onRemove }) {
  const loading = !data || data.loading;
  const price = data && data.price != null ? data.price : null;
  const prevClose = data && data.prevClose != null ? data.prevClose : null;
  let chgPct = null;
  if (price != null && prevClose != null && prevClose > 0) {
    chgPct = ((price - prevClose) / prevClose) * 100;
  }
  const up = chgPct == null ? true : chgPct >= 0;
  const spark = (data && data.spark) || [];
  const rating = data && data.miniRating ? data.miniRating : null;

  return (
    <div className="wld-card" onClick={() => onOpen(item.sym)}>
      <button
        className="wld-remove"
        title="移除自選"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(item.sym);
        }}
      >
        ✕
      </button>
      {alertCount > 0 && (
        <div
          className="wld-alert-badge"
          title={`過去 24 小時 ${alertCount} 則警報`}
        >
          <span>⚠</span>
          <span>{alertCount}</span>
        </div>
      )}

      <div className="wld-head">
        <span className="wld-name">{item.name}</span>
        <span className="wld-sym">{item.sym}</span>
      </div>

      <div className="wld-spark-area">
        {loading ? (
          <div className="wld-spark-loading">
            <span className="dot">●</span>
            <span className="dot">●</span>
            <span className="dot">●</span>
          </div>
        ) : (
          <SparklineEnhanced data={spark} up={up} />
        )}
      </div>

      <div className="wld-price-row">
        {loading ? (
          <span className="wld-price loading">———</span>
        ) : price == null ? (
          <span className="wld-price err">無報價</span>
        ) : (
          <>
            <span className={`wld-price ${up ? "up" : "down"}`}>
              {fmt(price)}
            </span>
            {chgPct != null && (
              <span className={`wld-chg ${up ? "up" : "down"}`}>
                {up ? "▲" : "▼"} {chgPct >= 0 ? "+" : ""}
                {fmt(chgPct)}%
              </span>
            )}
          </>
        )}
      </div>

      {!loading && rating && (
        <div className={`wld-rating wld-rating-${rating.level}`}>
          <span className="wld-rating-tag">{rating.tag}</span>
          <span className="wld-rating-score">{rating.score}</span>
        </div>
      )}
    </div>
  );
}

/* ─── 自選股卡片 ───────────────────────────────────────────── */
function WatchlistCard({ item, data, isActive, alertCount, onOpen, onRemove }) {
  const loading = !data || data.loading;
  const price = data && data.price != null ? data.price : null;
  const prevClose = data && data.prevClose != null ? data.prevClose : null;
  let chgPct = null;
  if (price != null && prevClose != null && prevClose > 0) {
    chgPct = ((price - prevClose) / prevClose) * 100;
  }
  const up = chgPct == null ? true : chgPct >= 0;
  const spark = (data && data.spark) || [];
  const rating = data && data.miniRating ? data.miniRating : null;

  return (
    <div
      className={`wl-card ${isActive ? "active" : ""}`}
      onClick={() => onOpen(item.sym)}
    >
      <button
        className="wl-remove"
        title="移除自選"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(item.sym);
        }}
      >
        ✕
      </button>
      {alertCount > 0 && (
        <div
          className="wl-alert-badge"
          title={`過去 24 小時 ${alertCount} 則警報`}
        >
          <span>⚠</span>
          <span>{alertCount}</span>
        </div>
      )}
      <div className="wl-card-top">
        <div className="wl-name-group">
          <span className="wl-name">{item.name}</span>
          <span className="wl-sym">{item.sym}</span>
        </div>
      </div>
      <div className="wl-spark-area">
        {loading ? (
          <div className="wl-spark-loading">
            <span className="dot">●</span>
            <span className="dot">●</span>
            <span className="dot">●</span>
          </div>
        ) : (
          <Sparkline data={spark} up={up} />
        )}
      </div>
      <div className="wl-card-bottom">
        {loading ? (
          <span className="wl-price loading">———</span>
        ) : price == null ? (
          <span className="wl-price err">無報價</span>
        ) : (
          <>
            <span className={`wl-price ${up ? "up" : "down"}`}>
              {fmt(price)}
            </span>
            {chgPct != null && (
              <span className={`wl-chg ${up ? "up" : "down"}`}>
                {up ? "▲" : "▼"} {chgPct >= 0 ? "+" : ""}
                {fmt(chgPct)}%
              </span>
            )}
          </>
        )}
      </div>
      {!loading && rating && (
        <div className={`wl-rating wl-rating-${rating.level}`}>
          <span className="wl-rating-tag">{rating.tag}</span>
          <span className="wl-rating-score">{rating.score}</span>
        </div>
      )}
    </div>
  );
}

/* ─── Main App ────────────────────────────────────────────── */
export default function App() {
  const [input, setInput] = useState("");
  // 📊 Dashboard 模式:取代式導航
  //   "dashboard" → 顯示熱力圖+自選股大卡+Top10
  //   "research"  → 顯示個股研究頁
  // search() 成功 → 切到 research;返回鈕 → 切回 dashboard(不清 stock state)
  const [viewMode, setViewMode] = useState("dashboard");
  const [loading, setLoading] = useState(false);
  const [stock, setStock] = useState(null);
  const [fullChartData, setFullChartData] = useState([]);
  const [timeRange, setTimeRange] = useState(250);
  const [error, setError] = useState("");
  const [analysisContent, setAnalysisContent] = useState({
    technical: "",
    valuation: "",
    strategy: "",
  });
  const [metrics, setMetrics] = useState(null);
  const [fundamentals, setFundamentals] = useState(null);
  const [stockMap, setStockMap] = useState({});
  const [nameMap, setNameMap] = useState({});
  const [refreshCount, setRefreshCount] = useState(0);
  const [showRatingModal, setShowRatingModal] = useState(false);
  const [debugLogs, setDebugLogs] = useState([]);
  const [showDebug, setShowDebug] = useState(false);

  // 🔥 slogan 切換(點副標循環,localStorage 記憶)
  const [sloganIdx, setSloganIdx] = useState(() => {
    try {
      const raw = localStorage.getItem(SK.SLOGAN_IDX);
      const n = raw == null ? 0 : parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 && n < SLOGANS.length ? n : 0;
    } catch {
      return 0;
    }
  });
  const cycleSlogan = () => {
    setSloganIdx((i) => {
      const next = (i + 1) % SLOGANS.length;
      try {
        localStorage.setItem(SK.SLOGAN_IDX, String(next));
      } catch {}
      return next;
    });
  };

  // ⭐️ 自選股清單
  const WATCHLIST_KEY = SK.WATCHLIST;
  const [watchlist, setWatchlist] = useState([]);
  const [watchlistData, setWatchlistData] = useState({});
  const [wlRefreshing, setWlRefreshing] = useState(false);

  // ⭐️ 搜尋自動完成
  const [suggestions, setSuggestions] = useState([]);
  const [suggFocused, setSuggFocused] = useState(-1);
  const [showSugg, setShowSugg] = useState(false);
  const searchWrapRef = useRef(null);
  const searchInputRef = useRef(null);

  // ⭐️ 卡片區塊展開/收合
  const [ratingOpen, setRatingOpen] = useState(true);
  const [analysisOpen, setAnalysisOpen] = useState(true);

  // ⭐️ 警報系統
  const ALERT_HISTORY_KEY = SK.ALERTS;
  const ALERT_MAX_HISTORY = 50;
  const [toasts, setToasts] = useState([]); // 當前顯示中的 toast
  const [alertHistory, setAlertHistory] = useState([]); // 歷史警報(localStorage 持久)
  const [alertHistoryOpen, setAlertHistoryOpen] = useState(false);
  const alertPrevStateRef = useRef({}); // { symbol → { rsi, ratingScore, bbPos } }
  const toastIdRef = useRef(0);
  const TOAST_DURATION_MS = 6000;

  // ⭐️ 股價跳動動畫:價格變動時閃一下
  const [priceFlash, setPriceFlash] = useState(null);
  const prevPriceRef = useRef(null);
  const flashTimerRef = useRef(null);

  const refreshTimerRef = useRef(null);
  const currentSymbolRef = useRef(null);
  const stockExportRef = useRef(null); // 個股研究頁匯出截圖目標
  const ratingModalRef = useRef(null); // 量化評等完整報告匯出截圖目標
  const [stockExportAllTabs, setStockExportAllTabs] = useState(false); // 匯出時強制展開 4 個 tab
  const [stockExportForceExpandAll, setStockExportForceExpandAll] =
    useState(false); // v10:匯出時強制展開所有摺疊面板(籌碼/同業/新聞/警報)
  const [stockExportModal, setStockExportModal] = useState(null); // null | { kind: "png"|"pdf" }
  const [ratingExportBusy, setRatingExportBusy] = useState(false); // 量化評等匯出按鈕忙碌狀態

  // 🌟 自選股批次匯出 state
  const [batchExportModal, setBatchExportModal] = useState(null); // null | { selectedSet: Set<string> }
  const [batchExportProgress, setBatchExportProgress] = useState(null); // null | { current, total, currentSym, status, errors }

  // 🎨 視覺主題切換 — "stripe-dark" | "stripe-light"
  // V1.0: 完全移除舊 default 主題,只保留 Stripe 深色 / 淺色雙模
  // 舊 localStorage 值("default" / "stripe")自動 migrate 為 stripe-dark
  const [theme, setTheme] = useState(() => {
    try {
      const v = localStorage.getItem(SK.THEME);
      // migrate 舊值
      if (v === "stripe-light") return "stripe-light";
      // "stripe"(舊 V0.2)、"default"(舊)、null 一律 → stripe-dark
      return "stripe-dark";
    } catch (_) {
      return "stripe-dark";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SK.THEME, theme);
    } catch (_) {}
    // 把 theme class 掛到 body
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle(
        "theme-stripe-dark",
        theme === "stripe-dark"
      );
      document.body.classList.toggle(
        "theme-stripe-light",
        theme === "stripe-light"
      );
    }
  }, [theme]);

  // 🐞 接上全域 log 收集器
  useEffect(() => {
    debugLogListener = (logs) => setDebugLogs(logs);
    return () => {
      debugLogListener = null;
    };
  }, []);

  // ⭐️ 警報系統 - 初始載入歷史
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ALERT_HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setAlertHistory(parsed);
      }
    } catch (e) {}
  }, []);

  // ⭐️ 警報系統 - 推送 toast(同時寫入歷史)
  function pushAlert(alert) {
    // alert = { type, severity, title, message, symbol, stockName }
    const id = ++toastIdRef.current;
    const fullAlert = {
      id,
      ts: Date.now(),
      ...alert,
    };
    // 加入 toast 佇列(最多同時顯示 4 條)
    setToasts((prev) => {
      const next = [...prev, fullAlert].slice(-4);
      return next;
    });
    // 自動淡出
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
    // 寫入歷史(去重:同股票同類型 10 分鐘內不重複)
    setAlertHistory((prev) => {
      const dedupeMs = 10 * 60 * 1000;
      const isDup = prev.some(
        (a) =>
          a.symbol === fullAlert.symbol &&
          a.type === fullAlert.type &&
          Date.now() - a.ts < dedupeMs
      );
      if (isDup) return prev;
      const next = [fullAlert, ...prev].slice(0, ALERT_MAX_HISTORY);
      try {
        localStorage.setItem(ALERT_HISTORY_KEY, JSON.stringify(next));
      } catch (e) {}
      return next;
    });
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function clearAlertHistory() {
    setAlertHistory([]);
    try {
      localStorage.removeItem(ALERT_HISTORY_KEY);
    } catch (e) {}
  }

  // ⭐️ 警報系統 - 檢查觸發條件(對比舊狀態與新狀態)
  function checkAlerts(symbol, stockName, stockObj, metricsObj, fullData) {
    if (!stockObj || !metricsObj) return;
    const rsi = parseFloat(metricsObj.rsi) || 50;
    const ratingScore = metricsObj.ratingScore; // 1-6
    const ratingShort = metricsObj.ratingShort;
    const ratingClass = metricsObj.ratingClass;
    const price = stockObj.price;

    // 計算當前布林位置: 1=上軌外, 0=帶內, -1=下軌外
    let bbPos = 0;
    let bbUpper = null,
      bbLower = null;
    if (Array.isArray(fullData) && fullData.length >= 20) {
      const bb = calcBollinger(fullData, 20, 2);
      const last = bb[bb.length - 1];
      if (last && last.upper != null && last.lower != null) {
        bbUpper = last.upper;
        bbLower = last.lower;
        if (price > last.upper) bbPos = 1;
        else if (price < last.lower) bbPos = -1;
      }
    }

    const prev = alertPrevStateRef.current[symbol];
    const nameTag = stockName || symbol;

    // 首次載入此股票:只記錄狀態,不觸發
    if (!prev) {
      alertPrevStateRef.current[symbol] = {
        rsi,
        ratingScore,
        ratingShort,
        bbPos,
        price,
      };
      return;
    }

    // ─── RSI 警報 ───
    if (prev.rsi <= 80 && rsi > 80) {
      pushAlert({
        type: "rsi_extreme_overbought",
        severity: "danger",
        title: "RSI 極端超買",
        message: `${nameTag} RSI 衝破 80(${rsi.toFixed(1)}),回檔風險顯著升高`,
        symbol,
        stockName,
      });
    } else if (prev.rsi <= 70 && rsi > 70) {
      pushAlert({
        type: "rsi_overbought",
        severity: "warning",
        title: "RSI 進入超買區",
        message: `${nameTag} RSI 突破 70(${rsi.toFixed(1)}),短線過熱`,
        symbol,
        stockName,
      });
    }
    if (prev.rsi >= 20 && rsi < 20) {
      pushAlert({
        type: "rsi_extreme_oversold",
        severity: "danger",
        title: "RSI 極端超賣",
        message: `${nameTag} RSI 跌破 20(${rsi.toFixed(1)}),反彈機率提升`,
        symbol,
        stockName,
      });
    } else if (prev.rsi >= 30 && rsi < 30) {
      pushAlert({
        type: "rsi_oversold",
        severity: "warning",
        title: "RSI 進入超賣區",
        message: `${nameTag} RSI 跌破 30(${rsi.toFixed(1)}),短線超跌`,
        symbol,
        stockName,
      });
    }

    // ─── 評級變動警報 ───
    if (
      prev.ratingScore != null &&
      ratingScore != null &&
      prev.ratingScore !== ratingScore
    ) {
      if (ratingScore > prev.ratingScore) {
        pushAlert({
          type: "rating_upgrade",
          severity: "success",
          title: "評級升級 ▲",
          message: `${nameTag} 評級由 ${prev.ratingShort} → ${ratingShort}`,
          symbol,
          stockName,
        });
      } else {
        pushAlert({
          type: "rating_downgrade",
          severity: "warning",
          title: "評級降級 ▼",
          message: `${nameTag} 評級由 ${prev.ratingShort} → ${ratingShort}`,
          symbol,
          stockName,
        });
      }
    }

    // ─── 布林通道警報 ───
    if (prev.bbPos !== bbPos) {
      if (bbPos === 1 && prev.bbPos !== 1) {
        pushAlert({
          type: "bb_break_upper",
          severity: "danger",
          title: "突破布林上軌",
          message: `${nameTag} 收盤 ${fmt(price)} 突破上軌 ${
            bbUpper ? fmt(bbUpper) : ""
          },短線過熱`,
          symbol,
          stockName,
        });
      } else if (bbPos === -1 && prev.bbPos !== -1) {
        pushAlert({
          type: "bb_break_lower",
          severity: "danger",
          title: "跌破布林下軌",
          message: `${nameTag} 收盤 ${fmt(price)} 跌破下軌 ${
            bbLower ? fmt(bbLower) : ""
          },短線超跌`,
          symbol,
          stockName,
        });
      } else if (bbPos === 0 && prev.bbPos !== 0) {
        pushAlert({
          type: "bb_return",
          severity: "info",
          title: "回到布林帶內",
          message: `${nameTag} 從${
            prev.bbPos === 1 ? "上軌外" : "下軌外"
          }回歸帶內,趨勢趨於穩定`,
          symbol,
          stockName,
        });
      }
    }

    // 更新前次狀態快照
    alertPrevStateRef.current[symbol] = {
      rsi,
      ratingScore,
      ratingShort,
      bbPos,
      price,
    };
  }

  const TABS = [
    { label: "7日", days: 7 },
    { label: "1月", days: 22 },
    { label: "1季", days: 65 },
    { label: "1年", days: 250 },
    { label: "3年", days: 750 },
    { label: "5年", days: 1250 },
  ];

  useEffect(() => {
    async function fetchStockList() {
      const cached = localStorage.getItem(SK.STOCK_DICT);
      if (cached) {
        try {
          const { sMap, nMap, ts } = JSON.parse(cached);
          if (ts && Date.now() - ts < 7 * 24 * 60 * 60 * 1000) {
            setStockMap(sMap);
            setNameMap(nMap);
            return;
          }
        } catch (e) {}
      }
      try {
        const res = await fetch(
          viaProxy(finmindUrl("dataset=TaiwanStockInfo"))
        );
        const json = await res.json();
        if (json.data) {
          const sMap = {},
            nMap = {};
          json.data.forEach((item) => {
            sMap[item.stock_id] = item.stock_name;
            nMap[item.stock_name] = item.stock_id;
          });
          setStockMap(sMap);
          setNameMap(nMap);
          localStorage.setItem(
            SK.STOCK_DICT,
            JSON.stringify({ sMap, nMap, ts: Date.now() })
          );
        }
      } catch (e) {}
    }
    fetchStockList();
  }, []);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    },
    []
  );

  /* ─── ⭐️ 自選股:載入、儲存、抓資料 ─── */
  // 抓單一自選股的價格 + 迷你走勢
  async function loadWatchlistEntry(sym) {
    setWatchlistData((prev) => ({
      ...prev,
      [sym]: { ...(prev[sym] || {}), loading: true },
    }));

    // 走勢資料:優先用歷史快取,沒有才額外抓
    let spark = [];
    const cached = localStorage.getItem(SK.hist(sym));
    if (cached) {
      try {
        const p = JSON.parse(cached);
        if (p.fullData && p.fullData.length) {
          spark = p.fullData
            .slice(-45)
            .map((d) => d.close)
            .filter((v) => v > 0);
        }
      } catch (e) {}
    }
    if (spark.length < 2) {
      spark = await fetchSparkline(sym);
    }

    // 即時/最新報價
    let quote = null;
    try {
      quote = await fetchRealtimeQuote(sym);
    } catch (e) {
      dlog(`[自選 ${sym}] 報價失敗:`, e.message);
    }

    let price = null;
    let prevClose = null;
    if (quote && quote.price > 0) {
      price = quote.price;
      prevClose = quote.previousClose > 0 ? quote.previousClose : null;
    } else if (spark.length >= 1) {
      price = spark[spark.length - 1];
      prevClose = spark.length >= 2 ? spark[spark.length - 2] : null;
    }

    setWatchlistData((prev) => ({
      ...prev,
      [sym]: {
        loading: false,
        price,
        prevClose,
        spark,
        miniRating: computeMiniRating(spark),
      },
    }));
  }

  // 重新整理整份清單
  async function refreshWatchlist(list) {
    const target = list || watchlist;
    if (!target.length) return;
    setWlRefreshing(true);
    await Promise.all(target.map((item) => loadWatchlistEntry(item.sym)));
    setWlRefreshing(false);
  }

  // 寫入 localStorage + state
  function persistWatchlist(list) {
    setWatchlist(list);
    try {
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
    } catch (e) {
      dlog("[自選] 寫入 localStorage 失敗:", e.message);
    }
  }

  // 加入 / 移除目前個股
  function toggleWatchlist() {
    if (!stock) return;
    const sym = stock.symbol;
    const exists = watchlist.some((w) => w.sym === sym);
    if (exists) {
      persistWatchlist(watchlist.filter((w) => w.sym !== sym));
    } else {
      const name = stockMap[sym] || sym;
      const next = [...watchlist, { sym, name }];
      persistWatchlist(next);
      loadWatchlistEntry(sym);
    }
  }

  function removeFromWatchlist(sym) {
    persistWatchlist(watchlist.filter((w) => w.sym !== sym));
    setWatchlistData((prev) => {
      const next = { ...prev };
      delete next[sym];
      return next;
    });
  }

  // 啟動時讀取自選清單並抓資料
  useEffect(() => {
    let list = [];
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          list = parsed.filter((x) => x && x.sym);
        }
      }
    } catch (e) {}
    if (list.length) {
      setWatchlist(list);
      refreshWatchlist(list);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inWatchlist = stock
    ? watchlist.some((w) => w.sym === stock.symbol)
    : false;

  /* ─── ⭐️ 搜尋自動完成 ─── */
  function computeSuggestions(q) {
    if (!q || q.trim().length < 1) {
      setSuggestions([]);
      return;
    }
    const results = [];
    const seen = new Set();
    // 1. 代碼前綴優先 (數字/英文)
    for (const [sym, name] of Object.entries(stockMap)) {
      if (sym.startsWith(q)) {
        results.push({ sym, name });
        seen.add(sym);
        if (results.length >= 4) break;
      }
    }
    // 2. 公司名稱包含
    for (const [name, sym] of Object.entries(nameMap)) {
      if (!seen.has(sym) && name.includes(q)) {
        results.push({ sym, name });
        seen.add(sym);
        if (results.length >= 8) break;
      }
    }
    setSuggestions(results.slice(0, 8));
    setSuggFocused(-1);
  }

  function selectSuggestion(item) {
    setSuggestions([]);
    setShowSugg(false);
    setSuggFocused(-1);
    setInput(item.sym);
    search(item.sym);
  }

  // 點外部關閉建議下拉
  useEffect(() => {
    function handleClickOutside(e) {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) {
        setShowSugg(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // ⭐️ 全域鍵盤快捷鍵
  //   /  → 聚焦搜尋框
  //   g  → 展開 Top10 並滾入視野
  //   p  → 展開投資組合並滾入視野
  //   Esc→ 依序關閉:評等報告 modal、匯出 modal、警報歷史
  // 規則:
  //   - 若使用者正在 input / textarea / contenteditable 中,只接收 Esc
  //     (避免打字時誤觸,Esc 用來退出輸入)
  //   - 修飾鍵 (Cmd/Ctrl/Alt) 一律不接,避免覆蓋瀏覽器快捷
  //   - 用 ref 鎖住 modal state,避免 modal 開關時 listener 反覆 rebind
  const modalStateRef = useRef({
    showRatingModal: false,
    stockExportModal: null,
    alertHistoryOpen: false,
  });
  useEffect(() => {
    modalStateRef.current = {
      showRatingModal,
      stockExportModal,
      alertHistoryOpen,
    };
  }, [showRatingModal, stockExportModal, alertHistoryOpen]);

  useEffect(() => {
    function handleKey(e) {
      // 修飾鍵組合一律不接
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target;
      const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
      const isTyping =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (target && target.isContentEditable);

      // Escape:全狀態下都生效
      if (e.key === "Escape") {
        const m = modalStateRef.current;
        // 依序關閉:評等 modal > 匯出 modal > 警報歷史 > 輸入聚焦
        if (m.showRatingModal) {
          setShowRatingModal(false);
          return;
        }
        if (m.stockExportModal) {
          setStockExportModal(null);
          return;
        }
        if (m.alertHistoryOpen) {
          setAlertHistoryOpen(false);
          return;
        }
        // 都沒開的話,如果正在輸入就 blur (退出輸入)
        if (isTyping && target.blur) {
          target.blur();
        }
        return;
      }

      // 其他快捷鍵:若正在輸入則不處理
      if (isTyping) return;

      if (e.key === "/") {
        e.preventDefault();
        if (searchInputRef.current) {
          searchInputRef.current.focus();
          searchInputRef.current.select && searchInputRef.current.select();
        }
        return;
      }

      // g/G 跳 Top10
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("quant:open-top10"));
        return;
      }

      // p/P 跳組合
      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("quant:open-portfolio"));
        return;
      }

      // h/H 跳熱力地圖
      if (e.key === "h" || e.key === "H") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("quant:open-heatmap"));
        return;
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  // ⭐️ 偵測股價變動 → 觸發跳動閃光
  useEffect(() => {
    if (!stock || stock.price == null) {
      prevPriceRef.current = null;
      return;
    }
    const prev = prevPriceRef.current;
    // 換股(symbol 不同)時不閃,只記錄
    if (
      prev != null &&
      prev.symbol === stock.symbol &&
      prev.price !== stock.price
    ) {
      const dir = stock.price > prev.price ? "up" : "down";
      setPriceFlash(dir);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setPriceFlash(null), 700);
    }
    prevPriceRef.current = { symbol: stock.symbol, price: stock.price };
  }, [stock]);

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    []
  );

  // 鎖定 body 滾動當 modal 開啟
  useEffect(() => {
    if (showRatingModal) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [showRatingModal]);

  function processFinMindData(raw) {
    let r = raw
      .map((x) => ({
        date: x.date,
        close: Number(x.close) || 0,
        open: Number(x.open) || 0,
        high: Number(x.max) || 0,
        low: Number(x.min) || 0,
        volume: Math.round(Number(x.Trading_Volume) / 1000) || 0,
      }))
      .filter((x) => x.close > 0);
    if (r.length === 0) return [];

    let ratio = 1.0;
    for (let i = r.length - 1; i > 0; i--) {
      const today = r[i],
        yest = r[i - 1];
      const diff = Math.abs(today.close - yest.close) / yest.close;
      if (diff > 0.15) ratio *= today.close / yest.close;
      yest.adjClose = yest.close * ratio;
      yest.adjRatio = ratio;
    }
    r[r.length - 1].adjClose = r[r.length - 1].close;
    r[r.length - 1].adjRatio = 1.0;
    return r.map((d) => {
      const ar = d.adjRatio || 1.0;
      return {
        date: d.date,
        rawClose: d.close,
        close: d.adjClose || d.close,
        // 開高低也做還原權值調整,K 棒才不會跳掉
        open: (d.open || d.close) * ar,
        high: (d.high || d.close) * ar,
        low: (d.low || d.close) * ar,
        volume: d.volume,
      };
    });
  }

  function executeEngine(symbol, fullData, perJson, realtimeQuote) {
    if (!fullData || fullData.length === 0) return;
    const closes = fullData.map((r) => r.close);
    const rawCloses = fullData.map((r) => r.rawClose);
    const last = fullData[fullData.length - 1];
    const prev = fullData[fullData.length - 2] || last;

    let currentPrice = last.rawClose;
    let currentVolume = last.volume;
    let isRealtime = false;
    let realtimeSource = "";
    let prevClose = prev.rawClose;
    let dataTime = null;

    if (realtimeQuote && realtimeQuote.price > 0) {
      currentPrice = realtimeQuote.price;
      if (realtimeQuote.volume > 0) currentVolume = realtimeQuote.volume;
      if (realtimeQuote.previousClose > 0)
        prevClose = realtimeQuote.previousClose;
      isRealtime = true;
      realtimeSource = realtimeQuote.source;
      dataTime = realtimeQuote.dataTime;
    }

    const chgAmount = currentPrice - prevClose;
    const chgPct = (chgAmount / prevClose) * 100;
    const last250 = rawCloses.slice(-250);
    const w52H = Math.max(...last250, currentPrice);
    const w52L = Math.min(...last250, currentPrice);

    let per = "—",
      eps = "—";
    if (perJson?.data?.length > 0) {
      const latestPER = Number(perJson.data[perJson.data.length - 1].PER);
      if (!isNaN(latestPER) && latestPER > 0) {
        per = latestPER.toFixed(2);
        eps = (currentPrice / latestPER).toFixed(2);
      }
    }

    const compName = stockMap[symbol] || "";
    const fullName = compName ? `${compName} ${symbol}.TW` : `${symbol}.TW`;
    const updatedCloses = isRealtime
      ? [...closes.slice(0, -1), currentPrice]
      : closes;

    const stockData = {
      symbol,
      name: fullName,
      price: currentPrice,
      chg: chgAmount,
      chgPct,
      volume: currentVolume,
      rsi: calculateRSI(updatedCloses, 14),
      closes: updatedCloses,
      fullData,
      isRealtime,
      realtimeSource,
      dataTime,
    };
    const fundData = {
      w52H,
      w52L,
      per,
      eps,
      marketCap: MOCK_MARKET_CAP[symbol] || "—",
    };

    setStock(stockData);
    setFullChartData(fullData);
    setFundamentals(fundData);

    const result = generateAnalysis(stockData, fundData);
    setMetrics(result);

    // ⭐️ 警報檢查 — 切股票完成時
    checkAlerts(symbol, compName, stockData, result, fullData);

    let i = 0;
    const maxLen = Math.max(
      result.technical.length,
      result.valuation.length,
      result.strategy.length
    );
    const iv = setInterval(() => {
      setAnalysisContent({
        technical: result.technical.slice(0, i),
        valuation: result.valuation.slice(0, i),
        strategy: result.strategy.slice(0, i),
      });
      i += 2;
      if (i > maxLen) clearInterval(iv);
    }, 5);
  }

  function startAutoRefresh(symbol) {
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    currentSymbolRef.current = symbol;
    // ⭐️ 收盤時不啟動自動刷新(節省 API 配額)
    if (!isMarketOpen()) {
      dlog(`[自動刷新] 市場已收盤,不啟動 10 秒輪詢 (symbol=${symbol})`);
      return;
    }
    dlog(`[自動刷新] 市場開盤中,啟動 10 秒輪詢 (symbol=${symbol})`);
    refreshTimerRef.current = setInterval(async () => {
      if (currentSymbolRef.current !== symbol) return;
      // ⭐️ 跨過收盤時間後自動停止輪詢
      if (!isMarketOpen()) {
        dlog(`[自動刷新] 偵測到收盤,停止 ${symbol} 輪詢`);
        if (refreshTimerRef.current) {
          clearInterval(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
        return;
      }
      const quote = await fetchRealtimeQuote(symbol);
      if (quote) {
        setRefreshCount((c) => c + 1);
        let nextStockData = null;
        setStock((prev) => {
          if (!prev || prev.symbol !== symbol) return prev;
          const closes = prev.closes || [];
          const lastIdx = closes.length - 1;
          const prevClose =
            quote.previousClose || closes[lastIdx - 1] || prev.price;
          const newPrice = quote.price;
          const updatedCloses = [...closes];
          if (lastIdx >= 0) updatedCloses[lastIdx] = newPrice;
          const next = {
            ...prev,
            price: newPrice,
            chg: newPrice - prevClose,
            chgPct: ((newPrice - prevClose) / prevClose) * 100,
            volume: quote.volume > 0 ? quote.volume : prev.volume,
            rsi: calculateRSI(updatedCloses, 14),
            closes: updatedCloses,
            isRealtime: true,
            realtimeSource: quote.source,
            dataTime: quote.dataTime,
          };
          nextStockData = next;
          return next;
        });

        // ⭐️ 自動更新時也重算 metrics 並檢查警報
        if (nextStockData && fundamentals) {
          // 同步更新 fullChartData 最後一筆價格,讓布林通道判斷使用最新價
          let updatedFullData = fullChartData;
          if (Array.isArray(fullChartData) && fullChartData.length > 0) {
            updatedFullData = [...fullChartData];
            const lastIdx = updatedFullData.length - 1;
            updatedFullData[lastIdx] = {
              ...updatedFullData[lastIdx],
              close: quote.price,
            };
            setFullChartData(updatedFullData);
          }
          const result = generateAnalysis(nextStockData, fundamentals);
          setMetrics(result);
          const compName = stockMap[symbol] || "";
          checkAlerts(symbol, compName, nextStockData, result, updatedFullData);
        }
      }
    }, 10000);
  }

  async function search(sym) {
    let query = (sym || input).trim();
    if (!query) return;
    setLoading(true);
    setError("");
    setTimeRange(250);
    setAnalysisContent({ technical: "", valuation: "", strategy: "" });
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);

    // ⭐️ 開始新查詢前,先清空上一支股票的殘留資料
    function clearStaleData() {
      setStock(null);
      setMetrics(null);
      setFundamentals(null);
      setFullChartData([]);
    }

    let symbol = query;
    if (nameMap[query]) symbol = nameMap[query];
    else if (!/^\d+$/.test(query)) {
      const matched = Object.keys(nameMap).find((n) => n.includes(query));
      if (matched) symbol = nameMap[matched];
      else {
        clearStaleData();
        setError("找不到相符的股票或代碼");
        setLoading(false);
        return;
      }
    }
    currentSymbolRef.current = symbol;

    const cacheKey = SK.hist(symbol);
    const cached = localStorage.getItem(cacheKey);
    const now = Date.now();
    let historicalData = null,
      perJson = null;
    if (cached) {
      try {
        const p = JSON.parse(cached);
        if (now - p.timestamp < 6 * 60 * 60 * 1000) {
          historicalData = p.fullData;
          perJson = p.perJson;
        }
      } catch (e) {
        localStorage.removeItem(cacheKey);
      }
    }

    try {
      const promises = [];
      if (!historicalData) {
        const startDate = new Date(now - 1825 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0];
        const priceUrl = viaProxy(
          finmindUrl(
            `dataset=TaiwanStockPrice&data_id=${symbol}&start_date=${startDate}`
          )
        );
        const perUrl = viaProxy(
          finmindUrl(
            `dataset=TaiwanStockPER&data_id=${symbol}&start_date=${
              new Date(now - 14 * 86400000).toISOString().split("T")[0]
            }`
          )
        );
        promises.push(
          fetch(priceUrl)
            .then((r) => r.json())
            .then((j) => ({ type: "price", data: j }))
        );
        promises.push(
          fetch(perUrl)
            .then((r) => r.json())
            .then((j) => ({ type: "per", data: j }))
            .catch(() => ({ type: "per", data: { data: [] } }))
        );
      }
      promises.push(
        fetchRealtimeQuote(symbol).then((q) => ({ type: "realtime", data: q }))
      );
      const results = await Promise.all(promises);

      let realtimeQuote = null;
      for (const r of results) {
        if (r.type === "price") {
          if (!r.data.data || r.data.data.length < 20) {
            // ⭐️ 查無資料 → 清空舊資料再報錯
            clearStaleData();
            throw new Error(`查無 ${symbol} 足夠數據,請確認代碼是否正確。`);
          }
          historicalData = processFinMindData(r.data.data);
        } else if (r.type === "per") perJson = r.data;
        else if (r.type === "realtime") realtimeQuote = r.data;
      }
      executeEngine(symbol, historicalData, perJson, realtimeQuote);
      localStorage.setItem(
        cacheKey,
        JSON.stringify({ timestamp: now, fullData: historicalData, perJson })
      );
      startAutoRefresh(symbol);
      setViewMode("research");
      setLoading(false);
    } catch (e) {
      clearStaleData();
      setError(e.message || "載入失敗,請稍後再試。");
      setLoading(false);
    }
  }

  // 🌟 自選股批次匯出主邏輯
  // 策略:逐檔切 stock state → 等資料載入 + DOM 渲染 → 截圖 → 自動下載
  // 失敗只影響單檔,其他繼續
  // v10: 整段流程強制展開所有摺疊面板(籌碼/同業/新聞/警報/評等/量化分析全部)
  async function runBatchExport(symbols) {
    if (!symbols || !symbols.length) return;
    const total = symbols.length;
    const errors = [];
    const originalSymbol = stock?.symbol || null;

    // v10: 進入批次模式 → 開展開
    setStockExportForceExpandAll(true);
    setStockExportAllTabs(true);

    setBatchExportProgress({
      current: 0,
      total,
      currentSym: "",
      status: "starting",
      errors: [],
    });

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const name = stockMap[sym] || sym;

      setBatchExportProgress({
        current: i,
        total,
        currentSym: sym,
        status: "loading",
        errors: [...errors],
      });

      try {
        // 1. 觸發切股
        await search(sym);

        // 2. 等資料就緒 + DOM 兩輪渲染(setState 隊列 + sparkline 之類的副作用)
        //    v10: 延長到 1200ms,讓同業比較面板的 fetchMarketDailyChange 能完成
        //    (有 30 分鐘快取,真正打 API 只有第一檔會慢)
        await new Promise((r) => setTimeout(r, 1200));
        await new Promise((r) => requestAnimationFrame(() => r()));
        await new Promise((r) => requestAnimationFrame(() => r()));

        // 3. 找匯出 target
        const el = stockExportRef.current;
        if (!el) throw new Error("找不到匯出目標元素");

        setBatchExportProgress({
          current: i,
          total,
          currentSym: sym,
          status: "exporting",
          errors: [...errors],
        });

        // 4. 截圖 + 輸出 PDF(複用既有函式,batch 用乾淨選項:不展開、不隱藏)
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const fname = `QUANTEDGE_${sym}_${name}_${ts.getFullYear()}${pad(
          ts.getMonth() + 1
        )}${pad(ts.getDate())}.pdf`;

        await exportElementAsPDF(el, fname, {
          tag: `${sym} · BATCH EXPORT`,
        });

        // 5. 兩檔之間留 500ms 緩衝,避免瀏覽器擋連續下載
        if (i < symbols.length - 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) {
        dlog(`[批次匯出] ${sym} 失敗: ${e?.message || e}`);
        errors.push({ sym, name, msg: e?.message || String(e) });
      }
    }

    // 完成
    setBatchExportProgress({
      current: total,
      total,
      currentSym: "",
      status: "done",
      errors,
    });

    // v10: 收尾關閉強制展開
    setStockExportForceExpandAll(false);
    setStockExportAllTabs(false);

    // 3 秒後自動關閉進度面板(若沒錯誤)
    if (!errors.length) {
      setTimeout(() => {
        setBatchExportProgress(null);
      }, 2000);
    }

    // 切回原本的股(讓使用者體驗連貫)
    if (originalSymbol && originalSymbol !== symbols[symbols.length - 1]) {
      try {
        await search(originalSymbol);
      } catch {}
    }
  }

  function formatRealDataTime(epochMs) {
    if (!epochMs) return "";
    return new Date(epochMs).toLocaleString("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  return (
    <div className="premium-app">
      <div className="bg-grid"></div>
      <div className="bg-glow"></div>

      {/* 🎨 主題切換 — 右上角浮動(stripe-dark ↔ stripe-light) */}
      <button
        className="theme-toggle"
        onClick={() =>
          setTheme((t) =>
            t === "stripe-dark" ? "stripe-light" : "stripe-dark"
          )
        }
        title={theme === "stripe-dark" ? "切換到淺色模式" : "切換到深色模式"}
        aria-label="切換視覺主題"
      >
        <span className="theme-toggle-icon">
          {theme === "stripe-dark" ? "☾" : "☀"}
        </span>
        <span className="theme-toggle-label">
          {theme === "stripe-dark" ? "DARK" : "LIGHT"}
        </span>
      </button>

      {/* ⭐️ Toast 警報容器 - 頂部置中 */}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.severity}`}>
              <div className="toast-icon">
                {t.severity === "danger" && "⚠"}
                {t.severity === "warning" && "▲"}
                {t.severity === "success" && "✓"}
                {t.severity === "info" && "ⓘ"}
              </div>
              <div className="toast-body">
                <div className="toast-title">{t.title}</div>
                <div className="toast-msg">{t.message}</div>
              </div>
              <button
                className="toast-close"
                onClick={() => dismissToast(t.id)}
                aria-label="關閉"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="premium-container">
        <header className="header">
          <div className="header-decoration">
            <span className="decor-line"></span>
            <span className="decor-diamond">◆</span>
            <span className="decor-line"></span>
          </div>
          <h1 className="logo">
            QUANT<span className="gold-text">EDGE</span>
          </h1>
          <p
            className="subtitle subtitle-pro"
            onClick={cycleSlogan}
            title="點擊切換 slogan"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                cycleSlogan();
              }
            }}
          >
            <span className="subtitle-head">{SLOGANS[sloganIdx].head}</span>
            <span className="subtitle-sep">·</span>
            <span className="subtitle-tail">{SLOGANS[sloganIdx].tail}</span>
          </p>
        </header>

        <div className="search-wrap" ref={searchWrapRef}>
          <div className="search-box">
            <input
              ref={searchInputRef}
              placeholder="輸入代碼或公司名 (如: 0050 或 台積電)"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                computeSuggestions(e.target.value);
                setShowSugg(true);
              }}
              onFocus={() => {
                if (suggestions.length > 0) setShowSugg(true);
              }}
              onKeyDown={(e) => {
                if (!showSugg || suggestions.length === 0) {
                  if (e.key === "Enter") search();
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSuggFocused((i) =>
                    Math.min(i + 1, suggestions.length - 1)
                  );
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSuggFocused((i) => Math.max(i - 1, -1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (suggFocused >= 0 && suggestions[suggFocused]) {
                    selectSuggestion(suggestions[suggFocused]);
                  } else {
                    setShowSugg(false);
                    setSuggestions([]);
                    search();
                  }
                } else if (e.key === "Escape") {
                  setShowSugg(false);
                  setSuggestions([]);
                }
              }}
            />
            <button
              onClick={() => {
                setShowSugg(false);
                setSuggestions([]);
                search();
              }}
              disabled={loading}
              className="btn-gold"
            >
              {loading ? <div className="spinner"></div> : "EXECUTE"}
            </button>
          </div>

          {showSugg && suggestions.length > 0 && (
            <div className="sugg-dropdown">
              {suggestions.map((item, idx) => (
                <div
                  key={item.sym}
                  className={`sugg-item ${
                    suggFocused === idx ? "focused" : ""
                  }`}
                  onMouseDown={() => selectSuggestion(item)}
                  onMouseEnter={() => setSuggFocused(idx)}
                >
                  <span className="sugg-sym">{item.sym}</span>
                  <span className="sugg-name">{item.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 📊 Dashboard 模式:四大主面板區(熱力圖+Top10+組合+選股器)
            僅在 viewMode === "dashboard" 顯示,進場帶入場動畫 */}
        {viewMode === "dashboard" && (
          <div
            className="dashboard-panels view-anim-enter"
            key="dashboard-panels"
          >
            {/* ⭐️⭐️⭐️ 市場熱力地圖 (預設摺疊,點開觸發載入) ⭐️⭐️⭐️ */}
            <HeatmapPanel
              stockMap={stockMap}
              watchlist={watchlist}
              onPickSymbol={(sym) => {
                setInput(sym);
                search(sym);
              }}
              onToggleWatch={(sym) => {
                const exists = watchlist.some((w) => w.sym === sym);
                if (exists) {
                  persistWatchlist(watchlist.filter((w) => w.sym !== sym));
                } else {
                  const name = stockMap[sym] || sym;
                  persistWatchlist([...watchlist, { sym, name }]);
                }
              }}
            />

            {/* ⭐️⭐️⭐️ Top10 投資標的排行 (D 方案,預設摺疊) ⭐️⭐️⭐️ */}
            <Top10Panel
              stockMap={stockMap}
              onPickSymbol={(sym) => {
                setInput(sym);
                search(sym);
              }}
            />

            {/* ⭐️⭐️⭐️ 投資組合模擬器 (預設摺疊) ⭐️⭐️⭐️ */}
            <PortfolioPanel
              stockMap={stockMap}
              onPickSymbol={(sym) => {
                setInput(sym);
                search(sym);
              }}
            />

            {/* 🔍 智能選股器 (預設摺疊) */}
            <ScreenerPanel
              stockMap={stockMap}
              watchlist={watchlist}
              onPickSymbol={(sym) => {
                setInput(sym);
                search(sym);
              }}
            />
          </div>
        )}

        {/* 🐞 螢幕除錯面板 — 顯示抓資料的每一步 */}
        <div className="debug-panel">
          <div className="debug-header">
            <span className="debug-title">🐞 DEBUG 除錯面板</span>
            <button
              className="debug-toggle"
              onClick={() => setShowDebug(!showDebug)}
            >
              {showDebug ? "隱藏 ▲" : "展開 ▼"}
            </button>
          </div>
          {showDebug && (
            <div className="debug-body">
              {debugLogs.length === 0 ? (
                <div className="debug-empty">尚無紀錄,請搜尋一支股票...</div>
              ) : (
                debugLogs.map((log, i) => (
                  <div key={i} className="debug-line">
                    <span className="debug-time">{log.time}</span>
                    <span
                      className={`debug-msg ${
                        log.msg.includes("✅")
                          ? "ok"
                          : log.msg.includes("error") ||
                            log.msg.includes("HTTP") ||
                            log.msg.includes("失敗") ||
                            log.msg.includes("為空") ||
                            log.msg.includes("無效") ||
                            log.msg.includes("無有效")
                          ? "err"
                          : ""
                      }`}
                    >
                      {log.msg}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="quick-picks">
          {TW_PICKS.map((p) => (
            <span
              key={p.sym}
              onClick={() => {
                setInput(p.sym);
                search(p.sym);
              }}
            >
              <span className="pick-label">{p.label}</span>
              <span className="pick-sym">{p.sym}</span>
            </span>
          ))}
        </div>

        {/* 📊 Dashboard 模式:自選股大卡(取代原本迷你卡片區塊) */}
        {viewMode === "dashboard" && (
          <div className="wld-section view-anim-enter" key="wld-section">
            <div className="wld-section-header">
              <div className="wld-section-title-group">
                <span className="wld-section-eyebrow">WATCHLIST · 自選股</span>
                <h3 className="wld-section-title">
                  我的自選股
                  {watchlist.length > 0 && (
                    <span className="wld-section-count">
                      {watchlist.length}
                    </span>
                  )}
                </h3>
              </div>
              {watchlist.length > 0 && (
                <div className="wld-section-actions">
                  <button
                    className="wl-batch-btn"
                    onClick={() => setBatchExportModal({})}
                    disabled={!watchlist.length || !!batchExportProgress}
                    title="批次匯出自選股為 PDF"
                  >
                    📄 批次匯出
                  </button>
                  <button
                    className="wl-refresh-btn"
                    onClick={() => refreshWatchlist()}
                    disabled={wlRefreshing}
                  >
                    {wlRefreshing ? (
                      <>
                        <span className="wl-refresh-spin">↻</span> 同步中
                      </>
                    ) : (
                      <>↻ 重新整理</>
                    )}
                  </button>
                </div>
              )}
            </div>
            {watchlist.length === 0 ? (
              <div className="wld-empty">
                <div className="wld-empty-icon">⭐</div>
                <div className="wld-empty-title">尚未加入任何自選股</div>
                <div className="wld-empty-hint">
                  搜尋任一支股票後,點「加入自選」即可在此快速追蹤
                </div>
              </div>
            ) : (
              <div className="wld-grid">
                {watchlist.map((item) => {
                  const cutoff = Date.now() - 86400000;
                  const alertCount = alertHistory.filter(
                    (a) => a.symbol === item.sym && a.ts >= cutoff
                  ).length;
                  return (
                    <WatchlistDashboardCard
                      key={item.sym}
                      item={item}
                      data={watchlistData[item.sym]}
                      alertCount={alertCount}
                      onOpen={(sym) => {
                        setInput(sym);
                        search(sym);
                      }}
                      onRemove={removeFromWatchlist}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {error && <div className="error-msg">{error}</div>}
        {loading && !error && (
          <div className="loading-msg">
            <span className="dot">●</span>
            <span className="dot">●</span>
            <span className="dot">●</span>
            市場數據庫連線同步中
          </div>
        )}

        {viewMode === "research" &&
          stock &&
          !loading &&
          metrics &&
          fundamentals && (
            <div
              className="terminal-card view-anim-enter stagger-parent"
              ref={stockExportRef}
            >
              <div className="card-header">
                <div className="asset-info">
                  <button
                    className="back-to-dashboard-btn"
                    onClick={() => setViewMode("dashboard")}
                    title="返回儀表板"
                  >
                    <span className="back-arrow">←</span>
                    <span>Dashboard</span>
                  </button>
                  <h2 className="stock-title">{stock.name}</h2>
                  <div className="data-status">
                    {stock.isRealtime ? (
                      <span className="badge-live">
                        <span className="live-dot"></span>LIVE ·{" "}
                        {stock.realtimeSource}
                      </span>
                    ) : (
                      <span className="badge-delayed">◐ 歷史收盤</span>
                    )}
                    {stock.dataTime && (
                      <span className="timestamp-text">
                        {formatRealDataTime(stock.dataTime)}
                      </span>
                    )}
                  </div>
                  <div className="refresh-info">
                    {isMarketOpen() ? (
                      <>
                        <span className="refresh-dot"></span>盤中 · 每 10
                        秒自動同步 (已刷新 {refreshCount} 次)
                      </>
                    ) : (
                      "✦ 市場已收盤,顯示最後成交資料"
                    )}
                  </div>
                </div>
                <div className="price-info">
                  <div
                    className={`price-value ${stock.chg >= 0 ? "up" : "down"} ${
                      priceFlash ? `flash-${priceFlash}` : ""
                    }`}
                  >
                    <AnimatedNumber value={stock.price} decimals={2} />
                    {priceFlash && (
                      <span className={`tick-arrow ${priceFlash}`}>
                        {priceFlash === "up" ? "▲" : "▼"}
                      </span>
                    )}
                  </div>
                  <div
                    className={`price-change ${stock.chg >= 0 ? "up" : "down"}`}
                  >
                    {stock.chg >= 0 ? "▲" : "▼"}{" "}
                    <AnimatedNumber value={Math.abs(stock.chg)} decimals={2} />{" "}
                    (
                    <AnimatedNumber
                      value={stock.chgPct}
                      decimals={2}
                      signed={true}
                      suffix="%"
                    />
                    )
                  </div>
                  {/* ── 加入自選 + 匯出 PDF 並排,中間留間距 ── */}
                  <div className="price-info-actions">
                    <button
                      className={`watch-toggle ${inWatchlist ? "active" : ""}`}
                      onClick={toggleWatchlist}
                    >
                      <span className="watch-star">
                        {inWatchlist ? "★" : "☆"}
                      </span>
                      {inWatchlist ? "已加入自選" : "加入自選"}
                    </button>
                    <ExportButtons
                      targetRef={stockExportRef}
                      baseName={`QUANTEDGE_${stock.symbol}_${stock.name}`}
                      tag={`${stock.symbol} · RESEARCH`}
                      compact
                      onBeforeExport={() => {
                        return new Promise((resolve) => {
                          setStockExportModal({
                            onConfirm: async (opts) => {
                              setStockExportModal(null);
                              // v10: 一律展開所有摺疊面板(籌碼/同業/新聞/警報/評等)
                              // 同業比較需要時間拉 API,給 800ms 緩衝
                              setStockExportForceExpandAll(true);
                              if (opts.expandAnalysis) {
                                setStockExportAllTabs(true);
                              }
                              // 等同業比較載入完成 + layout settle
                              await new Promise((r) => setTimeout(r, 800));
                              resolve({
                                hiddenSelectors: opts.hiddenSelectors,
                                sectionSelectors: opts.sectionSelectors,
                              });
                            },
                            onCancel: () => {
                              setStockExportModal(null);
                              resolve(false);
                            },
                          });
                        });
                      }}
                      onAfterExport={() => {
                        setStockExportAllTabs(false);
                        setStockExportForceExpandAll(false);
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="fundamentals-grid">
                <div className="fund-box">
                  <span className="fund-label">52週最高</span>
                  <span className="fund-value">{fmt(fundamentals.w52H)}</span>
                </div>
                <div className="fund-box">
                  <span className="fund-label">52週最低</span>
                  <span className="fund-value">{fmt(fundamentals.w52L)}</span>
                </div>
                <div className="fund-box">
                  <span className="fund-label">本益比</span>
                  <span className="fund-value">{fundamentals.per}</span>
                </div>
                <div className="fund-box">
                  <span className="fund-label">EPS</span>
                  <span className="fund-value">{fundamentals.eps}</span>
                </div>
                <div className="fund-box">
                  <span className="fund-label">市值</span>
                  <span className="fund-value">{fundamentals.marketCap}</span>
                </div>
              </div>

              <div className="time-tabs">
                {TABS.map((t) => {
                  const isValid = fullChartData.length >= t.days * 0.5;
                  return (
                    <button
                      key={t.label}
                      className={`time-btn ${
                        timeRange === t.days ? "active" : ""
                      } ${!isValid ? "disabled" : ""}`}
                      onClick={() => isValid && setTimeRange(t.days)}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>

              <div className="chart-area">
                <InteractiveChart
                  fullData={fullChartData}
                  rangeDays={timeRange}
                />
              </div>

              {/* ⭐️⭐️⭐️ B 個股基本面三件套 ⭐️⭐️⭐️ */}
              <RevenuePanel
                symbol={stock.symbol}
                candles={fullChartData}
                forceExpand={stockExportForceExpandAll}
              />
              <DividendPanel
                symbol={stock.symbol}
                candles={fullChartData}
                forceExpand={stockExportForceExpandAll}
              />
              <EPSPanel
                symbol={stock.symbol}
                forceExpand={stockExportForceExpandAll}
              />

              {/* ⭐️⭐️⭐️ 全新升級的量化評級面板 ⭐️⭐️⭐️ */}
              <div className="rating-panel">
                <div className="rating-panel-header">
                  <div className="rating-panel-title-group">
                    <span className="rating-panel-eyebrow">
                      QUANTITATIVE RATING
                    </span>
                    <h3 className="rating-panel-title">機構級量化評等</h3>
                  </div>
                  <div className="rating-header-right">
                    <button
                      className="info-btn-large"
                      onClick={() => setShowRatingModal(true)}
                    >
                      <span>ⓘ</span>
                      <span className="info-btn-text">查看完整報告</span>
                    </button>
                    <button
                      className="panel-collapse-btn"
                      onClick={() => setRatingOpen((o) => !o)}
                      title={ratingOpen ? "收合" : "展開"}
                    >
                      <span
                        className={`panel-chevron ${ratingOpen ? "open" : ""}`}
                      >
                        ›
                      </span>
                    </button>
                  </div>
                </div>

                <div
                  className={`panel-body ${
                    ratingOpen || stockExportForceExpandAll ? "open" : ""
                  }`}
                >
                  <div className="panel-body-inner">
                    <div className="rating-main-display">
                      <div className="rating-left">
                        <div
                          className={`rating-shield stamp-anim ${metrics.ratingClass}`}
                          key={`shield-${stock.symbol}-${metrics.ratingClass}`}
                        >
                          <div className="shield-shorttag">
                            {metrics.ratingShort}
                          </div>
                          <div className="shield-cn">{metrics.rating}</div>
                        </div>
                        <StarRating stars={metrics.ratingStars} />
                        <div className="rating-score-line">
                          <span className="rating-score-label">綜合分數</span>
                          <AnimatedNumber
                            className="rating-score-value"
                            value={metrics.compositeScore}
                            decimals={1}
                          />
                          <span className="rating-score-unit">/ 100</span>
                        </div>
                        <div className="rating-confidence">
                          <span className="conf-label">因子共識度</span>
                          <span
                            className={`conf-value ${
                              metrics.confidence === "高度共識"
                                ? "high"
                                : metrics.confidence === "中度共識"
                                ? "mid"
                                : "low"
                            }`}
                          >
                            ● {metrics.confidence}
                          </span>
                        </div>
                      </div>
                      <div className="rating-right">
                        <FactorRadar factors={metrics.factors} />
                      </div>
                    </div>

                    <div className="rating-factor-bars">
                      {[
                        { key: "momentum", label: "動能", en: "MOMENTUM" },
                        { key: "value", label: "估值", en: "VALUE" },
                        { key: "quality", label: "品質", en: "QUALITY" },
                        { key: "trend", label: "趨勢", en: "TREND" },
                      ].map((f) => (
                        <div key={f.key} className="factor-bar-row">
                          <div className="factor-bar-label">
                            <span className="fbl-cn">{f.label}</span>
                            <span className="fbl-en">{f.en}</span>
                          </div>
                          <div className="factor-bar-track">
                            <div
                              className="factor-bar-fill"
                              style={{ width: `${metrics.factors[f.key]}%` }}
                            ></div>
                          </div>
                          <div className="factor-bar-score">
                            {Math.round(metrics.factors[f.key])}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* ⭐️ 量化分析報告 */}
              <div className="qa-panel">
                <div className="qa-header">
                  <div className="qa-title-group">
                    <span className="qa-eyebrow">QUANTITATIVE ANALYSIS</span>
                    <div className="qa-title">量化分析報告</div>
                  </div>
                  <button
                    className="qa-toggle"
                    onClick={() => setAnalysisOpen((o) => !o)}
                    aria-label={analysisOpen ? "收合" : "展開"}
                  >
                    <span
                      className={`qa-chevron ${analysisOpen ? "open" : ""}`}
                    >
                      ›
                    </span>
                  </button>
                </div>
                {(analysisOpen || stockExportForceExpandAll) && (
                  <div className="qa-body">
                    <AnalysisTabs
                      metrics={metrics}
                      fullData={fullChartData}
                      fundamentals={fundamentals}
                      symbol={stock.symbol}
                      forceShowAll={
                        stockExportAllTabs || stockExportForceExpandAll
                      }
                    />
                  </div>
                )}
              </div>

              {/* ⭐️⭐️⭐️ 法人籌碼面板 ⭐️⭐️⭐️ */}
              <InstitutionalPanel
                symbol={stock.symbol}
                forceExpand={stockExportForceExpandAll}
              />

              {/* ⭐️⭐️⭐️ 相關新聞 ⭐️⭐️⭐️ */}
              <NewsPanel
                symbol={stock.symbol}
                stockName={stockMap[stock.symbol] || ""}
                forceExpand={stockExportForceExpandAll}
              />

              {/* 🏢 同產業比較 */}
              <IndustryComparePanel
                symbol={stock.symbol}
                stockName={stockMap[stock.symbol] || ""}
                onPickSymbol={(sym) => {
                  setInput(sym);
                  search(sym);
                }}
                forceExpand={stockExportForceExpandAll}
              />

              {/* ⭐️⭐️⭐️ 警報歷史 ⭐️⭐️⭐️ */}
              <div className="alert-panel">
                <div className="alert-header">
                  <div className="alert-title-group">
                    <span className="alert-eyebrow">
                      ALERT HISTORY · 最近 {ALERT_MAX_HISTORY} 條
                    </span>
                    <div className="alert-title">
                      警報歷史
                      {alertHistory.length > 0 && (
                        <span className="alert-count-badge">
                          {alertHistory.length}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="alert-header-actions">
                    {alertHistory.length > 0 && alertHistoryOpen && (
                      <button
                        className="alert-clear-btn"
                        onClick={clearAlertHistory}
                        title="清除所有警報歷史"
                      >
                        清除
                      </button>
                    )}
                    <button
                      className="alert-toggle"
                      onClick={() => setAlertHistoryOpen((o) => !o)}
                      aria-label={alertHistoryOpen ? "收合" : "展開"}
                    >
                      <span
                        className={`alert-chevron ${
                          alertHistoryOpen ? "open" : ""
                        }`}
                      >
                        ›
                      </span>
                    </button>
                  </div>
                </div>
                {(alertHistoryOpen || stockExportForceExpandAll) && (
                  <div className="alert-body">
                    {alertHistory.length === 0 ? (
                      <div className="alert-empty">
                        尚無警報觸發紀錄。當 RSI
                        進入超買/超賣區、評級異動或股價突破布林通道時,將在此顯示。
                      </div>
                    ) : (
                      <div className="alert-list">
                        {alertHistory.map((a) => {
                          const diffMs = Date.now() - a.ts;
                          const diffH = Math.floor(diffMs / 3600000);
                          const diffD = Math.floor(diffMs / 86400000);
                          let timeStr;
                          if (diffMs < 60000) timeStr = "剛剛";
                          else if (diffH < 1)
                            timeStr = `${Math.floor(diffMs / 60000)} 分鐘前`;
                          else if (diffH < 24) timeStr = `${diffH} 小時前`;
                          else if (diffD === 1) timeStr = "昨日";
                          else timeStr = `${diffD} 日前`;
                          return (
                            <div
                              key={a.id + "-" + a.ts}
                              className={`alert-item alert-${a.severity}`}
                            >
                              <div className="alert-item-icon">
                                {a.severity === "danger" && "⚠"}
                                {a.severity === "warning" && "▲"}
                                {a.severity === "success" && "✓"}
                                {a.severity === "info" && "ⓘ"}
                              </div>
                              <div className="alert-item-body">
                                <div className="alert-item-head">
                                  <span className="alert-item-title">
                                    {a.title}
                                  </span>
                                  <span className="alert-item-time">
                                    {timeStr}
                                  </span>
                                </div>
                                <div className="alert-item-msg">
                                  {a.message}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ⭐️⭐️⭐️ 評級策略歷史回測 ⭐️⭐️⭐️ */}
              <BacktestPanel
                fullData={fullChartData}
                perValue={fundamentals.per}
              />

              <div className="card-footer">
                <span>QUANTEDGE TERMINAL</span>
                <span className="footer-divider">·</span>
                <span>EST. 2025</span>
                <span className="footer-divider">·</span>
                <span>PRIVATE WEALTH</span>
              </div>
            </div>
          )}

        {/* ⭐️ 完整評級報告 Modal ⭐️ */}
        {showRatingModal && metrics && stock && (
          <div
            className="rating-modal-overlay"
            onClick={() => setShowRatingModal(false)}
          >
            <div
              className="rating-modal"
              ref={ratingModalRef}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <div className="modal-title-group">
                  <span className="modal-eyebrow">EQUITY RESEARCH REPORT</span>
                  <h3 className="modal-title">量化評等完整報告</h3>
                  <div className="modal-subject">{stock.name}</div>
                </div>
                <button
                  className="modal-close"
                  onClick={() => setShowRatingModal(false)}
                >
                  ✕
                </button>
              </div>

              <div className="modal-summary">
                <div className="summary-label">FINAL RATING</div>
                <div className={`summary-rating ${metrics.ratingClass}`}>
                  {metrics.ratingShort}
                </div>
                <div className="summary-cn">{metrics.rating}</div>
                <StarRating stars={metrics.ratingStars} />
                <div className="summary-score">
                  綜合分數 <strong>{fmt(metrics.compositeScore, 1)}</strong> /
                  100
                </div>
                <div className="rating-bar">
                  <div className="rating-bar-track">
                    <div
                      className="rating-bar-fill"
                      style={{ width: `${(metrics.ratingScore / 6) * 100}%` }}
                    ></div>
                  </div>
                  <div className="rating-bar-labels">
                    <span>SELL</span>
                    <span>HOLD</span>
                    <span>STRONG BUY</span>
                  </div>
                </div>
              </div>

              <div className="modal-section">
                <div className="modal-section-title">
                  <span className="title-icon">▎</span>四大因子拆解
                </div>
                {[
                  {
                    key: "momentum",
                    label: "MOMENTUM 動能因子",
                    desc: "RSI、MA 排列、近期報酬",
                    weight: 25,
                  },
                  {
                    key: "value",
                    label: "VALUE 估值因子",
                    desc: "近季百分位、PE 評估",
                    weight: 25,
                  },
                  {
                    key: "quality",
                    label: "QUALITY 品質因子",
                    desc: "夏普比率、波動穩定度、回撤",
                    weight: 25,
                  },
                  {
                    key: "trend",
                    label: "TREND 趨勢因子",
                    desc: "多週期均線排列、長線方向",
                    weight: 25,
                  },
                ].map((f) => (
                  <div key={f.key} className="factor-detail-row">
                    <div className="fd-header">
                      <span className="fd-label">{f.label}</span>
                      <span className="fd-weight">權重 {f.weight}%</span>
                    </div>
                    <div className="fd-desc">{f.desc}</div>
                    <div className="fd-progress">
                      <div className="fd-track">
                        <div
                          className="fd-fill"
                          style={{ width: `${metrics.factors[f.key]}%` }}
                        ></div>
                      </div>
                      <div className="fd-score-text">
                        <strong>{Math.round(metrics.factors[f.key])}</strong> /
                        100
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="modal-section">
                <div className="modal-section-title">
                  <span className="title-icon">▎</span>核心量化指標
                </div>
                <div className="quant-grid">
                  <div className="quant-cell">
                    <span className="qc-label">夏普比率</span>
                    <span
                      className={`qc-value ${
                        metrics.quantMetrics.sharpe > 1
                          ? "good"
                          : metrics.quantMetrics.sharpe < 0
                          ? "bad"
                          : ""
                      }`}
                    >
                      {fmt(metrics.quantMetrics.sharpe, 2)}
                    </span>
                    <span className="qc-note">
                      {metrics.quantMetrics.sharpe > 2
                        ? "卓越"
                        : metrics.quantMetrics.sharpe > 1
                        ? "優秀"
                        : metrics.quantMetrics.sharpe > 0.5
                        ? "良好"
                        : metrics.quantMetrics.sharpe > 0
                        ? "普通"
                        : "不佳"}
                    </span>
                  </div>
                  <div className="quant-cell">
                    <span className="qc-label">年化波動率</span>
                    <span className="qc-value">
                      {fmt(metrics.quantMetrics.vol, 1)}%
                    </span>
                    <span className="qc-note">
                      {metrics.quantMetrics.vol < 15
                        ? "低波動"
                        : metrics.quantMetrics.vol < 25
                        ? "正常"
                        : metrics.quantMetrics.vol < 35
                        ? "中波動"
                        : "高波動"}
                    </span>
                  </div>
                  <div className="quant-cell">
                    <span className="qc-label">歷史最大回撤</span>
                    <span className="qc-value bad">
                      {fmt(metrics.quantMetrics.dd, 1)}%
                    </span>
                    <span className="qc-note">近 1 年</span>
                  </div>
                  <div className="quant-cell">
                    <span className="qc-label">近 30 日報酬</span>
                    <span
                      className={`qc-value ${
                        metrics.quantMetrics.ret30 > 0 ? "good" : "bad"
                      }`}
                    >
                      {metrics.quantMetrics.ret30 >= 0 ? "+" : ""}
                      {fmt(metrics.quantMetrics.ret30, 1)}%
                    </span>
                    <span className="qc-note">月線動能</span>
                  </div>
                  <div className="quant-cell">
                    <span className="qc-label">風險報酬比 R/R</span>
                    <span className="qc-value gold">
                      {fmt(metrics.quantMetrics.riskRewardRatio, 2)}
                    </span>
                    <span className="qc-note">上行 / 回撤</span>
                  </div>
                  <div className="quant-cell">
                    <span className="qc-label">建議曝險</span>
                    <span className="qc-value gold">
                      {fmt(metrics.quantMetrics.recommendedPosition, 1)}%
                    </span>
                    <span className="qc-note">Half-Kelly</span>
                  </div>
                </div>
              </div>

              <div className="modal-section">
                <div className="modal-section-title">
                  <span className="title-icon">▎</span>七級評等架構
                </div>
                <div className="rating-table">
                  {[
                    {
                      score: 6,
                      tag: "STRONG BUY",
                      cn: "積極加碼",
                      cond: "綜合分數 ≥ 80",
                      cls: "strong-buy",
                    },
                    {
                      score: 5,
                      tag: "BUY",
                      cn: "買進",
                      cond: "68 ≤ 分數 < 80",
                      cls: "buy",
                    },
                    {
                      score: 4,
                      tag: "OUTPERFORM",
                      cn: "優於大盤",
                      cond: "58 ≤ 分數 < 68",
                      cls: "outperform",
                    },
                    {
                      score: 3,
                      tag: "HOLD",
                      cn: "中立",
                      cond: "45 ≤ 分數 < 58",
                      cls: "neutral",
                    },
                    {
                      score: 2,
                      tag: "UNDERPERFORM",
                      cn: "劣於大盤",
                      cond: "35 ≤ 分數 < 45",
                      cls: "underperform",
                    },
                    {
                      score: 1,
                      tag: "REDUCE",
                      cn: "減碼",
                      cond: "22 ≤ 分數 < 35",
                      cls: "reduce",
                    },
                    {
                      score: 0,
                      tag: "SELL",
                      cn: "賣出",
                      cond: "分數 < 22",
                      cls: "sell",
                    },
                  ].map((r) => (
                    <div
                      key={r.score}
                      className={`rating-row ${r.cls} ${
                        metrics.ratingScore === r.score ? "active" : ""
                      }`}
                    >
                      <span className="rt-tag">{r.tag}</span>
                      <span className="rt-cn">{r.cn}</span>
                      <span className="rt-cond">{r.cond}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="modal-section">
                <div className="modal-section-title">
                  <span className="title-icon">▎</span>方法論與學理依據
                </div>
                <div className="theory-text">
                  本評等模型採用
                  <strong className="gold-text"> Four-Factor Composite </strong>
                  架構, 整合動能 (Momentum)、估值 (Value)、品質 (Quality)、趨勢
                  (Trend) 四大因子, 並以等權重 (25% × 4)
                  進行加權平均得到綜合分數 (0-100)。
                  <br />
                  <br />
                  品質因子採用{" "}
                  <strong className="gold-text">Sharpe Ratio</strong>{" "}
                  衡量風險調整後報酬, 並結合年化波動率 (Annualized Volatility)
                  與最大回撤 (Max Drawdown) 進行穩定性評估。 部位建議採用{" "}
                  <strong className="gold-text">Half-Kelly Criterion</strong>
                  (凱利公式保守變體), 上限封頂 20%。
                  <br />
                  <br />
                  此架構源自 Fama-French 因子模型、Bridgewater All Weather、AQR
                  Capital 等量化機構之多因子選股框架。
                  <br />
                  <br />
                  <span className="theory-warning">
                    ⚠ 本評等僅供量化分析參考,不構成投資建議。市場風險自負。
                  </span>
                </div>
              </div>

              {/* ── 匯出此份「量化評等完整報告」為 PDF ── */}
              <div className="modal-export-row" data-export-hide="true">
                <button
                  className="modal-export-btn"
                  disabled={ratingExportBusy}
                  onClick={async () => {
                    if (ratingExportBusy) return;
                    const el = ratingModalRef.current;
                    if (!el) return;
                    setRatingExportBusy(true);
                    try {
                      const ts = new Date();
                      const pad = (n) => String(n).padStart(2, "0");
                      const fname = `QUANTEDGE_RATING_${stock.symbol}_${
                        stock.name
                      }_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(
                        ts.getDate()
                      )}_${pad(ts.getHours())}${pad(ts.getMinutes())}.pdf`;
                      const prevScroll = el.scrollTop;
                      el.scrollTop = 0;
                      await exportElementAsPDF(el, fname, {
                        tag: `${stock.symbol} · RATING REPORT`,
                        hiddenSelectors: ['[data-export-hide="true"]'],
                        sectionSelectors: [".modal-summary", ".modal-section"],
                      });
                      el.scrollTop = prevScroll;
                    } catch (e) {
                      console.error("匯出量化評等報告失敗", e);
                    } finally {
                      setRatingExportBusy(false);
                    }
                  }}
                >
                  {ratingExportBusy ? (
                    <>
                      <span className="export-spin">⟳</span> 處理中…
                    </>
                  ) : (
                    <>
                      <span>📄</span> 匯出量化評等完整報告 PDF
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 🗂 個股研究頁匯出區塊選擇 modal */}
        {stockExportModal && (
          <StockExportModal
            onConfirm={stockExportModal.onConfirm}
            onCancel={stockExportModal.onCancel}
          />
        )}

        {/* 🌟 自選股批次匯出 modal */}
        {batchExportModal && (
          <BatchExportModal
            watchlist={watchlist}
            stockMap={stockMap}
            onConfirm={async (selectedSyms) => {
              setBatchExportModal(null);
              await runBatchExport(selectedSyms);
            }}
            onCancel={() => setBatchExportModal(null)}
          />
        )}

        {/* 🌟 批次匯出進度面板(全局浮動) */}
        {batchExportProgress && (
          <BatchExportProgress
            progress={batchExportProgress}
            stockMap={stockMap}
            onClose={() => setBatchExportProgress(null)}
          />
        )}
      </div>
    </div>
  );
}
