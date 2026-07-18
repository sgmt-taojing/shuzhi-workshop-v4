#!/bin/bash
# 数智工坊后端服务启动脚本
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
exec node server.js
