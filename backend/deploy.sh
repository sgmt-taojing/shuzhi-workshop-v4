#!/bin/bash
set -e

echo "🚀 数造工坊部署脚本"
echo "=================="

# 检查 .env
if [ ! -f .env ]; then
    echo "❌ 缺少 .env 文件，请复制 .env.example 并修改配置"
    exit 1
fi

# 安装依赖
echo "📦 安装依赖..."
npm ci --production

# 初始化数据库
echo "🗄️ 检查数据库..."
if [ ! -f data/dt-mall.db ]; then
    mkdir -p data
    echo "   首次启动，数据库将在服务启动时自动创建"
fi

# 启动方式选择
if command -v pm2 &> /dev/null; then
    echo "🔧 使用 PM2 启动..."
    pm2 start server.js --name shuzhi-workshop --env production
    pm2 save
    echo "✅ 已启动，查看日志: pm2 logs shuzhi-workshop"
elif command -v docker &> /dev/null && [ -f docker-compose.yml ]; then
    echo "🐳 使用 Docker Compose 启动..."
    docker compose up -d
    echo "✅ 已启动，查看日志: docker compose logs -f"
else
    echo "🔧 直接启动..."
    NODE_ENV=production node server.js
fi

echo ""
echo "📊 管理后台: http://localhost:${PORT:-3004}/admin/"
echo "📱 H5 首页: http://localhost:${PORT:-3004}/h5/index.html"
echo "❤️ 健康检查: http://localhost:${PORT:-3004}/api/health"
