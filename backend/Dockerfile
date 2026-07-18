FROM node:22-alpine

WORKDIR /app

# 复制依赖文件
COPY package.json package-lock.json ./

# 安装依赖
RUN npm ci --production

# 复制源码
COPY . .

# 创建数据目录
RUN mkdir -p data uploads

# 暴露端口
EXPOSE 3004

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3004/api/health',(r)=>{process.exit(r.statusCode===200?0:1)})"

# 启动
CMD ["node", "server.js"]
