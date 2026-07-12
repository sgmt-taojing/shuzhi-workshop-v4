# 数智工坊全量盘点报告

> 2026-07-12 21:50 · 从后端到前端到小程序到演示版的全系统盘点

## 一、系统架构总览

| 模块 | 技术栈 | 规模 | 状态 |
|------|--------|------|------|
| 后端服务 | Node.js + Express + SQLite | 61路由, 128表, 68JS文件 | 运行中:3004 |
| 管理后台 | 原生HTML单页 | 573KB, 30+功能模块 | 运行中 |
| H5端 | 6个独立页面 | 公众号/员工/代理商/企业/政府/验收 | 运行中 |
| 小程序 | 原生微信小程序 | 75页面(10主包+65分包), 72JS文件 | 源码就绪 |
| 移动端 | HTML5 | 84KB单页 | 运行中 |
| 演示版 | 纯HTML/CSS/JS | V4.0 在线55KB+离线647KB | GitHub Pages |
| dt-system | Python+SQLite | 知识库系统 | 本地 |

## 二、后端服务详情

### API 路由 (61个路由文件)
- **200 OK**: products, articles, clients, banners, bookings, quotes, policies, projects, enterprise, agents, delivery, steward, providers, coupons, reviews, notifications, search, config, contact, client-products
- **404 (子路由模式,正常)**: auth, wechat, pay, admin, faqs, partners, campaigns, assessments, analytics, chatbot, contracts, services, marketing, commerce, charity, group-buy, platform, h5auth, analytics-v2
- **401 (需认证)**: onboarding, feedback, audit-logs
- **400 (需参数)**: invoices, tickets, contracts
- **JS语法**: 68个文件, 0错误

### 数据库 (128表, 2.1MB)
- **有数据**: 65+表
- **空表**: 18表（运营类: 佣金/积分兑换/关注/通知已读等,合理）
- **核心数据**: 16产品, 27文章, 30FAQ, 32客户, 99政策, 33企业画像, 49甲方产品, 10订单, 4代理商, 5服务商, 6项目

### 管理后台功能模块 (30+)
仪表盘, 数据分析, 咨询管理, 线索管线, 入驻管理, 客户管理, CRM项目, 项目管理, 商机管理, 财务管理, 团队管理, 日报审核, 报价工具, 内部知识库, 产品管理, 甲方产品, SKU管理, 甲方企业, 订单管理, 退款管理, 代理商管理, 交付跟踪, 企业管家, 服务商管理, 资金池看板, AI诊断, 文章管理, 评价管理, 发票管理, 合同管理

## 三、前端页面

| 页面 | URL | 大小 | HTTP |
|------|-----|------|------|
| 管理后台 | /admin/ | 573KB | 200 |
| 运营大屏 | /screen | 41KB | 200 |
| H5首页 | /h5/ | 99KB | 200 |
| 员工工作台 | /h5/work.html | 39KB | 200 |
| 代理商工作台 | /h5/agent.html | 32KB | 200 |
| 企业管家 | /h5/enterprise.html | 23KB | 200 |
| 政府监管 | /h5/gov.html | 7KB | 200 |
| 验收打卡 | /h5/checkin.html | 7KB | 200 |

## 四、演示版 V4.0

- **外网**: https://sgmt-taojing.github.io/shuzhi-workshop-v4/
- **GitHub**: https://github.com/sgmt-taojing/shuzhi-workshop-v4
- **4Tab**: 企业宣传 / 源头甄选 / 产业链撮合 / 产品推广
- **特性**: SEO meta, OG标签, ARIA, 键盘导航, 加载动画, 移动端480px适配, 横屏适配, 打印样式

## 五、本轮优化完成项

| 优化 | 说明 |
|------|------|
| banners 填充 | 3条banner数据 |
| feedbacks 填充 | 3条用户反馈 |
| crm_leads 填充 | 3条商机线索 |
| maintenance_tickets 填充 | 2条维护工单 |
| start.sh 路径修正 | 旧路径.qclaw → 动态dirname |
| V4.0.1 移动端适配 | 480px断点+触摸优化+加载动画+打印样式 |
| GitHub Pages 部署 | 外网可访问 |

## 六、剩余待优化项

| 优先级 | 项目 | 说明 |
|--------|------|------|
| P2 | 根目录12个散落HTML | 已归档,原文件可清理 |
| P2 | bookings 表空 | 预约功能未上线 |
| P3 | 微信支付模拟模式 | placeholder appid/key |
| P3 | launchd 服务未注册 | 重启需手动启动 |
| P3 | 小程序未发布 | 需微信开发者工具上传 |
| P3 | dt-system 未集成 | 知识库独立运行 |
