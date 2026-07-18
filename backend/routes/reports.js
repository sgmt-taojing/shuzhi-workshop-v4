/**
 * 运营报告自动生成系统 API
 *
 * 功能：
 * 1. 自动生成日报/周报/月报（聚合多维度数据）
 * 2. 手动触发报告生成
 * 3. 查看历史报告列表与详情
 * 4. 推送报告通知到管理员（订阅消息/模板消息）
 * 5. 定时自动生成（通过 node-cron 内置定时器）
 * 6. 报告内容包含：订单/线索/行为/用户/产品/财务多维度
 *
 * 报告类型：
 * - daily: 日报，每日 00:30 自动生成
 * - weekly: 周报，每周一 09:00 自动生成
 * - monthly: 月报，每月 1 日 09:00 自动生成
 */

const express = require('express');
const router = express.Router();
const { getRawDB } = require('../models/db');

// 鉴权
function authCheck(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "未授权" });
  const token = auth.slice(7);
  try {
    const { getRawDB } = require("../models/db");
    const db = getRawDB();
    if (!db) return res.status(401).json({ error: "数据库未初始化" });
    const session = db.prepare("SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
    if (!session) return res.status(401).json({ error: "登录已过期，请重新登录" });
    req.adminUser = { id: session.admin_id, username: session.username, role_id: session.role_id, role_name: session.role_name };
    next();
  } catch(e) {
    return res.status(401).json({ error: "认证失败" });
  }
}

function db() {
  return getRawDB();
}

// ==================== 数据采集 ====================

/**
 * 采集订单数据
 */
function collectOrders(d, startDate, endDate) {
  const rows = d.prepare(`
    SELECT * FROM orders WHERE created_at >= ? AND created_at <= ?
  `).all(startDate, endDate);

  const paid = rows.filter(o => ['paid', 'shipped', 'completed'].includes(o.status));
  const totalRevenue = paid.reduce((sum, o) => sum + Number(o.amount || 0), 0);
  const avgOrderValue = paid.length > 0 ? totalRevenue / paid.length : 0;

  return {
    total: rows.length,
    paid: paid.length,
    pending: rows.filter(o => o.status === 'pending').length,
    cancelled: rows.filter(o => o.status === 'cancelled').length,
    totalRevenue: totalRevenue.toFixed(2),
    avgOrderValue: avgOrderValue.toFixed(2),
    byStatus: {
      pending: rows.filter(o => o.status === 'pending').length,
      paid: rows.filter(o => o.status === 'paid').length,
      shipped: rows.filter(o => o.status === 'shipped').length,
      completed: rows.filter(o => o.status === 'completed').length,
      cancelled: rows.filter(o => o.status === 'cancelled').length,
    }
  };
}

/**
 * 采集线索/咨询数据
 */
function collectContacts(d, startDate, endDate) {
  const rows = d.prepare(`
    SELECT * FROM contacts WHERE created_at >= ? AND created_at <= ?
  `).all(startDate, endDate);

  const stageCounts = {};
  ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'].forEach(s => {
    stageCounts[s] = rows.filter(r => r.status === s).length;
  });

  // 来源分布
  const sourceCounts = {};
  rows.forEach(r => {
    const src = r.lead_source || 'unknown';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  });

  // 行业分布
  const industryCounts = {};
  rows.forEach(r => {
    const ind = r.industry || '未知';
    industryCounts[ind] = (industryCounts[ind] || 0) + 1;
  });

  return {
    total: rows.length,
    converted: stageCounts.won || 0,
    lost: stageCounts.lost || 0,
    conversionRate: rows.length > 0 ? ((stageCounts.won || 0) / rows.length * 100).toFixed(1) + '%' : '0%',
    byStage: stageCounts,
    bySource: sourceCounts,
    byIndustry: industryCounts,
  };
}

/**
 * 采集用户行为数据
 */
function collectBehavior(d, startDate, endDate) {
  let rows = [];
  try {
    rows = d.prepare(`
      SELECT * FROM user_events WHERE created_at >= ? AND created_at <= ?
    `).all(startDate, endDate);
  } catch (e) {
    // user_events table might not exist yet
  }

  // 漏斗数据
  const eventTypes = {};
  rows.forEach(r => {
    eventTypes[r.event_type] = (eventTypes[r.event_type] || 0) + 1;
  });

  // 去重用户
  const uniqueUsers = new Set(rows.map(r => r.openid).filter(Boolean));

  // 热门页面
  const pageViews = {};
  rows.filter(r => r.event_type === 'page_view').forEach(r => {
    if (r.page_path) {
      pageViews[r.page_path] = (pageViews[r.page_path] || 0) + 1;
    }
  });

  // 搜索词
  const searchKeywords = {};
  rows.filter(r => r.event_type === 'search').forEach(r => {
    if (r.search_keyword) {
      searchKeywords[r.search_keyword] = (searchKeywords[r.search_keyword] || 0) + 1;
    }
  });

  // 漏斗阶段
  const funnel = {
    reach: (eventTypes.page_view || 0) + (eventTypes.search || 0) + (eventTypes.article_view || 0),
    interest: (eventTypes.product_view || 0) + (eventTypes.favorite || 0),
    intent: (eventTypes.contact || 0) + (eventTypes.onboarding || 0) + (eventTypes.share || 0),
    order: eventTypes.place_order || 0,
    pay: eventTypes.pay_success || 0,
  };

  return {
    totalEvents: rows.length,
    uniqueUsers: uniqueUsers.size,
    byEventType: eventTypes,
    funnel,
    topPages: Object.entries(pageViews).sort((a, b) => b[1] - a[1]).slice(0, 10),
    topSearchKeywords: Object.entries(searchKeywords).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

/**
 * 采集产品数据
 */
function collectProducts(d) {
  const products = d.prepare('SELECT * FROM products WHERE published = 1').all();
  const clientProducts = d.prepare('SELECT * FROM client_products').all();

  // 热门产品（通过行为数据）
  let productViews = [];
  try {
    productViews = d.prepare(`
      SELECT product_id, product_title, COUNT(*) as view_count
      FROM user_events
      WHERE event_type = 'product_view' AND product_id IS NOT NULL
      GROUP BY product_id
      ORDER BY view_count DESC
      LIMIT 10
    `).all();
  } catch (e) {}

  return {
    totalProducts: products.length,
    totalClientProducts: clientProducts.length,
    topViewed: productViews,
  };
}

/**
 * 采集用户数据
 */
function collectUsers(d, startDate, endDate) {
  let newUsers = [];
  try {
    newUsers = d.prepare(`
      SELECT COUNT(DISTINCT openid) as cnt FROM user_events
      WHERE created_at >= ? AND created_at <= ? AND openid IS NOT NULL
    `).get(startDate, endDate);
  } catch (e) {}

  let totalUsers = 0;
  try {
    totalUsers = d.prepare('SELECT COUNT(DISTINCT openid) as cnt FROM user_events WHERE openid IS NOT NULL').get();
  } catch (e) {}

  // 积分用户
  let pointsUsers = 0;
  try {
    pointsUsers = d.prepare('SELECT COUNT(*) as cnt FROM user_points').get();
  } catch (e) {}

  return {
    newUsers: newUsers?.cnt || 0,
    totalUsers: totalUsers?.cnt || 0,
    pointsUsers,
  };
}

/**
 * 采集评价数据
 */
function collectReviews(d, startDate, endDate) {
  let rows = [];
  try {
    rows = d.prepare(`
      SELECT * FROM reviews WHERE created_at >= ? AND created_at <= ?
    `).all(startDate, endDate);
  } catch (e) {}

  const avgRating = rows.length > 0
    ? (rows.reduce((sum, r) => sum + Number(r.rating || 0), 0) / rows.length).toFixed(1)
    : '0.0';

  return {
    total: rows.length,
    avgRating,
    pending: rows.filter(r => r.status === 'pending').length,
    approved: rows.filter(r => r.status === 'approved').length,
  };
}

/**
 * 采集入驻申请数据
 */
function collectOnboardings(d, startDate, endDate) {
  let rows = [];
  try {
    rows = d.prepare(`
      SELECT * FROM onboardings WHERE created_at >= ? AND created_at <= ?
    `).all(startDate, endDate);
  } catch (e) {}

  return {
    total: rows.length,
    pending: rows.filter(r => r.status === 'pending').length,
    approved: rows.filter(r => r.status === 'approved').length,
    rejected: rows.filter(r => r.status === 'rejected').length,
  };
}

/**
 * 采集优惠券数据
 */
function collectCoupons(d) {
  let total = 0, used = 0, expired = 0;
  try {
    total = d.prepare('SELECT COUNT(*) as cnt FROM coupons').get().cnt;
    used = d.prepare("SELECT COUNT(*) as cnt FROM coupons WHERE status = 'used'").get().cnt;
    expired = d.prepare("SELECT COUNT(*) as cnt FROM coupons WHERE status = 'expired'").get().cnt;
  } catch (e) {}

  return { total, used, expired, unused: total - used - expired };
}

/**
 * 采集CRM数据
 */
function collectCRM(d, startDate, endDate) {
  let customers = 0, projects = 0, revenue = 0;
  try {
    customers = d.prepare('SELECT COUNT(*) as cnt FROM crm_customers').get().cnt;
    projects = d.prepare('SELECT COUNT(*) as cnt FROM crm_projects').get().cnt;
    const finance = d.prepare(`
      SELECT SUM(CASE WHEN type='income' THEN amount ELSE 0 END) as income,
             SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) as expense
      FROM crm_finance WHERE created_at >= ? AND created_at <= ?
    `).get(startDate, endDate);
    revenue = finance?.income || 0;
  } catch (e) {}

  return { customers, projects, revenue };
}

// ==================== 报告生成 ====================

/**
 * 生成报告
 */
function generateReport(d, type, date) {
  const now = new Date();
  let periodStart, periodEnd, title;

  if (type === 'daily') {
    periodStart = `${date} 00:00:00`;
    periodEnd = `${date} 23:59:59`;
    title = `日报 - ${date}`;
  } else if (type === 'weekly') {
    const end = new Date(date);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    periodStart = `${start.toISOString().slice(0, 10)} 00:00:00`;
    periodEnd = `${date} 23:59:59`;
    title = `周报 - ${start.toISOString().slice(0, 10)} ~ ${date}`;
  } else if (type === 'monthly') {
    const [year, month] = date.split('-');
    periodStart = `${year}-${month}-01 00:00:00`;
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    periodEnd = `${year}-${month}-${lastDay} 23:59:59`;
    title = `月报 - ${year}年${parseInt(month)}月`;
  } else {
    throw new Error(`未知报告类型: ${type}`);
  }

  // 采集各维度数据
  const orders = collectOrders(d, periodStart, periodEnd);
  const contacts = collectContacts(d, periodStart, periodEnd);
  const behavior = collectBehavior(d, periodStart, periodEnd);
  const products = collectProducts(d);
  const users = collectUsers(d, periodStart, periodEnd);
  const reviews = collectReviews(d, periodStart, periodEnd);
  const onboardings = collectOnboardings(d, periodStart, periodEnd);
  const coupons = collectCoupons(d);
  const crm = collectCRM(d, periodStart, periodEnd);

  // 关键指标
  const metrics = {
    orders: orders.total,
    revenue: orders.totalRevenue,
    newLeads: contacts.total,
    conversionRate: contacts.conversionRate,
    newUsers: users.newUsers,
    activeUsers: behavior.uniqueUsers,
    totalEvents: behavior.totalEvents,
    avgRating: reviews.avgRating,
    newOnboardings: onboardings.total,
    crmRevenue: crm.revenue,
  };

  // 完整内容
  const content = {
    orders,
    contacts,
    behavior,
    products,
    users,
    reviews,
    onboardings,
    coupons,
    crm,
  };

  // 智能摘要
  const summaryParts = [];
  if (type === 'daily') {
    summaryParts.push(`今日新增线索 ${contacts.total} 条，成交订单 ${orders.paid} 单，营收 ¥${orders.totalRevenue}`);
    summaryParts.push(`活跃用户 ${behavior.uniqueUsers} 人，产生 ${behavior.totalEvents} 次行为事件`);
    if (onboardings.total > 0) summaryParts.push(`新增入驻申请 ${onboardings.total} 条`);
    if (reviews.total > 0) summaryParts.push(`新增评价 ${reviews.total} 条，平均评分 ${reviews.avgRating}`);
  } else if (type === 'weekly') {
    summaryParts.push(`本周新增线索 ${contacts.total} 条，转化率 ${contacts.conversionRate}，成交订单 ${orders.paid} 单`);
    summaryParts.push(`营收 ¥${orders.totalRevenue}，活跃用户 ${behavior.uniqueUsers} 人`);
    summaryParts.push(`新增入驻 ${onboardings.total} 条，新增评价 ${reviews.total} 条`);
  } else {
    summaryParts.push(`本月新增线索 ${contacts.total} 条，成交订单 ${orders.paid} 单，总营收 ¥${orders.totalRevenue}`);
    summaryParts.push(`活跃用户 ${behavior.uniqueUsers} 人，累计用户 ${users.totalUsers} 人`);
    summaryParts.push(`CRM 客户 ${crm.customers} 个，进行中项目 ${crm.projects} 个`);
  }
  const summary = summaryParts.join('；') + '。';

  return { title, summary, metrics, content, periodStart, periodEnd };
}

// ==================== API 接口 ====================

/**
 * GET /api/reports/list
 * 获取报告列表
 */
router.get('/list', authCheck, (req, res) => {
  const d = db();
  const { type, page = 1, limit = 20 } = req.query;

  let sql = 'SELECT id, report_type, report_date, title, summary, status, sent_at, created_at FROM reports';
  const params = [];
  if (type && type !== 'all') {
    sql += ' WHERE report_type = ?';
    params.push(type);
  }
  sql += ' ORDER BY report_date DESC, id DESC';

  let rows = d.prepare(sql).all(...params);
  const total = rows.length;

  // 分页
  const start = (parseInt(page) - 1) * parseInt(limit);
  rows = rows.slice(start, start + parseInt(limit));

  res.json({
    data: rows,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / parseInt(limit)),
  });
});

/**
 * GET /api/reports/:id
 * 获取报告详情
 */
router.get('/:id', authCheck, (req, res) => {
  const d = db();
  const row = d.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });

  // 解析 JSON 字段
  try { row.metrics = JSON.parse(row.metrics); } catch (e) {}
  try { row.content = JSON.parse(row.content); } catch (e) {}
  try { row.sent_to = row.sent_to ? JSON.parse(row.sent_to) : []; } catch (e) {}

  res.json(row);
});

/**
 * POST /api/reports/generate
 * 手动生成报告
 */
router.post('/generate', authCheck, (req, res) => {
  const d = db();
  const { type = 'daily', date } = req.body;

  if (!['daily', 'weekly', 'monthly'].includes(type)) {
    return res.status(400).json({ error: '无效的报告类型' });
  }

  // 默认日期
  let reportDate = date;
  if (!reportDate) {
    const now = new Date();
    if (type === 'monthly') {
      reportDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    } else {
      reportDate = now.toISOString().slice(0, 10);
    }
  }

  // 检查是否已存在
  const existing = d.prepare('SELECT id FROM reports WHERE report_type = ? AND report_date = ?').get(type, reportDate);
  if (existing) {
    return res.status(409).json({ error: '该日期的报告已存在', id: existing.id });
  }

  // 生成报告
  try {
    const report = generateReport(d, type, reportDate);

    const result = d.prepare(`
      INSERT INTO reports (report_type, report_date, period_start, period_end, title, summary, content, metrics, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated')
    `).run(
      type, reportDate,
      report.periodStart, report.periodEnd,
      report.title, report.summary,
      JSON.stringify(report.content),
      JSON.stringify(report.metrics)
    );

    res.json({
      id: result.lastInsertRowid,
      message: '报告生成成功',
      title: report.title,
      summary: report.summary,
      metrics: report.metrics,
    });
  } catch (err) {
    res.status(500).json({ error: '生成失败: ' + err.message });
  }
});

/**
 * PUT /api/reports/:id/status
 * 更新报告状态
 */
router.put('/:id/status', authCheck, (req, res) => {
  const d = db();
  const { status } = req.body;
  if (!['generated', 'sent', 'archived'].includes(status)) {
    return res.status(400).json({ error: '无效状态' });
  }

  const result = d.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '报告不存在' });

  res.json({ message: '状态更新成功' });
});

/**
 * DELETE /api/reports/:id
 * 删除报告
 */
router.delete('/:id', authCheck, (req, res) => {
  const d = db();
  const result = d.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '报告不存在' });

  res.json({ message: '删除成功' });
});

/**
 * GET /api/reports/overview/stats
 * 报告概览统计
 */
router.get('/overview/stats', authCheck, (req, res) => {
  const d = db();

  const daily = d.prepare("SELECT COUNT(*) as cnt FROM reports WHERE report_type = 'daily'").get().cnt;
  const weekly = d.prepare("SELECT COUNT(*) as cnt FROM reports WHERE report_type = 'weekly'").get().cnt;
  const monthly = d.prepare("SELECT COUNT(*) as cnt FROM reports WHERE report_type = 'monthly'").get().cnt;
  const sent = d.prepare("SELECT COUNT(*) as cnt FROM reports WHERE status = 'sent'").get().cnt;

  // 最近报告
  const recent = d.prepare('SELECT id, report_type, report_date, title, summary, status, created_at FROM reports ORDER BY created_at DESC LIMIT 5').all();

  res.json({
    total: daily + weekly + monthly,
    daily,
    weekly,
    monthly,
    sent,
    recent,
  });
});

/**
 * GET /api/reports/dashboard/summary
 * 获取仪表盘摘要数据（供管理后台首页快速展示）
 */
router.get('/dashboard/summary', authCheck, (req, res) => {
  const d = db();
  const today = new Date().toISOString().slice(0, 10);
  const todayStart = `${today} 00:00:00`;
  const todayEnd = `${today} 23:59:59`;

  const orders = collectOrders(d, todayStart, todayEnd);
  const contacts = collectContacts(d, todayStart, todayEnd);
  const behavior = collectBehavior(d, todayStart, todayEnd);
  const users = collectUsers(d, todayStart, todayEnd);
  const onboardings = collectOnboardings(d, todayStart, todayEnd);

  res.json({
    date: today,
    today: {
      orders: orders.total,
      revenue: orders.totalRevenue,
      newLeads: contacts.total,
      activeUsers: behavior.uniqueUsers,
      newUsers: users.newUsers,
      newOnboardings: onboardings.total,
      totalEvents: behavior.totalEvents,
    },
    funnel: behavior.funnel,
  });
});

/**
 * POST /api/reports/:id/send
 * 推送报告通知（标记为已发送）
 */
router.post('/:id/send', authCheck, async (req, res) => {
  const d = db();
  const { targets = [] } = req.body;

  const report = d.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });

  // 标记为已发送
  d.prepare('UPDATE reports SET status = ?, sent_to = ?, sent_at = datetime(\'now\') WHERE id = ?')
    .run('sent', JSON.stringify(targets), req.params.id);

  // TODO: 实际推送逻辑可对接订阅消息/模板消息
  // 这里先标记状态，实际推送由管理员在推送管理中操作

  res.json({ message: '报告已标记为已发送', targets });
});

// ==================== 定时自动生成 ====================

let cronTimer = null;

/**
 * 自动生成日报（每天 00:30）
 */
function autoGenerateDaily() {
  try {
    const d = db();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // 检查是否已存在
    const existing = d.prepare("SELECT id FROM reports WHERE report_type = 'daily' AND report_date = ?").get(yesterday);
    if (existing) return;

    const report = generateReport(d, 'daily', yesterday);
    d.prepare(`
      INSERT INTO reports (report_type, report_date, period_start, period_end, title, summary, content, metrics, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated')
    `).run(
      'daily', yesterday,
      report.periodStart, report.periodEnd,
      report.title, report.summary,
      JSON.stringify(report.content),
      JSON.stringify(report.metrics)
    );

    console.log(`[Reports] 自动生成日报成功: ${yesterday}`);
  } catch (err) {
    console.error('[Reports] 自动生成日报失败:', err.message);
  }
}

/**
 * 自动生成周报（每周一 09:00）
 */
function autoGenerateWeekly() {
  try {
    const d = db();
    const today = new Date().toISOString().slice(0, 10);

    const existing = d.prepare("SELECT id FROM reports WHERE report_type = 'weekly' AND report_date = ?").get(today);
    if (existing) return;

    const report = generateReport(d, 'weekly', today);
    d.prepare(`
      INSERT INTO reports (report_type, report_date, period_start, period_end, title, summary, content, metrics, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated')
    `).run(
      'weekly', today,
      report.periodStart, report.periodEnd,
      report.title, report.summary,
      JSON.stringify(report.content),
      JSON.stringify(report.metrics)
    );

    console.log(`[Reports] 自动生成周报成功: ${today}`);
  } catch (err) {
    console.error('[Reports] 自动生成周报失败:', err.message);
  }
}

/**
 * 自动生成月报（每月 1 日 09:00）
 */
function autoGenerateMonthly() {
  try {
    const d = db();
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const dateStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

    const existing = d.prepare("SELECT id FROM reports WHERE report_type = 'monthly' AND report_date = ?").get(dateStr);
    if (existing) return;

    const report = generateReport(d, 'monthly', dateStr);
    d.prepare(`
      INSERT INTO reports (report_type, report_date, period_start, period_end, title, summary, content, metrics, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated')
    `).run(
      'monthly', dateStr,
      report.periodStart, report.periodEnd,
      report.title, report.summary,
      JSON.stringify(report.content),
      JSON.stringify(report.metrics)
    );

    console.log(`[Reports] 自动生成月报成功: ${dateStr}`);
  } catch (err) {
    console.error('[Reports] 自动生成月报失败:', err.message);
  }
}

/**
 * 启动定时任务
 * 使用 setInterval 模拟 cron（轻量级，无需额外依赖）
 */
function startScheduler() {
  if (cronTimer) return;

  // 每小时检查一次
  cronTimer = setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const dayOfWeek = now.getDay(); // 0=周日
    const dayOfMonth = now.getDate();

    // 每天 00:30 生成日报
    if (hour === 0 && minute === 30) {
      autoGenerateDaily();
    }

    // 每周一 09:00 生成周报
    if (dayOfWeek === 1 && hour === 9 && minute === 0) {
      autoGenerateWeekly();
    }

    // 每月 1 日 09:00 生成月报
    if (dayOfMonth === 1 && hour === 9 && minute === 0) {
      autoGenerateMonthly();
    }
  }, 60 * 1000); // 每分钟检查

  console.log('[Reports] 定时报告生成器已启动（日报 00:30 / 周报 周一 09:00 / 月报 1日 09:00）');
}

// 启动定时器（延迟 5 秒，等待数据库初始化完成）
setTimeout(startScheduler, 5000);

module.exports = router;
