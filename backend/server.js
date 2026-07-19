require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDB } = require('./models/db');
const { auditMiddleware } = require('./middleware/audit');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3004;

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: false, // 小程序和管理后台需要内联脚本
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors());

// 全局速率限制：每个IP每分钟最多100次请求
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' }
});
app.use('/api/', globalLimiter);

// 敏感操作更严格限流：登录、下单、支付每分钟最多10次
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '操作过于频繁，请稍后再试' }
});
app.use('/api/admin/login', sensitiveLimiter);
app.use('/api/orders', sensitiveLimiter);
app.use('/api/pay/create', sensitiveLimiter);
app.use('/api/pay/refund', sensitiveLimiter);

// 通用中间件
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// 审计日志中间件（自动记录敏感 API 操作）
app.use('/api/', auditMiddleware);

// 静态文件（管理后台 + 图片资源 + 上传文件）
app.use('/admin', express.static(path.join(__dirname, 'admin-web'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));
app.use('/screen', express.static(path.join(__dirname, 'admin-web/screen.html')));
app.use('/mobile', express.static(path.join(__dirname, '../mobile-portal')));
app.use('/h5', express.static(path.join(__dirname, 'wechat-h5')));
app.use('/images', express.static(path.join(__dirname, '../miniprogram/images')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/demos', express.static(path.join(__dirname, 'public/demos')));

// 根路径重定向到管理后台
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// API 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/onboarding', require('./routes/onboarding'));
app.use('/api/products', require('./routes/products'));
app.use('/api/articles', require('./routes/articles'));
app.use('/api/client-products', require('./routes/client-products'));
app.use('/api/wechat', require('./routes/wechat'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/pay', require('./routes/pay'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/customer-service', require('./routes/customer-service'));
app.use('/api/template-msg', require('./routes/template-msg'));
app.use('/api/config', require('./routes/config'));
app.use('/api/wecom-cs', require('./routes/wecom-cs'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/search', require('./routes/search'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/coupons', require('./routes/coupons'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/monitor', require('./routes/monitor'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/export', require('./routes/export'));
app.use('/api/shares', require('./routes/shares'));
app.use('/api/recommend', require('./routes/recommend'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/points', require('./routes/points'));
app.use('/api/behavior', require('./routes/behavior'));
app.use('/api/subscribe-msg', require('./routes/subscribe-msg'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/crm', require('./routes/crm'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/assessments', require('./routes/assessments'));
app.use('/api/audit-logs', require('./routes/audit-logs'));
app.use('/api/quotes', require('./routes/quotes'));
app.use('/api/scheduler', require('./routes/scheduler'));
app.use('/api/service-tracker', require('./routes/service-tracker'));
app.use('/api/banners', require('./routes/banners'));
app.use('/api/faqs', require('./routes/faqs'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/partners', require('./routes/partners'));
app.use('/api/chatbot', require('./routes/chatbot'));
app.use('/api/contracts', require('./routes/contracts'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/policies', require('./routes/policy'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/enterprise', require('./routes/enterprise'));
app.use('/api/services', require('./routes/service-matching'));
app.use('/api/marketing', require('./routes/marketing'));
app.use('/api/commerce', require('./routes/commerce'));
app.use('/api/charity', require('./routes/charity'));
app.use('/api/group-buy', require('./routes/group-buy'));
app.use('/api/agents', require('./routes/agent'));
app.use('/api/delivery', require('./routes/delivery'));
app.use('/api/steward', require('./routes/steward'));
app.use('/api/providers', require('./routes/provider'));
app.use('/api/platform', require('./routes/platform'));
app.use('/api/config', require('./routes/config-manager'));
app.use('/api/h5auth', require('./routes/h5auth'));
app.use('/api/analytics-v2', require('./routes/analytics-v2'));

// 健康检查
app.get('/api', (req, res) => {
  res.json({
    name: '数造工坊 API',
    version: '2.0',
    status: 'ok',
    time: new Date().toISOString(),
    docs: '/api/health'
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 初始化数据库并启动
initDB();

// 启动定时任务调度器（延迟 3 秒，等待数据库初始化）
setTimeout(() => {
  scheduler.start();
}, 3000);

app.listen(PORT, () => {
  console.log(`🚀 数造工坊后端服务已启动: http://localhost:${PORT}`);
  console.log(`📊 管理后台: http://localhost:${PORT}/admin`);
  console.log(`📁 文件上传: POST http://localhost:${PORT}/api/upload`);
  console.log(`⏰ 定时任务调度器: 3秒后自动启动`);
});
