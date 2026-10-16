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
  "files": { "summary.json": "a1b2c3d4", "cases/2026.json": "…" }   // 內容 sha256 前 8 碼，前端用作 ?v= 快取鍵
}
```
`stale: true` 代表這次抓取失敗、沿用上一版；`fetchedAt` 是該份資料實際成功抓取的時間。

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
  "prevYtd": { "local": 20, "imported": 160 },        // 去年同期（1/1 到去年同月同日）
  "byCounty": { "64000": { "local": 10, "imported": 32 } },   // 今年累計
  "topTowns14": [["64000090", 2, 0]]                  // 近 14 天 [townCode, local, imported]，依 local 遞減，最多 20
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
