# 疾管署開放資料上傳器（台灣電腦排程）

疾管署開放資料 `Dengue_Daily.csv`（1998 年起每一筆確定病例，每日更新）只允許**台灣 IP** 下載，
GitHub Actions 的主機在美國，連不到。這個小工具在你**台灣的 Ubuntu 電腦**上定時：

1. 從 `https://od.cdc.gov.tw/eic/Dengue_Daily.csv` 下載檔案，檢查表頭與筆數；
2. 有變動時，把壓縮後的 `Dengue_Daily.csv.gz` 上傳到 GitHub repo `ancientsky/dengue-opendata` 的 `latest` release；
3. 每次成功都上傳 `Dengue_Daily.meta.json`（下載時間、SHA-256、行數），讓網站的資料管線知道檔案是新的。

登革熱地圖的資料管線（每小時）會讀這份檔案，補上原網站後端漏掉的病例（2021 年起逐點合併）。
電腦關機、斷網或上傳器停了超過 3 天，管線會自動忽略開放資料，改回只用原網站後端，網站不會壞。

> 為什麼另開一個 repo？上傳用的 token 只能寫入 `dengue-opendata`。萬一這台電腦或 token 外洩，
> 也改不到網站本身的程式碼（`denguemap`）。

---

## 一次性設定（約 15 分鐘）

### 步驟 1：在 GitHub 建立 `dengue-opendata` repo 與 `latest` release

1. 打開 <https://github.com/new>：
   - Repository name：`dengue-opendata`
   - 選 **Public**（管線不帶 token 下載；這份資料本來就是政府公開資料）
   - 勾選 **Add a README file**（release 需要至少一個 commit）
   - 按 **Create repository**。
2. 在新 repo 頁面右側點 **Releases → Create a new release**（或打開
   `https://github.com/ancientsky/dengue-opendata/releases/new`）：
   - **Choose a tag** 輸入 `latest`，選「Create new tag: latest on publish」
   - Release title 填 `latest`，說明可寫「疾管署 Dengue_Daily.csv 每日鏡像（自動上傳）」
   - 按 **Publish release**（先不用附檔案）。

### 步驟 2：建立只能寫入這個 repo 的 token

1. 打開 <https://github.com/settings/personal-access-tokens/new>（Fine-grained token）。
2. 填寫：
   - **Token name**：`dengue-opendata-uploader`
   - **Expiration**：選最長的期限（例如 1 年），並在行事曆記下到期日，到期前重做這個步驟
   - **Resource owner**：`ancientsky`
   - **Repository access**：**Only select repositories** → 選 `ancientsky/dengue-opendata`（只選這一個）
   - **Permissions → Repository permissions → Contents**：**Read and write**
     （`Metadata: Read-only` 會自動加上；其他都不要給）
3. 按 **Generate token**，複製 `github_pat_…` 開頭的字串。**這個字串只會顯示一次**，下一步會用到。

### 步驟 3：在 Ubuntu 26.04 安裝工具與排程

打開「終端機」，逐段貼上執行。

```bash
# 3-1 安裝需要的程式（curl、GitHub CLI）
sudo apt update
sudo apt install -y curl gh

# 3-2 下載上傳器與 systemd 排程檔
mkdir -p ~/.local/bin ~/.config/dengue-opendata ~/.config/systemd/user
BASE=https://raw.githubusercontent.com/ancientsky/denguemap/main/tools/opendata-uploader
curl -fsSL "$BASE/dengue-opendata-upload.sh" -o ~/.local/bin/dengue-opendata-upload.sh
curl -fsSL "$BASE/dengue-opendata.service"   -o ~/.config/systemd/user/dengue-opendata.service
curl -fsSL "$BASE/dengue-opendata.timer"     -o ~/.config/systemd/user/dengue-opendata.timer
chmod +x ~/.local/bin/dengue-opendata-upload.sh
```

建議先看一下腳本內容（`less ~/.local/bin/dengue-opendata-upload.sh`），它只會下載疾管署檔案並上傳到 GitHub。

```bash
# 3-3 存放 token（輸入時畫面不會顯示；檔案只有你自己能讀）
read -rsp '貼上 GitHub token 後按 Enter：' t && echo \
  && printf 'GH_TOKEN=%s\n' "$t" > ~/.config/dengue-opendata/env \
  && unset t && chmod 600 ~/.config/dengue-opendata/env
```

```bash
# 3-4 先手動跑一次，確認可以下載與上傳
systemctl --user daemon-reload
systemctl --user start dengue-opendata.service
journalctl --user -u dengue-opendata.service -n 20 --no-pager
```

看到下列兩行就成功了：

```
uploaded Dengue_Daily.csv.gz (107823 lines, sha256 …)
uploaded Dengue_Daily.meta.json
```

```bash
# 3-5 啟用排程（每 4 小時一次；電腦關機錯過的話，開機後補跑）
systemctl --user enable --now dengue-opendata.timer

# 3-6 讓排程在你沒有登入時也會執行（例如重開機後還沒登入）
sudo loginctl enable-linger "$USER"

# 確認下次執行時間
systemctl --user list-timers dengue-opendata.timer
```

### 步驟 4：確認網站有在用

- 打開 `https://github.com/ancientsky/dengue-opendata/releases/tag/latest`，應該看到
  `Dengue_Daily.csv.gz` 和 `Dengue_Daily.meta.json`。
- 下一次 `data` workflow（每小時第 23 分左右）的紀錄裡會有：
  `open data: 107822 rows, newest confirmation 2026-11-25, downloaded …`。
  Step summary 也會列出「Open data: … cases added beyond the backend」。

---

## 日常與維護

| 想做的事 | 指令 |
|---|---|
| 看最近幾次的執行結果 | `journalctl --user -u dengue-opendata.service -n 50 --no-pager` |
| 立刻跑一次 | `systemctl --user start dengue-opendata.service` |
| 看下次排程時間 | `systemctl --user list-timers dengue-opendata.timer` |
| 暫停排程 | `systemctl --user disable --now dengue-opendata.timer` |
| 換新的 token（到期或外洩時） | 重做步驟 2，再重跑 3-3；舊 token 到 GitHub 設定頁刪除 |
| 更新上傳器 | 重跑 3-2 的 `curl` 那幾行，再 `systemctl --user daemon-reload` |

## 疑難排解

- **`curl: (28) … timed out` 或連不上 od.cdc.gov.tw**：要用台灣的網路。若開著海外 VPN，請關閉或讓
  `od.cdc.gov.tw` 不走 VPN。
- **`HTTP 403` / `Resource not accessible by personal access token`**：token 沒選到 `dengue-opendata`，
  或 Contents 不是 Read and write。重做步驟 2。
- **`release not found`**：還沒建立 `latest` release（步驟 1-2），或 tag 名稱不是 `latest`。
- **`GH_TOKEN is not set`**：`~/.config/dengue-opendata/env` 不存在或內容不是 `GH_TOKEN=…`，重跑 3-3。
- **`unexpected content` / `only N lines`**：疾管署檔案當下不完整或格式變了。這次不會上傳任何東西，
  下次排程會再試；若持續發生，請回報。
- **網站沒有用到開放資料**：看 `data` workflow 紀錄中 `open data` 開頭的那行。`not published yet` 表示 release
  裡還沒有檔案；`is stale` 表示超過 3 天沒有成功上傳（電腦關機或排程停了）。

## 用其他 repo 或位置

上傳到別的 repo：在 `~/.config/dengue-opendata/env` 加一行 `DENGUE_OPENDATA_REPO=owner/repo`；
網站端則在 denguemap 的 **Settings → Secrets and variables → Actions → Variables** 新增 `OPENDATA_URL`，
值為 `https://github.com/owner/repo/releases/download/latest/Dengue_Daily.csv.gz`。
