# 登革熱地圖現代化：研究與設計

> 研究日期：2026-10-16。原站：<https://cdcdengue.azurewebsites.net/>（疾管署「登革熱地圖」，2015 年上線）。
> 新站：<https://ancientsky.github.io/denguemap/>（GitHub Pages）。

## 1. 原站盤點

### 1.1 功能（導覽列六個頁籤）

| 頁籤 | 原網址 | 內容 | 資料來源（後端） |
|---|---|---|---|
| 動態地圖 | `Timemap.aspx`（首頁） | 病例點位（最小統計區中心點）、日期區間滑桿＋播放、縣市、本土／境外切換、NS1 快篩院所圖層、行政界 | `DengueData.asmx/GetDengueLocation`、`data/ns1/*.json` |
| 聚集警示 | `DengueCluster.aspx` | 近兩週一級發布區病例數 ≥2 的群聚多邊形（目前常為「目前沒有登革熱群聚疫情!!」） | `GetDengueClusterEnable`、`GetDengueCluster_New` |
| 蚊媒地圖 | `VectorMap.aspx` | 村里病媒蚊風險（紅／橘／黃／灰）、前 1–5 週、危險級里別列表、CSV | 靜態 `data/geojson/cdcdengueVillagePoint.json`（每週更新） |
| 病例趨勢 | `Index.aspx` | 流行曲線、熱區圖 | `GetDengueData`、`GetAggreateData`（**已停在 2024-12-28**） |
| 境外移入 | `Imported.aspx` | 各國移入弧線圖、該國趨勢、該國疫情資訊 | `GetImportedData`（2023 起）、`GetIntEicdemic` |
| 資料說明 | 對話框 | 座標為最小統計區中心點、更新頻率、開放資料連結、蚊媒風險定義 | — |

蚊媒風險定義（原站文字）：
- 危險（紅）：誘卵桶陽性率 ≥60% 或 布氏級數 ≥3 級 或 誘殺桶陽性率 ≥30%
- 注意（橘）：誘卵桶陽性率 40–60% 或 布氏級數 2 級 或 誘殺桶陽性率 10–30%
- 低風險（黃）：其他有調查之里別；無資料（灰）
- 同里多項指標取最嚴重者。

### 1.2 原站的問題（改版要解決的）

| 面向 | 問題 |
|---|---|
| 技術老舊 | jQuery 3 + Semantic UI 2.0.3（2015）+ jQuery UI + Leaflet 外掛群、Highcharts（商用授權）；ASP.NET WebForms |
| 效能 | `$.ajaxSetup({async:false})` 同步請求卡住主執行緒；邊界檔以 LZString 壓縮的大型 GeoJSON（村里 9.9 MB 解壓後）；每頁重新載入整個框架 |
| 資料正確性 | 病例趨勢頁的 `GetAggreateData` 只到 2024-12-28，今年的趨勢圖是空的 |
| 資安 | 頁面直接顯示 ASP.NET Runtime Error 頁；註解中留有 Mapbox access token；沒有 CSP；Google Analytics 仍用已停用的 Universal Analytics（`UA-70023690-1`）；直接用 `tile.openstreetmap.org`（違反 OSM 圖磚使用政策的大量用途） |
| 使用性 | 無英文介面、無深色模式、手機版體驗差、無鍵盤操作／螢幕閱讀器支援、無可分享的網址狀態 |
| 可用性 | 後端無 CORS，第三方無法重用；開放資料主機 `od.cdc.gov.tw` 只允許台灣 IP |

## 2. 資料來源研究

### 2.1 可達性（從 GitHub Actions runner 實測）

| 主機 | 結果 |
|---|---|
| `od.cdc.gov.tw`、`data.cdc.gov.tw`（開放資料） | **連線逾時**（只允許台灣 IP） |
| `zone.cdc.gov.tw`、`epimap.cdc.gov.tw` | 逾時／DNS 失敗 |
| `data.gov.tw` API | 可達，但下載連結都指向 `od.cdc.gov.tw` |
| `cdcdengue.azurewebsites.net`（原站後端） | **可達**、無速率限制、支援 gzip、**無 CORS** |

結論：瀏覽器不能直接呼叫原站後端（無 CORS），開放資料主機在海外連不到。因此採「**排程 GitHub Action 抓原站後端 → 驗證 → 產生靜態 JSON → 部署 GitHub Pages**」。

### 2.2 端點（全部 `POST`，`Content-Type: application/json; charset=utf-8`，回傳 `{"d":"<JSON 字串>"}` 需再 parse 一次）

| 端點 | 請求 | 回傳 | 用途 |
|---|---|---|---|
| `GetDengueLocation` | `{citycode:'all', immigration:'0'/'1'/'2', startDate:'yyyy/mm/dd', endDate:'yyyy/mm/dd'}` | `[{"sickdate":"2026/09/26","lat":"24.07...","lng":"120.54...","count":1}]` | 病例點位（1998 起，本土約 10 萬筆、境外約 5 千筆，全量約 15 MB、10 秒） |
| `GetImportedData` | 空 body | `[{"sickdate":"2023/01/01","country_name":"菲律賓","country_code":"ph","country_lat":..,"country_lng":..,"count":1,...}]` | 境外移入感染國（只有 2023 起） |
| `GetIntEicdemic` | `{countrycode:'vn', countryname:'越南'}` | `[{"effective","headline","description","web"}]` | 該國疫情資訊（連到 cdc.gov.tw） |
| `GetDengueCluster_New` | `{citycode:'31'}`（16 個縣市碼） | GeoJSON FeatureCollection（多邊形，props: `COUNTY`,`TOWN`,`CODE1`,`COUNT`,`sick_date`...） | 聚集警示 |
| `GET data/geojson/cdcdengueVillagePoint.json` | — | 7,760 村里點、`weeks`（5 週）、`background_color` 等 | 蚊媒地圖（約 6.6 MB，每週） |
| `GET data/ns1/ns1hosp_20160603_lzstring.json` | — | LZString UTF-16 壓縮的 GeoJSON，2,316 家院所 | NS1 快篩院所（2016 年資料） |

縣市碼：`01` 台北市、`31` 新北市、`32` 桃園市、`03` 台中市、`05` 台南市、`07` 高雄市、`11` 基隆市、`12` 新竹市、`33` 新竹縣、`34` 宜蘭縣、`35` 苗栗縣、`37` 彰化縣、`38` 南投縣、`39` 雲林縣、`22` 嘉義市、`40` 嘉義縣、`43` 屏東縣、`44` 澎湖縣、`45` 花蓮縣、`46` 台東縣、`90` 金門縣、`91` 連江縣。可查群聚的縣市碼：`01 03 05 07 11 12 22 31 32 33 35 37 38 39 40 43`。

病例點位沒有縣市／鄉鎮欄位 → 建置時以 `taiwan-atlas`（內政部 TopoJSON，含英文名）做點在多邊形判定，補上縣市與鄉鎮代碼與中英文名。

### 2.3 隱私

原站座標本來就是「最小統計區」中心點（約數十戶），不是住址。新站**不加更細的資訊**：只顯示中心點與鄉鎮層級統計，不顯示村里層級的病例數。

## 3. 新站設計

### 3.1 架構

```
GitHub Actions（每 3 小時＋手動）
  scripts/data/*.mjs  抓 → 正規化 → 驗證（schema、筆數不得驟降、座標在台灣範圍）
     ├─ 成功：寫入 public/data/*.json，有變動才 commit 到 main（git scraping，保留歷史、也是「最後一次正確資料」）
     └─ 失敗：沿用 repo 內上一版資料，manifest 標 stale，不會部署空資料
  vite build → actions/deploy-pages → https://ancientsky.github.io/denguemap/
```

- 前端：Vite + TypeScript（不用框架，bundle 小）、MapLibre GL JS 6（WebGL 向量地圖）、ECharts 6（只在趨勢頁 lazy load）。
- 底圖：OpenFreeMap `positron`（淺色）／`dark`（深色）向量圖磚，免金鑰、CORS 開放；英文介面時地名改用 `name:en`。
- 行政界：`taiwan-atlas`（內政部，含中英文名）建置時轉出精簡 TopoJSON。

### 3.2 頁面

| 路由 | 功能 |
|---|---|
| `#/map` 動態地圖 | 年份、日期區間雙滑桿＋播放（14 天滑動窗）、本土／境外／全部、縣市快速定位、點位／熱度／鄉鎮面量圖、NS1 院所圖層、KPI 卡（今年累計、近 14 天、最新發病日） |
| `#/clusters` 聚集警示 | 官方群聚多邊形＋清單；無群聚時顯示明確的空狀態＋近 14 天本土病例鄉鎮列表 |
| `#/vector` 蚊媒地圖 | 村里風險面量圖、週別切換、縣市篩選、危險級里別表、CSV 下載（前端產生） |
| `#/trends` 病例趨勢 | 每日／每週流行曲線（本土／境外堆疊）、歷年同週比較、1998 起年度長條圖、縣市篩選、資料表（無障礙） |
| `#/imported` 境外移入 | 地球投影＋各國至台灣弧線、年份、國家排行、點國家看疾管署國際疫情資訊 |
| `#/about` 資料說明 | 來源、更新時間、隱私、蚊媒風險定義、免責聲明 |

網址帶狀態（例：`#/map?year=2026&type=local&county=64000`），可分享。

### 3.3 深淺色與中英文

- 主題：`system`／`light`／`dark`，存在 `localStorage`，`<html data-theme>` + CSS 變數；地圖切換底圖後重新掛上資料圖層；首屏前以極小的 `theme-init` 腳本避免閃爍（外部檔案，不用 inline，符合 CSP）。
- 語言：`zh-Hant`／`en`，優先序 `?lang=` → `localStorage` → `navigator.language`；`<html lang>` 同步；日期數字用 `Intl`；縣市鄉鎮英文名來自內政部資料；國名用 `Intl.DisplayNames` + ISO 碼；疾管署國際疫情原文只有中文，英文介面標示「Original in Chinese」。

### 3.4 資安

- 純靜態站，無後端、無金鑰、無 cookie、無第三方追蹤（拿掉 GA）。
- CSP（meta）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tiles.openfreemap.org; connect-src 'self' https://tiles.openfreemap.org; worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`；`referrer` = `strict-origin-when-cross-origin`。
- 外部文字（疾管署疫情資訊、地名）一律以 `textContent` 呈現，不用 `innerHTML`；外部連結只允許 `https://www.cdc.gov.tw/`、`https://www.nhi.gov.tw/` 開頭並加 `rel="noopener noreferrer"`。
- 資料管線：只接受預期欄位（白名單）、型別與範圍檢查、筆數驟降保護；失敗不覆蓋。
- GitHub Actions：action 釘選 commit SHA、最小權限（`contents: read`；部署 job 才有 `pages: write`/`id-token: write`；資料 job 才有 `contents: write`）、`concurrency` 防重疊、`npm ci`、Dependabot。
- 相依套件少：執行期只有 `maplibre-gl`、`echarts`、`topojson-client`。

### 3.5 效能預算

- 首屏 JS（gzip）≤ 300 KB（MapLibre 約 220 KB），ECharts 只在趨勢頁載入。
- 資料按需載入：病例按年份分檔；邊界 TopoJSON；蚊媒只送有調查的村里。
- 系統字型（不載入網路字型）；`prefers-reduced-motion` 時停用動畫。
- 目標：行動版 Lighthouse 效能 ≥ 85、無障礙 ≥ 95。

## 4. 資料格式（`public/data/`，前後端契約）

見 [data-contract.md](data-contract.md)。
