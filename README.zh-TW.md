# dsh-threads-tools

> 把 Threads 自動化變成 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的 agent 工具。
> 滑推薦流、自己挑貼文留言、回覆來留言的人、發文——全部透過**真實、已登入的瀏覽器**，不是 API。

Threads 沒有給個人帳號用的公開 API，所以大部分「自動化 Threads」最後都變成一支用完就丟的腳本。
這個專案把它做成一個可重複使用的 DSH 插件：七個工具，agent 直接呼叫，狀態、額度、去重都處理好。

**套件名稱：** `dsh-threads-browser-local`
**授權：** MIT

---

## 為什麼有這個

目標是讓一個 agent 自己滑 Threads 推薦流、自己挑要回什麼、回答誰回了我、然後發文，不用我在旁邊盯。
這需要四件 LLM 光靠嘴巴做不到的事：

1. **看到真頁面。** 通知在登入牆後面。
2. **動手。** 點、打字、附圖、發佈——而且要能判斷到底成功沒。
3. **不要變成 spam bot。** 去重、限流、同一個人一天只回一次。
4. **要記得。** 回過哪些帳號、哪些通知處理過了、今天已經動了幾次手——重啟之後不會變成累犯。

插件負責 (2) 和 (3)，(1) 的 session 由 DSH 提供。

---

## 工具

| 工具 | 做什麼 |
| --- | --- |
| `threads_status` | 登入狀態、目前頁面、今日額度、設定的帳號。**先呼叫這個**。 |
| `threads_notifications` | 讀「動態 → 回覆」：誰回了我的留言。預設只回「還沒回過」的。 |
| `threads_reply` | 回覆其中一則。可純文字、貼圖，或兩者。 |
| `threads_peek` | 只讀：打開一則留言頁，回傳可見文字與大張圖片 URL（純圖留言用）。 |
| `threads_feed` | 讀首頁推薦流——別人的貼文與貼文網址。 |
| `threads_comment` | 在別人的貼文下留言。 |
| `threads_post` | 發一篇新串文，可附圖。 |

需要圖片時 `imagePath` 吃絕對路徑。所有工具**不拋錯**，一律回 `{ tool, result }`；
點擊失敗就回 `{ ok: false, error }`，讓 agent 能自己重試或改方法。

---

## 需求

- **Node.js** >= 22.13
- **DSH** 0.2.x（這是一個 DSH 工具 bundle，不是獨立套件）
- **Microsoft Edge**——控制器用 `channel: "msedge"` 啟動 Chromium
- 能解析到 `playwright-core`（插件目錄或 DSH profile 皆可）
- 一個你願意在這台機器登入的 Threads 帳號

---

## 安裝

1. 把 repo 抓下來：

   ```bash
   git clone <your-repo-url> dsh-threads-tools
   ```

2. 裝 Playwright 的驅動（裝在插件目錄或 DSH profile 目錄都可以，載入器會依序找）：

   ```bash
   cd dsh-threads-tools
   npm install playwright-core
   ```

3. 在 DSH profile 註冊插件。編輯
   `%USERPROFILE%\.dsh\profiles\desktop\package.json`（Windows）或
   `~/.dsh/profiles/<profile>/package.json`：

   ```json
   {
     "dependencies": {
       "dsh-threads-browser-local": "link:/absolute/path/to/dsh-threads-tools"
     },
     "dsh": {
       "profile": {
         "bundles": ["...你原本的 bundle...", "dsh-threads-browser-local"]
       }
     }
   }
   ```

   名稱要跟 `package.json` 一致；真正讓它被載入的是 `bundles` 那一行。

4. 重啟 DSH。

5. 告訴插件你是誰，然後登入一次：

   ```bash
   setx THREADS_ME your_handle      # Windows，不含 @
   export THREADS_ME=your_handle    # macOS / Linux
   ```

   重啟 DSH 讓它吃到環境變數。接著呼叫 `threads_status`——第一次會開一個 Edge 視窗，
   在那裡登入 Threads。profile 會保留，之後不用再登入。

6. 不開瀏覽器的基本檢查：

   ```bash
   node test/smoke.mjs   # → OK — 7 tools registered
   ```

---

## 設定

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `THREADS_ME` | （空） | 你的帳號，不含 `@`。用來分辨「哪則是我自己發的」。 |
| `THREADS_PROFILE_DIR` | `~/.dsh/threads-browser/profile` | 瀏覽器 profile 位置（存登入狀態）。 |
| `DSH_PROFILE_DIR` | `~/.dsh/profiles/desktop` | 載入器找 `playwright-core` 的地方。 |

執行期狀態（回過誰、看過哪些留言、今日額度）存在
`~/.dsh/threads-browser/state.json`——**絕對不要提交**，本 repo 的 `.gitignore` 已排除。

---

## 它怎麼運作

**Session 層。** 用 `chromium.launchPersistentContext()` 開 Edge channel。登入只做一次，
之後重複使用同一個 profile。context 死掉（瀏覽器被關）會被偵測並重開，而不是快取一個壞掉的 handle。

**DOM 啟發式。** Threads 沒有穩定的 selector，所以控制器抓 UI 實際渲染出來的東西：

- `[data-pressable-container="true"]`——每一張貼文／通知卡片
- `svg > title` 的文字（`回覆`、`發佈`）——找正確的圖示按鈕，因為可點擊目標是 SVG 的祖父節點
- `[data-lexical-editor="true"]`——輸入框；被 placeholder 覆蓋層擋住時改用 DOM focus，而不是硬點

**已回覆與否的判斷。** 用兩個獨立訊號，因為兩邊都會說謊：

- 動態列表上：卡片底部「回覆」圖示，已回是實心勾（`<path>` 子節點為 0），未回是空心氣泡（1 個 `<path>`）。
- 帖子頁上：我對某則留言的回覆會緊貼在它上方（最近排序）或下方（升序）——所以「隔壁是不是我」就是訊號。

**不要被排序埋掉。** 帖子頁一律帶 `?sort_order=recent&filter_type=all`。預設的熱門排序會把新留言壓得太下面，
照原本的做法回覆會默默對不到人。

**刻意的護欄。** 這些工具是給一個「人格」用的，不是給行銷漏斗用的，所以插件自己限制自己：
一天 60 次回覆／留言、同一個帳號一天一次、`seen` 快取上限 1200 筆（同一則通知重讀不吃 token）。
每個寫入動作都會事後驗證——工具會輪詢「已發佈」或輸入框被清空才回報成功，而不是假設點擊生效。

---

## 限制

- **只支援繁體中文介面。** 按鈕比對用的是字面字串：`回覆`、`發佈`、`新串文`、`附加影音內容`、`尚無回覆`。
  要國際化就得把這些字串集中管理，歡迎 PR。
- **與 DOM 綁死。** Threads 隨時可能改版。這是「沒有 API 的目標」的先天限制，不是設計失誤。
- **不是 headless、不是伺服器。** 它刻意用可見視窗跑真實 profile。
- **非官方。** 與 Threads、Meta 沒有關係。自動化平台可能違反其服務條款。請自行承擔風險、低頻使用，
  不要拿來騷擾人或洗版。
- **個資。** 它是對著你自己的帳號跑的；狀態檔會記錄你回過哪些帳號。`state.json` 和瀏覽器 profile 都當私密資料看。

---

## 授權

MIT——見 [LICENSE](LICENSE)。
