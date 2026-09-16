# Chris H. — Photography Portfolio

無框架、無建置流程的靜態作品集。前台讀 `data/photos.json` 渲染；後台
`admin.html` 直接用 GitHub API 把改動 commit 進這個 repo，Pages 再自動重新部署。
沒有伺服器、沒有資料庫、沒有月費。

```
index.html            前台
admin.html            後台（noindex，需要 token 才能操作）
assets/
  app.js              前台邏輯
  admin.js            後台邏輯（壓縮、排序、發佈）
  style.css           前台樣式
  admin.css           後台樣式
data/photos.json      唯一的資料來源：順序、尺寸、說明、封面、個人資料
photos/               圖檔：<id>.webp 與 <id>-thumb.webp
```

## 一、建立 repo 並上線

```bash
cd /Users/chris/Documents/projects/my_portfolio
git init -b main
git add -A
git commit -m "portfolio: initial"
gh repo create helloworld-chrish.github.io --public --source=. --push     # 或到 github.com 手動建立後 git push
```

到 repo 的 **Settings → Pages**，Source 選 `Deploy from a branch`，
分支選 `main` / 根目錄 `/`，存檔。約一分鐘後網址是：

```
https://helloworld-chrish.github.io/
```

想用自訂網域：Pages 設定頁填入網域，並在網域商那邊把 `www` 指向
`<你的帳號>.github.io`（CNAME）。倉庫裡會自動多一個 `CNAME` 檔。

## 二、建立後台用的 token

1. 開 https://github.com/settings/personal-access-tokens/new
2. **Repository access** → Only select repositories → 選這個 repo
3. **Permissions → Repository permissions → Contents** → `Read and write`
   （其他權限一律不要給）
4. Expiration 建議設 90 天，到期再換一次
5. 產生後複製 `github_pat_...`

## 三、使用後台

開 `https://helloworld-chrish.github.io/admin.html`，填入帳號、repo、
分支、token → 連線。Token 只存在該瀏覽器的 localStorage，不會送往任何第三方；
公用電腦用完請按「清除 token」。

- **新增**：拖曳或選檔。上傳前會在瀏覽器裡壓成長邊 2400px 的 WebP
  （品質 0.82）外加 600px 縮圖，原始的幾十 MB 檔案不會進 repo。
- **排序**：拖曳卡片，或用 ◀ ▶ 按鈕（觸控與鍵盤可用）。
- **封面**：決定 hero 大圖，同時會同步 `index.html` 的 `og:image`。
- **刪除**：發佈後才真的從 repo 移除；誤刪可用 `git revert` 救回。
- **發佈**：所有改動（新圖、刪圖、photos.json、index.html）合併成
  **一個 commit**，所以只會觸發一次部署，約 30–60 秒後生效。

## 四、本機預覽

`fetch()` 不能在 `file://` 下讀 JSON，請用簡易伺服器：

```bash
python3 -m http.server 8000
# 前台 http://localhost:8000/
# 後台 http://localhost:8000/admin.html
```

本機後台一樣是 commit 到 GitHub（不是改本機檔案），改完記得 `git pull`。

## 已知取捨

- 照片存在 git 裡。一般作品集（數百張、每張 ~300KB）完全沒問題；真的成長到
  好幾 GB 再考慮搬去物件儲存。
- 發佈有 30–60 秒延遲，這是 Pages 重新部署的時間。
- Token 放在 localStorage。權限已限縮到單一 repo 的 Contents，外流最壞情況
  是該 repo 被改動，且 git 保有完整歷史可還原。
- 照片清單由 JS 在前台渲染，搜尋引擎需要執行 JS 才看得到圖；標題、描述、
  og:image 則是靜態寫在 HTML 裡，社群分享預覽正常。
