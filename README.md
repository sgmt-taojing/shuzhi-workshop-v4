# 数造工坊 V4 · 数字化转型一站式服务平台

## 快速开始

### 在线预览
- 🏠 [平台首页](https://sgmt-taojing.github.io/shuzhi-workshop-v4/)
- 📊 [V4 演示版](https://sgmt-taojing.github.io/shuzhi-workshop-v4/v4-online.html)
- 🔧 [管理后台](https://sgmt-taojing.github.io/shuzhi-workshop-v4/admin.html)（演示模式）
- 📱 [H5 首页](https://sgmt-taojing.github.io/shuzhi-workshop-v4/h5/index.html)

### 本地部署

```bash
cd backend
cp .env .env  # 修改配置
npm install
node server.js
```

访问 http://localhost:3004/admin/（admin / admin123）

### Docker 部署

```bash
cd backend
docker compose up -d
```

详见 [部署指南](backend/DEPLOY.md)

## 系统组成

| 模块 | 路径 | 说明 |
|------|------|------|
| 管理后台 | backend/admin-web/ | 60+ 功能页面，Toast通知，全局搜索 |
| H5 移动端 | backend/wechat-h5/ | 6 个角色页面，AI助手，语音交互 |
| V4 演示版 | v4-online.html | 4Tab 闭环模型，AI助手，语音 |
| API 后端 | backend/routes/ | 61 个路由模块，129 张数据表 |
| AI 客服 | /api/chatbot | 智能匹配 + FAQ + 产品推荐 |

## 默认账号

| 账号 | 密码 | 角色 |
|------|------|------|
| admin | admin123 | 超级管理员 |
| channel_mgr | admin123 | 渠道经理 |
| consultant1 | admin123 | 顾问 |
| delivery1 | admin123 | 交付 |
| ops_mgr | admin123 | 运营经理 |
| finance1 | admin123 | 财务 |

## 技术栈

- **后端**: Node.js + Express + better-sqlite3
- **前端**: 纯 HTML/CSS/JS（无构建步骤）
- **部署**: Docker / PM2 / 直接启动
- **数据库**: SQLite（零配置，文件即数据库）

## License

MIT
