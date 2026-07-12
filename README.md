# 数智工坊 · 企业后服务 V4.0

> 文（文化宣传）· 影（短视频）· 商（甄选商城）城立品牌，撮合产业链，严选源头好货，赋能万家，让天下没有难做的生意

## 快速开始

### 离线版（双击即开）
```
v4.0-数智工坊_离线版.html (643KB)
```
4张图片已 base64 内联，零外部依赖。

### 在线版（需配合 assets/ 目录）
```
v4.0-数智工坊_在线版.html (55KB)
assets/
  ├── old-press.png        # 老式木榨机
  ├── old-craftsman.jpg    # 匠人坚守
  ├── old-workshop.jpeg    # 老油坊烟火
  └── ningxia-yellow-river.jpg  # 黄河宁夏平原
```

## 四大模块

| Tab | 模块 | 核心内容 |
|-----|------|----------|
| 🏢 企业宣传 | 文影商城三维一体 | 品牌故事 + 短视频 + 商城转化 |
| 🌾 源头甄选 | 五步甄选链路 | 产地→考察→检测→资质→溯源 |
| 🤝 产业链撮合 | 上中下游全景 | 原料→生产→平台→渠道 |
| 📦 产品推广 | 5款核心SKU | 零售/大宗/扶贫/团购/食堂/福利 |

## 技术栈

- 纯原生 HTML/CSS/JS，零框架依赖
- IIFE + addEventListener，零 event.target
- CSS 变量驱动品牌色系统
- 响应式 @media 断点 768px / 700px
- 支持键盘导航（Tab/方向键切换）
- ARIA 属性完备（aria-selected/aria-controls/aria-label）
- SEO meta + Open Graph 标签

## 部署到 GitHub Pages

```bash
# 1. 创建仓库
git init
git add .
git commit -m "V4.0 数智工坊企业后服务"

# 2. 推送到 GitHub
git remote add origin https://github.com/用户名/shuzhi-workshop-v4.git
git push -u origin main

# 3. 启用 GitHub Pages
# Settings → Pages → Source: main branch → / (root)
# 访问: https://用户名.github.io/shuzhi-workshop-v4/
```

## 版本历史

- V4.0 (2026-07-12) — 四维架构：文影商城 + 源头甄选 + 产业链撮合 + 产品推广
- V3.1 (2026-07-12) — JS修复 + 马季品牌色 + 视觉升级
- V3.0 (2026-07-12) — 数智工坊标准版，3Tab
- V2.x (2026-07-03) — 全域数字产业生态平台
- V1.x (2026-07-03) — 初版演示
