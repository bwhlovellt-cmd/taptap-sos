# 双击守护 - 部署指南

## 方式一：腾讯云轻量应用服务器（强烈推荐）

国内延迟最低，全程中文界面，无需翻墙。

### 1. 购买服务器

打开 [腾讯云轻量应用服务器](https://cloud.tencent.com/product/lighthouse)，选择：
- **应用镜像** → Node.js（系统会自动安装 Node.js + PM2）
- **地域** → 选离你最近的（北上广深）
- **套餐** → 基础版 ¥28/月（2核1G，够用）

### 2. 部署项目

购买后进入控制台 → 一键登录（网页版终端），依次执行：

```bash
# 克隆项目
git clone https://github.com/bwhlovellt-cmd/taptap-sos.git
cd taptap-sos

# 安装依赖
npm install

# 启动服务（PM2 守护，断线不掉）
pm2 start server.js --name taptap-sos

# 开机自启
pm2 save
pm2 startup
```

### 3. 防火墙放行

腾讯云控制台 → 防火墙 → 添加规则：
- 端口：`3456`，协议：`TCP`

### 4. 访问

你的公网地址就是 `http://你的服务器IP:3456`

**两台手机打开这个地址 → 生成配对码 → 配对 → 开始使用！**

---

## 方式二：局域网测试（免费）

电脑运行：
```bash
cd taptap-sos
node server.js
```

手机和电脑连同一个 WiFi，浏览器打开 `http://电脑IP:3456`

---

## 方式三：Railway（国外免费，偶尔抽风）

1. 打开 [railway.app](https://railway.app)，GitHub 登录
2. New Project → Deploy from GitHub repo → 选 `bwhlovellt/taptap-sos`
3. 自动检测 `package.json` 中的 `start` 脚本，部署完成
4. 获得 `xxx.up.railway.app` 地址
