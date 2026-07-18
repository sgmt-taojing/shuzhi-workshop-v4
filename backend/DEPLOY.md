# 数造工坊 · 部署指南

## 一、系统架构

```
                    ┌─────────────┐
                    │   Nginx     │ :80/:443
                    │  静态+反代   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        /admin/       /h5/         /api/
        静态HTML      静态HTML     反代到后端
              │            │            │
              │            │     ┌──────▼──────┐
              │            │     │  Node.js    │ :3004
              │            │     │  Express    │
              │            │     └──────┬──────┘
              │            │            │
              │            │     ┌──────▼──────┐
              │            │     │  SQLite     │
              │            │     │  dt-mall.db │
              │            │     └─────────────┘
              │            │
     admin-web/      wechat-h5/    61个API路由
```

## 二、部署方式

### 方式 A：直接部署（最简单）

```bash
# 1. 进入后端目录
cd dt-mall/backend

# 2. 复制环境配置
cp .env.example .env
# 编辑 .env 修改配置

# 3. 安装依赖
npm ci --production

# 4. 启动
NODE_ENV=production node server.js

# 或用部署脚本
./deploy.sh
```

### 方式 B：PM2 部署（推荐生产）

```bash
# 1. 安装 PM2
npm install -g pm2

# 2. 启动
pm2 start server.js --name shuzhi-workshop --env production

# 3. 设置开机自启
pm2 startup
pm2 save

# 4. 查看日志
pm2 logs shuzhi-workshop

# 5. 重启/停止
pm2 restart shuzhi-workshop
pm2 stop shuzhi-workshop
```

### 方式 C：Docker 部署

```bash
# 1. 构建并启动
docker compose up -d

# 2. 查看日志
docker compose logs -f

# 3. 停止
docker compose down
```

### 方式 D：Nginx + Node 反代部署

```bash
# 1. 启动后端
cd dt-mall/backend
npm ci --production
pm2 start server.js --name shuzhi-workshop

# 2. 配置 Nginx
# 将 nginx.conf 复制到 /etc/nginx/conf.d/
# 修改 server_name 和路径
nginx -s reload
```

## 三、环境变量配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| PORT | 服务端口 | 3004 |
| NODE_ENV | 运行环境 | development |
| WX_APPID | 微信小程序 AppID | - |
| WX_SECRET | 微信小程序 Secret | - |
| WX_PAY_MCHID | 微信支付商户号 | - |
| WX_PAY_API_KEY_V3 | 微信支付 V3 密钥 | - |
| WECHAT_TEMPLATE_ID | 模板消息 ID | - |
| WECOM_CORP_ID | 企业微信 CorpID | - |

## 四、目录结构

```
dt-mall/backend/
├── server.js              # 入口文件
├── package.json           # 依赖配置
├── .env                   # 环境变量（不入版本库）
├── .env.example           # 环境变量模板
├── .env.production        # 生产环境配置
├── deploy.sh              # 一键部署脚本
├── Dockerfile             # Docker 构建文件
├── docker-compose.yml     # Docker Compose 编排
├── nginx.conf             # Nginx 配置
├── .dockerignore
├── data/
│   └── dt-mall.db         # SQLite 数据库（自动创建）
├── uploads/               # 上传文件目录
├── admin-web/
│   └── index.html         # 管理后台（575KB 单文件）
├── wechat-h5/
│   ├── index.html         # H5 首页（121KB）
│   ├── work.html          # 员工工作台
│   ├── agent.html         # 代理商工作台
│   ├── enterprise.html    # 企业服务
│   ├── gov.html           # 政府监管
│   └── checkin.html       # 验收打卡
├── routes/                # 61 个 API 路由
├── models/                # 数据模型
├── middleware/            # 中间件
└── scheduler/             # 定时任务
```

## 五、API 端点概览

| 模块 | 路径前缀 | 功能 |
|------|---------|------|
| 认证 | /api/auth | 微信登录 |
| 管理后台 | /api/admin | 产品/订单/客户/文章管理 |
| 产品 | /api/products | 产品展示 |
| 文章 | /api/articles | 软文资讯 |
| 政策 | /api/policies | 政策追踪 |
| 订单 | /api/orders | 下单/查询 |
| 支付 | /api/pay | 微信支付 |
| 客户 | /api/clients | 甲方企业管理 |
| 合同 | /api/contracts | 合同管理 |
| 工单 | /api/tickets | 售后工单 |
| 客服 | /api/chatbot | AI 智能客服 |
| CRM | /api/crm | 客户关系 |
| 分析 | /api/analytics | 数据统计 |
| 代理商 | /api/agents | 代理商管理 |
| 交付 | /api/delivery | 交付追踪 |

## 六、默认账号

| 账号 | 密码 | 角色 |
|------|------|------|
| admin | admin123 | 超级管理员 |
| channel_mgr | admin123 | 渠道经理 |
| consultant1 | admin123 | 顾问 |
| delivery1 | admin123 | 交付 |
| ops_mgr | admin123 | 运营经理 |
| finance1 | admin123 | 财务 |

## 七、健康检查

```bash
# API 健康
curl http://localhost:3004/api/health

# 管理后台
curl -o /dev/null -w "%{http_code}" http://localhost:3004/admin/

# H5 首页
curl -o /dev/null -w "%{http_code}" http://localhost:3004/h5/index.html
```

## 八、备份与恢复

```bash
# 备份数据库
cp data/dt-mall.db data/dt-mall-backup-$(date +%Y%m%d).db

# 恢复
cp data/dt-mall-backup-YYYYMMDD.db data/dt-mall.db
pm2 restart shuzhi-workshop
```

## 九、安全建议

1. 修改 admin 默认密码
2. 配置 HTTPS（Let's Encrypt 免费证书）
3. 配置防火墙：仅开放 80/443 端口
4. 定期备份数据库
5. 生产环境设置 `NODE_ENV=production`
6. 配置 rate limit（已在代码中内置）
