# 嵌入模式（iframe）使用說明

給網站維運／資訊人員：如何把登革熱地圖嵌入其他網站（第一個對象：[新版疾管署網站原型](https://ancientsky.github.io/new_cdc_prototype/)）。

地圖網址：<https://ancientsky.github.io/denguemap/>。加上 `embed=1` 即進入嵌入模式；不加則與一般網站完全相同。

## 1. 嵌入模式做了什麼

| 項目 | 嵌入模式的行為 |
|---|---|
| 版面 | 隱藏網站標題列、主導覽列與手機底部分頁列；保留各頁的控制面板。 |
| 控制面板 | iframe 高度 < 560 px 或手機寬度（≤ 760 px）時，預設收合成只剩標題列的精簡卡片，點一下展開；其餘情況照常展開。 |
| 底部資訊列 | 永遠顯示：「登革熱地圖 ↗」（在**新分頁**開啟完整版，相同頁面與篩選狀態，不含 `embed`）與「資料：衛生福利部疾病管制署｜更新 日期」。 |
| 地圖手勢 | 啟用 MapLibre `cooperativeGestures`：電腦需 Ctrl（Mac 為 ⌘）＋滾輪才縮放，手機需兩指才平移；一般捲動與單指滑動會捲動**宿主頁面**。提示文字隨語言切換（中／英）。 |
| 動畫 | 「境外移入」不自動播放、地球不自動旋轉（按「播放」才動），降低宿主頁面的 CPU 負擔。 |
| 偏好設定 | **不讀取、也不寫入**瀏覽器 `localStorage` 的佈景與語言設定（宿主與地圖可能同網域，不可覆蓋使用者在獨立網站上的偏好）。佈景與語言只由網址參數決定。 |
| 導覽 | 頁面內連結只做 iframe 內的 `#/…` 切換，外部連結一律 `target="_blank"` 且 `rel="noopener noreferrer"`；不會操作 `top` / `parent`。 |

## 2. 網址參數

參數可放在 `?` 查詢字串（`location.search`），也可放在網址 `#` 後面、路由自己的查詢字串，兩處都認得：

```
https://ancientsky.github.io/denguemap/?embed=1&theme=dark&lang=en#/vector?county=64000
https://ancientsky.github.io/denguemap/#/map?embed=1&theme=dark&lang=en
https://ancientsky.github.io/denguemap/?embed=1&lang=zh#/map?p=custom&start=2025-12-01&end=2026-01-31&type=all
```

規則：值必須完全符合下表（區分大小寫）；不合法的值與未知參數一律忽略（視為未提供）。兩處都有時，先看 `?` 查詢字串，其值不合法才看 `#` 內的。使用者操作造成網址更新時，`#` 內的 `embed`／`theme`／`lang` 會保留；`?` 內的本來就不會被改動。`embed` 只在載入時讀取一次。

### 嵌入與外觀

| 參數 | 值 | 預設 | 說明 |
|---|---|---|---|
| `embed` | `1` | 無（一般模式） | 只有 `1` 有效（`true`、`yes`、`0` 都無效）。 |
| `theme` | `light`、`dark` | 跟隨作業系統（`prefers-color-scheme`） | 在嵌入模式不讀取已存的偏好。**非嵌入**頁面帶 `theme` 時，只套用於這次載入，不會存起來。 |
| `lang` | `zh`、`en` | 嵌入：瀏覽器語言（`zh*`→中文、`en*`→英文，其他→中文），不讀取已存偏好；一般模式：已存偏好→瀏覽器語言 | `zh-Hant`、`zh-TW` 視同 `zh`（舊連結）。 |

### 各頁面參數（網址 `#/頁面?參數`）

頁面：`#/map` 動態地圖、`#/clusters` 聚集警示、`#/vector` 蚊媒地圖、`#/trends` 病例趨勢、`#/imported` 境外移入、`#/about` 資料說明。省略的參數用預設值，超出範圍的值會被修正為合法值。

| 頁面 | 參數 | 值 | 預設 |
|---|---|---|---|
| `#/map` | `p` | 期間：`ytd`（今年）、`py`（去年 1 月 1 日起）、`90d`（近 90 天）、`12m`（近 12 個月）、`year`（指定年份）、`custom`（自訂） | `ytd`；**1 月**為 `py`（跨年病例仍可追蹤，同舊版疾管署地圖） |
| | `year` | 搭配 `p=year`：資料涵蓋的西元年（4 位數） | 最新年度 |
| | `start`、`end` | 搭配 `p=custom`：`YYYY-MM-DD`，可跨年；超出資料範圍會修正，最長 3 年（超過時調整起始日），`start` > `end` 時自動對調 | 結束日＝今天（臺灣時間） |
| | `from`、`to` | 期間內再選的發病日子區間（`YYYY-MM-DD`），超出期間會修正 | 期間起訖日 |
| | `type` | `local`（本土）、`imported`（境外移入）、`all` | `local` |
| | `county` | 5 碼縣市代碼，如 `64000`（高雄市） | 全國 |
| | `mode` | `points`（點位）、`heat`（熱度）、`towns`（鄉鎮面量圖） | `points` |
| | `color` | `recency`（距發病日）、`type`（本土／境外） | `recency` |
| | `ns1` | `1` 顯示 NS1 快篩院所 | 關 |
| | `mv` | `1` 顯示病媒蚊風險村里 | 關 |
| `#/vector` | `week` | `0`（最新）至 `4`（前 4 週） | `0` |
| | `county` | 同上 | 全國 |
| | `cases` | `1` 疊加近 30 天病例 | 關 |
| `#/imported` | `year` | 西元年，或 `all`（全部年度） | 最新年度 |
| | `country` | 小寫 ISO 3166-1 兩碼國碼，如 `vn` | 無 |
| | `tab` | `rank`（排行）、`adv`（疫情資訊）、`news`（國際新聞） | `rank` |
| | `adv` | `vb`（病媒傳染病）、`all`（全部）、`off`（關閉） | `vb` |
| `#/trends` | `county` | 同上 | 全國 |
| | `gran` | `day`、`week` | `week` |
| | `type` | `local`、`imported`、`all` | `local` |
| | `years` | 以逗號分隔的比較年度，如 `2026,2025,2023`（最多 8 個） | 近年預設組合 |
| `#/clusters`、`#/about` | — | 無參數 | — |

`#/map` 的期間都以「資料結束日」為準：今天（臺灣時間），但不超過最新資料年度的 12 月 31 日、也不早於最新發病日。例如 `p=90d` 永遠是最近 90 天，年度切換時不需改網址。播放時起始日固定在期間（或子區間）起點，每一步把結束日往後推一天，顏色依發病日距當日的天數；暫停時網址的 `to` 即為播放到的日期。

**舊連結相容：**沒有 `p`、但有 4 位數 `year` 或數字的 `from`／`to`（當年第幾天，1–366）的舊網址，視為 `p=year`（沒有 `year` 時為最新年度），`from`／`to` 換算成該年日期，例如 `year=2015&from=150&to=300` → `p=year&year=2015&from=2015-05-30&to=2015-10-27`；載入後網址會改寫成新格式。只有 `start`／`end` 而沒有 `p` 時視為 `p=custom`。

網址與頁面狀態同步：使用者在嵌入的地圖上調整篩選後，iframe 網址的 `#` 部分會跟著更新，「登革熱地圖 ↗」連結也會指向同一狀態。

## 3. 建議的 iframe 寫法

```html
<iframe src="https://ancientsky.github.io/denguemap/?embed=1&lang=zh#/map"
        title="登革熱病例地圖" loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin" allow="fullscreen"
        style="width:100%;height:560px;border:0"></iframe>
```

- `title` 供螢幕閱讀器使用，請依頁面內容修改（例如「病媒蚊風險地圖」）。
- `loading="lazy"` 讓頁面捲到附近才載入地圖。
- 宿主若設有 CSP，需允許 `frame-src https://ancientsky.github.io`（正式網域則換成該網域）。
- 目前不支援 `postMessage`、不會自動調整 iframe 高度；請依下表固定高度。

### 建議高度

| 頁面 | 桌機 | 手機 | 備註 |
|---|---|---|---|
| `#/map`、`#/vector`、`#/clusters` | 560–680 px | 480–600 px | 560 px 起面板預設展開；低於 560 px 時面板自動收合，地圖面積較大。 |
| `#/imported` | 560–680 px | 480–600 px | 地球投影；不自動播放，使用者按「播放」。 |
| `#/trends`、`#/about` | 720 px 以上 | 720 px 以上 | 一般頁面版型，內容超出時在 iframe 內捲動；圖表較高，建議不要小於 640 px。 |

### 手機注意事項

- 寬度 ≤ 760 px 時控制面板是底部的收合卡片（只顯示標題列），點開後最多佔滿 iframe 高度減 36 px。
- 地圖需**兩指**拖曳平移與縮放；單指滑動會捲動宿主頁面，並短暫顯示「請用兩指移動地圖」。
- 不要把 iframe 放在會攔截觸控手勢（如 `touch-action: none`）的容器裡。
- 底部資訊列高 32 px，已包含在 iframe 高度內，不會遮住地圖控制項與圖資來源標示。

## 4. `sandbox` 與安全性

若宿主要加 `sandbox`，最少需要：

```html
sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
```

- `allow-scripts`、`allow-same-origin`：地圖執行與載入同網域的資料、Web Worker 所需。
- `allow-popups`、`allow-popups-to-escape-sandbox`：「登革熱地圖 ↗」與外部連結在新分頁開啟；後者讓新分頁不繼承 sandbox 限制。

- NS1 快篩院所彈出視窗內的電話連結是 `tel:`；在 `sandbox` 內瀏覽器可能不會撥號（需另加 `allow-top-navigation-to-custom-protocols`，若不需要此功能可略過）。

**注意：宿主與地圖同源（same origin）時，`allow-scripts` ＋ `allow-same-origin` 的 sandbox 沒有任何隔離效果**（內嵌頁面可以直接移除自己的 sandbox 屬性或存取宿主）。原型階段兩者都在 `ancientsky.github.io` 底下（`/new_cdc_prototype/` 與 `/denguemap/`），即屬此情況。

正式上線建議：

1. 把地圖放在**官方網域的子路徑**，或**獨立的來源（origin）**（例如 `denguemap.<官方網域>`），與宿主網站不同源，sandbox 才有意義。
2. 地圖站以 HTTP **回應標頭**限制誰能嵌入：`Content-Security-Policy: frame-ancestors <官方網站 origin>`。

**限制：** `frame-ancestors` 不能寫在 `<meta http-equiv="Content-Security-Policy">` 裡（瀏覽器會忽略），而 GitHub Pages 無法自訂回應標頭，所以目前任何網站都能嵌入這個地圖。本專案的 CSP（`index.html` 內的 `<meta>`）未因嵌入模式放寬：`script-src 'self'`、無 inline script、`form-action 'none'`、`object-src 'none'` 都維持原樣。

其他安全設計：網址參數只接受白名單值，不合法的一律丟棄，絕不原樣輸出到頁面；頁面內容一律以 `textContent` 產生，不使用 `innerHTML`；仍保留 `<meta name="referrer" content="strict-origin-when-cross-origin">`。

## 5. 驗證方式

```bash
npm run build && npm run smoke      # 含嵌入模式測試
SMOKE_PASSES=embed npm run smoke    # 只跑嵌入模式
SMOKE_PASSES=period npm run smoke   # 期間選擇、跨年、逐日播放、舊連結、嵌入帶期間參數、2027 年度切換
npx vitest run tests/unit/embed.test.ts
```

`npm run smoke` 的嵌入測試涵蓋：動態地圖、蚊媒地圖、境外移入 × 中／英 × 淺／深色 × 800×560 桌機與 390×600 手機（以 `?embed=1&theme=…&lang=…` 載入）：檢查標題與導覽隱藏、「開啟完整版」連結（同頁面、無 `embed`、`_blank`＋`noopener noreferrer`）、佈景與語言、無主控台錯誤與 CSP 違規、`localStorage` 未被寫入；另在跨來源的真實 iframe 內驗證未按 Ctrl 的滾輪不會縮放地圖（宿主頁面照常捲動）、按 Ctrl 則會縮放。截圖輸出到 `test-results/screens/embed-*.png`。
