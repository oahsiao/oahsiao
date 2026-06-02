# Setup Guide

## 1. 建立 Profile Repo

GitHub 上建立一個 repo，名稱必須等於你的帳號：
```
oahsiao/oahsiao
```
設為 Public，勾選 Add a README file。

## 2. 建立 PAT Token

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens

權限設定：
- Repository access: M2Station org → All repositories
- Permissions:
  - Contents: Read
  - Metadata: Read
  - Organization → Members: Read

複製 token 備用。

## 3. 加入 Secret

到 `oahsiao/oahsiao` repo → Settings → Secrets and variables → Actions

新增：
```
Name:  PROFILE_TOKEN
Value: (貼上剛才的 PAT)
```

## 4. 上傳檔案

把以下結構推到 oahsiao/oahsiao repo：

```
oahsiao/
├── .github/
│   └── workflows/
│       └── update-profile.yml
├── scripts/
│   ├── package.json
│   └── generate.js
├── assets/           ← 空目錄，Actions 會自動產生 SVG
│   └── .gitkeep
└── README.md
```

## 5. 手動觸發測試

repo → Actions → Update Profile Stats → Run workflow

跑完後 assets/ 資料夾會出現：
- org-commits.svg
- org-languages.svg
- org-hours.svg

## 6. 之後每天自動跑

Actions 設定為台灣時間每天早上 10:00 自動執行。

---

## Token 注意事項

- Fine-grained PAT 有效期最長 1 年，到期前記得更新 Secret
- Classic PAT 可設 no expiration，但權限較寬
- Token 只需要 read 權限，不需要 write（write 由 GITHUB_TOKEN 處理）
