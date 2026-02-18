# GetWeb · 网页打包EXE

> 填写网址，一键打包成 Windows 桌面应用（EXE），无需任何本地环境。

## ✨ 特性

- 🌐 **纯在线操作** — 打开网页填表单，坐等下载
- ⚡ **GitHub Actions 构建** — 云端编译，不占用本地资源
- 🖥️ **Electron 封装** — 兼容所有 Windows 系统，开箱即用
- 🎨 **自定义图标** — 支持 PNG / ICO 格式图标
- 📋 **构建历史** — 随时查看历史记录，随时下载
- 🔑 **多 Token 支持** — 可添加多个 GitHub Token 负载均衡

## 🏗️ 技术架构

```
用户浏览器
    ↓ 填写网址/名称/图标
Cloudflare Worker
    ↓ 调用 GitHub API 触发
GitHub Actions（Windows Runner）
    ↓ Electron + Electron-Builder 打包
Artifact（ZIP 内含 EXE）
    ↓ Worker 代理下载
用户下载
```

## 🚀 部署教程

### 前置要求

- Cloudflare 账号（免费版即可）
- GitHub 账号

### 第一步：点击Star🌟，Fork 构建仓库

Fork [ZhangShengFan/GetWeb](https://github.com/ZhangShengFan/GetWeb) 到自己账号，然后在 Actions 页面点击 **Enable workflows**。

### 第二步：创建 Cloudflare D1 数据库

在 Cloudflare Dashboard → D1 → 创建数据库，名称填 `web`，然后在 Studio 执行：

```sql
CREATE TABLE tokens (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  token    TEXT NOT NULL,
  label    TEXT DEFAULT '',
  repo     TEXT NOT NULL DEFAULT '',
  added_at TEXT
);

CREATE TABLE builds (
  id              TEXT PRIMARY KEY,
  app_name        TEXT,
  url             TEXT,
  version         TEXT,
  icon_url        TEXT,
  status          TEXT DEFAULT 'pending',
  run_id          TEXT,
  download_ready  INTEGER DEFAULT 0,
  triggered_at    TEXT,
  created_at      TEXT,
  repo            TEXT DEFAULT ''
);
```

### 第三步：创建 Cloudflare Worker

1. Dashboard → Workers & Pages → 创建 Worker
2. 将 `worker.js` 内容粘贴进去，Deploy
3. 在 Worker **设置 → 绑定** 中添加 D1 绑定，变量名 `DB`，选择刚创建的数据库
4. 重新 Deploy

### 第四步：添加 GitHub Token

访问你的 Worker 地址 + `/token`，添加 GitHub Personal Access Token（需要 `repo` + `workflow` 权限），填写 Fork 后的仓库名。

### 第五步：开始使用

访问 Worker 主页，填写目标网址即可开始打包！

## 📁 文件说明

| 文件 | 说明 |
|------|------|
| `worker.js` | Cloudflare Worker 主程序 |
| `.github/workflows/build.yml` | 放在构建仓库中，GitHub Actions 打包脚本 |

## ⚠️ 注意事项

- 打包产物为 ZIP 文件，解压后运行 EXE 即可
- EXE 体积约 100-150MB（Electron 内含 Chromium）
- GitHub Actions 免费版每月有 2000 分钟额度，每次构建约 5-10 分钟
- Artifact 默认保留 90 天，过期后无法下载

## 📄 License

MIT © ZhangShengFan
