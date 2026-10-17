# 資料契約（`public/data/`）

前端只讀這些檔案；資料管線（`scripts/data/`）只寫這些檔案。所有日期字串為台灣時區的 `YYYY-MM-DD`。
所有縣市／鄉鎮代碼採內政部代碼（同 `taiwan-atlas` 的 `COUNTYCODE`／`TOWNCODE`，例：高雄市 `64000`、前鎮區 `64000090`）。
JSON 一律 UTF-8、無縮排（minified）。

## manifest.json（每次都會重寫；前端先讀它）

```jsonc
{
  "schema": 1,
  "generatedAt": "2026-10-16T12:00:00Z",          // ISO UTC
  "latestOnset": "2026-10-14",                   // 全部病例中最新發病日
  "years": [1998, 1999, /* … */ 2026],           // 有 cases/{year}.json 的年份
  "sources": {                                    // 每個來源一筆
    "cases":    { "ok": true, "stale": false, "fetchedAt": "…", "records": 105232 },
    "imported": { "ok": true, "stale": false, "fetchedAt": "…", "records": 894 },
    "notices":  { "ok": true, "stale": false, "fetchedAt": "…", "records": 40 },
    "clusters": { "ok": true, "stale": false, "fetchedAt": "…", "records": 0 },
    "vector":   { "ok": true, "stale": false, "fetchedAt": "…", "records": 318,
                  "periodStart": "2026-09-06", "periodEnd": "2026-10-10" },
    "ns1":      { "ok": true, "stale": false, "fetchedAt": "…", "records": 2316, "sourceDate": "2016-06-03" }
  },
  "warnings": [                                   // 資料品質警示（見下）；沒有問題時為 []
    { "code": "cases-shortfall", "year": 2023, "type": "local", "got": 951, "expected": 24794 },
    { "code": "imported-shortfall", "got": 294, "expected": 894 },
    { "code": "imported-shortfall", "year": 2023, "got": 53, "expected": 271 }
  ],
  "files": { "summary.json": "a1b2c3d4", "cases/2026.json": "…" }   // 內容 sha256 前 8 碼，前端用作 ?v= 快取鍵
}
```
**來源狀態（`sources.*`）**

| `ok` | `stale` | 意義 |
|---|---|---|
| `true` | `false` | 這次抓取並驗證成功 |
| `false` | `true` | 這次抓取／驗證失敗，沿用上一版檔案（`fetchedAt`、`records` 等維持上一版的值） |
| `false` | `false` | 從未成功抓取過（沒有任何檔案；`fetchedAt: null`、`records: 0`） |

`fetchedAt` 是該份資料實際成功抓取的時間。manifest 只在「任何資料檔雜湊、`warnings` 或來源 `ok`／`stale` 旗標改變」時重寫，因此資料沒變時 `generatedAt`／`fetchedAt` 不會前進（排程每 3 小時檢查一次，但不會每次都 commit）。

**`warnings`**（決定性、不含時間戳記；依 `code`、`year`、`type` 排序）：以目前已提交的資料對照固定的歷史基準（2026-10-16 觀測值，不隨新資料更新），任何計數低於基準的 80% 就產生一筆，讓前端能誠實標示上游資料短缺。
- `cases-shortfall`：`{ code, year, type: "local"|"imported", got, expected }`，逐年（1998 起）、逐類型比對 `cases/{year}.json` 的病例總數。
- `imported-shortfall`：`{ code, got, expected }`（無 `year`）為 `imported.json` 全部筆數對基準 894（2023-01-01..2026-10-14）；`{ code, year, got, expected }` 為逐年比對（基準 2023: 271、2024: 203、2025: 229、2026: 191）。

## geo/admin.topo.json

TopoJSON（由 taiwan-atlas `towns-10t.json` 精簡、量化），兩個 object：
- `counties`：properties `{ "code": "64000", "zh": "高雄市", "en": "Kaohsiung City" }`
- `towns`：properties `{ "code": "64000090", "county": "64000", "zh": "前鎮區", "en": "Qianzhen District" }`

名稱一律用「臺」→ 保留內政部原字（taiwan-atlas 用「台」者，管線統一轉為「臺」）。

## cases/{year}.json（每年一檔，依發病日年份）

```jsonc
{
  "year": 2026,
  "pts": [[120.54640, 24.07601, "10007010"], …],   // 本檔用到的唯一座標：[lng, lat, townCode|null]，5 位小數
  "c":   [[268, 0, 0, 1], …]                       // [dayOfYear(1-366), ptIndex, imported(0|1), count]
}
```
`c` 依 dayOfYear 遞增排序；同日同點同類別合併 count。

**年度切換：**年份依臺灣日期決定。1 月 1 日（臺灣時間）起，當年的檔案一定存在並列入 `manifest.years`，尚無病例時為 `{"year": 2027, "pts": [], "c": []}`；此時 `manifest.latestOnset` 可能仍在前一年。新年度沒有歷史基準，`cases-shortfall` 警示與縮水檢查只對照前一版檔案。前端「動態地圖」可跨年讀取多個年度檔（依座標合併同一最小統計區）。

## trend.json

```jsonc
{
  "start": "1998-01-01",
  "end": "2026-10-16",                       // 產生日（含）
  "national": { "local": [0, 1, …], "imported": [ … ] },   // 每日計數，長度 = end-start+1
  "county": {                                // 稀疏：[dayIndex, count]（dayIndex 自 start 起算 0-based）
    "64000": { "local": [[6200, 3], …], "imported": [[…]] }
  }
}
```

## summary.json

```jsonc
{
  "asOf": "2026-10-16",
  "latestOnset": "2026-10-14",
  "year": 2026,
  "ytd":   { "local": 14, "imported": 185 },
  "last7": { "local": 0, "imported": 5 },
  "last14":{ "local": 1, "imported": 12 },
  "last30":{ "local": 3, "imported": 33 },
  "prevYtd": { "local": 20, "imported": 160 },        // 去年同期（1/1 到去年同月同日）；year 於 1/1 切換，ytd 可為 0，last7/14/30 跨年計算
  "byCounty": { "64000": { "local": 10, "imported": 32 } },   // 今年累計
  "topTowns14": [["64000090", 2, 0]],                 // 近 14 天 [townCode, local, imported]，依 local 遞減，最多 20
  "townNames": { "64000090": { "county": "64000", "countyZh": "高雄市", "countyEn": "Kaohsiung City", "zh": "前鎮區", "en": "Qianzhen District" } }
                                                      // topTowns14 中各鄉鎮的名稱（內政部名稱，臺字；英文來自 taiwan-atlas），供外部網站（如新官網疫情小卡）不需代碼表即可顯示
}
```

## imported.json

```jsonc
{
  "from": "2023-01-01", "to": "2026-10-14",
  "countries": {
    "vn": { "zh": "越南", "lat": 14.06, "lng": 108.28,
            "byYear": { "2023": 60, "2026": 50 },
            "byMonth": { "2026-01": 4 } }
  }
}
```
國碼為小寫 ISO 3166-1 alpha-2。台灣端點固定 `[120.98, 23.97]`，前端常數即可。

## notices.json

```jsonc
{ "vn": [ { "date": "2026-09-29", "headline": "越南-登革熱", "text": "…", "url": "https://www.cdc.gov.tw/…" } ] }
```
只收近 365 天有移入病例的國家；每國最多 5 則，依日期遞減。`headline`/`text` 做 NFKC 正規化（原資料有「⾰」相容字）、去除 HTML、長度上限 600 字；`url` 必須以 `https://www.cdc.gov.tw/` 開頭，否則設為 `null`。

## vector.json

```jsonc
{
  "updated": "2026-10-12",
  "weeks": [["2026-10-04", "2026-10-10"], …],      // 5 週，最新在前
  "villages": [
    // [county 中文, town 中文, village 中文, lng, lat, villCode|null, overall, weeksData]
    // overall/顏色碼：0=無資料(灰) 1=低風險(黃) 2=注意(橘) 3=危險(紅)
    // weeksData：與 weeks 對齊，每週 [color, breteauLevel|null, ovitrapPos%|null, gravitrapPos%|null]
    ["屏東縣", "屏東市", "大同里", 120.48788, 22.66994, "10013010025", 3, [[3, null, 60, null], …]]
  ],
  "surveyed": { "10013": { "villages": 120, "total": 464 } }   // 各縣市近 5 週有調查的村里數／總村里數
}
```
只輸出 5 週內至少一週非灰色的村里。`villCode` 由名稱比對 taiwan-atlas `villages` 取得（台/臺正規化），比對不到為 `null`。

## geo/vector-villages.topo.json

TopoJSON，object `villages`：只含 vector.json 中 `villCode` 非 null 的村里多邊形，properties `{ "code": "10013010025" }`。

## clusters.json

```jsonc
{ "type": "FeatureCollection", "fetchedAt": "…", "features": [
  { "type": "Feature", "geometry": { /* Polygon/MultiPolygon，座標 5 位小數 */ },
    "properties": { "county": "臺南市", "town": "東區", "code1": "A6701-…", "count": 3, "lastOnset": "2026-08-01" } } ] }
```
只保留上列 properties（白名單）。

## ns1.json

```jsonc
{ "sourceDate": "2016-06-03",
  "h": [["長庚紀念醫院", "臺北市松山區敦化北路199號", "02-27135211", 121.54962, 25.05551, "1101010012", "63000"], …] }
```
`[name, address, tel, lng, lat, hospID, countyCode]`。

---

## v2 增補（2026-10-17）

### imported.json：新增 `events`

```jsonc
{ "from": "2023-01-01", "to": "2026-10-14", "countries": { … },
  "events": [[0, "ph", 1], [3, "vn", 2], …] }   // [dayIndex(自 from 起算 0-based), 國碼, 當日病例數]，依 dayIndex、國碼排序
```
供境外移入地球的逐日播放動畫使用。

### travel.json（新檔；來源：ancientsky/safetravel 的 `web/data/alerts.json`、`epidemics.json`）

```jsonc
{
  "updated": "2026-10-16T21:17:38+08:00",          // safetravel 資料的 generated_at（原樣，ISO 含時區）
  "levels": { "1": { "zh": "第一級：注意", "en": "Level 1: Watch", "adviceZh": "提醒遵守當地的一般預防措施", "adviceEn": "Practice usual precautions" }, "2": { … }, "3": { … } },
  "diseases": {                                     // 只收蚊媒傳染病；key 固定
    "dengue": { "zh": "登革熱", "en": "Dengue" }, "chikungunya": { … }, "zika": { … },
    "yellowFever": { … }, "malaria": { … }, "japaneseEncephalitis": { … }, "westNile": { … }
  },
  "countries": {                                    // 國碼小寫 ISO2；只收有任何有效建議的國家
    "vn": { "zh": "越南", "en": "Vietnam",
            "level": 1,                             // 所有疾病中最高等級（含全球性建議）
            "vb": [ { "d": "dengue", "level": 1, "since": "2025-06-01", "areaZh": "", "areaEn": "" } ] }  // 蚊媒疾病的建議（可空）
  },
  "news": [                                         // 蚊媒疾病的國際疫情新聞，近 2 年，依 date 遞減，最多 300 則
    { "id": "…", "date": "2026-10-15", "d": ["dengue"], "countries": ["vn", "th"],
      "headlineZh": "…", "headlineEn": "…", "summaryZh": "…", "summaryEn": "…",
      "url": "https://www.cdc.gov.tw/…" }           // 非 https://www.cdc.gov.tw/ 開頭者為 null
  ]
}
```
疾病對照（safetravel 中文病名 → key）：登革熱→dengue、屈公病→chikungunya、茲卡病毒感染症→zika、黃熱病→yellowFever、瘧疾→malaria、日本腦炎→japaneseEncephalitis、西尼羅熱→westNile。一則新聞的 `disease_zh` 可能以逗號列出多個病名，只要含任一蚊媒病名就收，`d` 只列蚊媒的 key。所有文字 NFKC、去 HTML、長度上限 600。

### geo/world.topo.json（新檔，建置時由 npm `world-atlas` 產生；不需每次重抓）

TopoJSON，object `countries`，properties `{ "iso2": "vn" }`（以 `i18n-iso-countries` 由 numeric id 轉 alpha-2，轉不到的國家略過；不含南極洲）。必須包含新加坡（sg）、馬爾地夫（mv）等小國（用 50m 版再簡化），gzip ≤ 120 KB。國名由前端 `Intl.DisplayNames` 產生。

### manifest.sources.travel

`{ "ok", "stale", "fetchedAt", "records"(新聞則數), "updated"(= travel.updated) }`，語意同其他來源。

### v2 實作備註

- `imported.json.events` 同一天同一國的多筆已合併；全部 `events` 的病例數總和等於 `countries.*.byYear` 的總和（manifest `imported.records`）。舊的（尚未重建的）`imported.json` 可能沒有 `events`，前端需容忍。
- `travel.levels.*.zh` 經 NFKC（全形冒號變半形 `:`），並去掉 safetravel 原文結尾的英文括號（「第一級:注意（Watch）」→「第一級:注意」）。
- `travel.countries.*.vb[].since` 為建議生效日；來源日期無效時為 `null`。`level` 由有效建議重新計算（不採用來源的 `max_level`）。
- `travel.news` 的 2 年視窗以台灣日期 `today` 往前 730 天計；`d` 順序固定為 dengue, chikungunya, zika, yellowFever, malaria, japaneseEncephalitis, westNile。
- 驗證：有效國家 < 150 或缺任一 `levels` 即視為來源失敗（保留前一版 `travel.json`，manifest 標 `stale`）。安全上限：單一檔案 8 MB。環境變數 `TRAVEL_BASE_URL` 可覆寫來源路徑。
- `geo/world.topo.json` 每次執行都從 `world-atlas`（countries-50m）離線重建（約 0.5 秒，位元組穩定，無變動即不寫檔）；不屬於 manifest 的 `sources`。
