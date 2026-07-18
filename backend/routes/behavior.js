const express = require('express');
const router = express.Router();
const sqliteDB = require('../models/sqlite-db');

/**
 * 用户行为追踪与转化漏斗分析系统
 *
 * 事件类型定义：
 *   page_view    - 页面浏览
 *   product_view - 产品详情浏览
 *   search       - 搜索
 *   share        - 分享
 *   favorite     - 收藏
 *   contact      - 提交咨询/联系
 *   add_cart     - 加入购物（如有）
 *   place_order  - 下单
 *   pay_success  - 支付成功
 *   onboarding   - 提交入驻/诊断
 *   article_view - 文章浏览
 *   login        - 登录
 *
 * 漏斗阶段映射：
 *   Stage 1: 漏斗顶部 (page_view, search, article_view)
 *   Stage 2: 产品兴趣 (product_view, favorite)
 *   Stage 3: 意向表达 (contact, onboarding, share)
 *   Stage 4: 购买转化 (place_order)
 *   Stage 5: 成功支付 (pay_success)
 */

const FUNNEL_STAGES = [
  { stage: 1, name: '触达', eventTypes: ['page_view', 'search', 'article_view'], color: '#3b82f6' },
  { stage: 2, name: '兴趣', eventTypes: ['product_view', 'favorite'], color: '#8b5cf6' },
  { stage: 3, name: '意向', eventTypes: ['contact', 'onboarding', 'share'], color: '#f59e0b' },
  { stage: 4, name: '下单', eventTypes: ['place_order'], color: '#ef4444' },
  { stage: 5, name: '支付', eventTypes: ['pay_success'], color: '#10b981' }
];

// ==================== 事件上报 ====================

/**
 * POST /api/behavior/track
 * 上报用户行为事件（支持批量）
 * Body: { events: [{ event_type, event_key, page_path, ... }] } 或 { event_type, ... }
 */
router.post('/track', (req, res) => {
  try {
    const db = sqliteDB.getDB();
    const openid = req.body.openid || '';
    const sessionId = req.body.session_id || '';
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || '';
    const userAgent = req.headers['user-agent'] || '';

    let events = [];
    if (Array.isArray(req.body.events)) {
      events = req.body.events;
    } else {
      // 单事件
      const { event_type, event_key, page_path, product_id, product_title,
              client_product_id, article_id, search_keyword, referrer, source, extra } = req.body;
      if (!event_type) {
        return res.status(400).json({ error: 'event_type is required' });
      }
      events.push({ event_type, event_key, page_path, product_id, product_title,
                    client_product_id, article_id, search_keyword, referrer, source, extra });
    }

    const stmt = db.prepare(`
      INSERT INTO user_events (openid, session_id, event_type, event_key, page_path, product_id, product_title, client_product_id, article_id, search_keyword, referrer, source, extra, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    const insertMany = db.transaction((evts) => {
      for (const e of evts) {
        stmt.run(
          openid || '',
          sessionId || '',
          e.event_type || '',
          e.event_key || '',
          e.page_path || '',
          e.product_id || 0,
          e.product_title || '',
          e.client_product_id || 0,
          e.article_id || 0,
          e.search_keyword || '',
          e.referrer || '',
          e.source || '',
          JSON.stringify(e.extra || {}),
          ip,
          userAgent
        );
        inserted++;
      }
    });
    insertMany(events);

    res.json({ success: true, inserted });
  } catch (err) {
    console.error('行为追踪失败:', err);
    res.status(500).json({ error: '行为追踪失败' });
  }
});

// ==================== 漏斗分析 ====================

/**
 * GET /api/behavior/funnel
 * 转化漏斗分析
 * Query: days=30, openid (可选，分析单用户)
 */
router.get('/funnel', (req, res) => {
  try {
    const db = sqliteDB.getDB();
    const days = parseInt(req.query.days) || 30;
    const openid = req.query.openid || '';
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');

    let whereClause = 'WHERE created_at >= ?';
    let params = [since];
    if (openid) {
      whereClause += ' AND openid = ?';
      params.push(openid);
    }

    // 统计每个阶段的事件数（去重用户数 + 总事件数）
    const funnelData = FUNNEL_STAGES.map(stage => {
      const placeholders = stage.eventTypes.map(() => '?').join(',');

      // 去重用户数
      const uniqueUsers = db.prepare(
        `SELECT COUNT(DISTINCT openid) as cnt FROM user_events ${whereClause} AND event_type IN (${placeholders}) AND openid != ''`
      ).get(...params, ...stage.eventTypes).cnt;

      // 总事件数
      const totalEvents = db.prepare(
        `SELECT COUNT(*) as cnt FROM user_events ${whereClause} AND event_type IN (${placeholders})`
      ).get(...params, ...stage.eventTypes).cnt;

      // 按事件类型细分
      const byType = {};
      stage.eventTypes.forEach(et => {
        const cnt = db.prepare(
          `SELECT COUNT(*) as cnt FROM user_events ${whereClause} AND event_type = ?`
        ).get(...params, et).cnt;
        byType[et] = cnt;
      });

      return {
        stage: stage.stage,
        name: stage.name,
        color: stage.color,
        eventTypes: stage.eventTypes,
        uniqueUsers,
        totalEvents,
        byType
      };
    });

    // 计算转化率
    const baseCount = funnelData[0].uniqueUsers || funnelData[0].totalEvents || 1;
    let prevCount = baseCount;
    funnelData.forEach((stage, idx) => {
      const currentCount = stage.uniqueUsers || stage.totalEvents;
      stage.overallRate = baseCount > 0 ? ((currentCount / baseCount) * 100).toFixed(1) : '0.0';
      stage.stepRate = prevCount > 0 ? ((currentCount / prevCount) * 100).toFixed(1) : '0.0';
      prevCount = currentCount;
    });

    res.json({
      days,
      funnel: funnelData,
      summary: {
        totalTracked: funnelData.reduce((s, f) => s + f.totalEvents, 0),
        uniqueUsers: baseCount,
        overallConversion: funnelData[funnelData.length - 1].overallRate + '%'
      }
    });
  } catch (err) {
    console.error('漏斗分析失败:', err);
    res.status(500).json({ error: '漏斗分析失败' });
  }
});

// ==================== 用户行为路径 ====================

/**
 * GET /api/behavior/user-journey
 * 单用户行为路径
 * Query: openid (必填), days=30
 */
router.get('/user-journey', (req, res) => {
  try {
    const db = sqliteDB.getDB();
    const openid = req.query.openid;
    const days = parseInt(req.query.days) || 30;
    const limit = parseInt(req.query.limit) || 100;

    if (!openid) {
      return res.status(400).json({ error: 'openid is required' });
    }

    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const events = db.prepare(
      `SELECT id, event_type, event_key, page_path, product_id, product_title, article_id, search_keyword, source, created_at
       FROM user_events
       WHERE openid = ? AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(openid, since, limit);

    // 统计用户行为摘要
    const summary = {
      totalEvents: events.length,
      pageViews: events.filter(e => e.event_type === 'page_view').length,
      productViews: events.filter(e => e.event_type === 'product_view').length,
      searches: events.filter(e => e.event_type === 'search').length,
      contacts: events.filter(e => e.event_type === 'contact').length,
      orders: events.filter(e => e.event_type === 'place_order').length,
      payments: events.filter(e => e.event_type === 'pay_success').length,
      shares: events.filter(e => e.event_type === 'share').length,
      lastActive: events[0]?.created_at || '',
      firstSeen: events[events.length - 1]?.created_at || ''
    };

    res.json({ openid, events: events.reverse(), summary });
  } catch (err) {
    console.error('用户路径分析失败:', err);
    res.status(500).json({ error: '用户路径分析失败' });
  }
});

// ==================== 事件统计 ====================

/**
 * GET /api/behavior/events/stats
 * 事件类型统计（按天/按类型）
 * Query: days=30
 */
router.get('/events/stats', (req, res) => {
  try {
    const db = sqliteDB.getDB();
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    // 按事件类型统计
    const byType = db.prepare(`
      SELECT event_type, COUNT(*) as count, COUNT(DISTINCT openid) as unique_users
      FROM user_events
      WHERE date(created_at) >= date(?) AND openid != ''
      GROUP BY event_type
      ORDER BY count DESC
    `).all(since);

    // 按天统计
    const dailyTrend = db.prepare(`
      SELECT date(created_at) as date, COUNT(*) as total_events,
             COUNT(DISTINCT openid) as unique_users,
             SUM(CASE WHEN event_type = 'page_view' THEN 1 ELSE 0 END) as page_views,
             SUM(CASE WHEN event_type = 'product_view' THEN 1 ELSE 0 END) as product_views,
             SUM(CASE WHEN event_type = 'search' THEN 1 ELSE 0 END) as searches,
             SUM(CASE WHEN event_type = 'contact' THEN 1 ELSE 0 END) as contacts,
             SUM(CASE WHEN event_type = 'place_order' THEN 1 ELSE 0 END) as orders,
             SUM(CASE WHEN event_type = 'pay_success' THEN 1 ELSE 0 END) as payments
      FROM user_events
      WHERE date(created_at) >= date(?)
      GROUP BY date(created_at)
      ORDER BY date DESC
    `).all(since);

    // 按页面统计
    const byPage = db.prepare(`
      SELECT page_path, COUNT(*) as views, COUNT(DISTINCT openid) as unique_users
      FROM user_events
      WHERE event_type = 'page_view' AND date(created_at) >= date(?) AND page_path != ''
      GROUP BY page_path
      ORDER BY views DESC
      LIMIT 20
    `).all(since);

    // 热门搜索词
    const hotSearches = db.prepare(`
      SELECT search_keyword as keyword, COUNT(*) as count
      FROM user_events
      WHERE event_type = 'search' AND date(created_at) >= date(?) AND search_keyword != ''
      GROUP BY search_keyword
      ORDER BY count DESC
      LIMIT 15
    `).all(since);

    res.json({
      days,
      byType,
      dailyTrend,
      byPage,
      hotSearches,
      totalEvents: byType.reduce((s, t) => s + t.count, 0),
      totalUniqueUsers: byType.length > 0 ? byType[0].unique_users : 0
    });
  } catch (err) {
    console.error('事件统计失败:', err);
    res.status(500).json({ error: '事件统计失败' });
  }
});

// ==================== 留存分析 ====================

/**
 * GET /api/behavior/retention
 * 用户留存分析（次日/7日/30日留存）
 * Query: days=30
 */
router.get('/retention', (req, res) => {
  try {
    const db = sqliteDB.getDB();
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    // 获取首次出现的用户及其日期
    const firstSeenUsers = db.prepare(`
      SELECT openid, MIN(date(created_at)) as first_date
      FROM user_events
      WHERE openid != '' AND date(created_at) >= date(?)
      GROUP BY openid
    `).all(since);

    if (firstSeenUsers.length === 0) {
      return res.json({
        days,
        cohorts: [],
        summary: { day1: 0, day7: 0, day30: 0, totalUsers: 0 }
      });
    }

    // 按首次日期分组（日维度 cohort）
    const cohorts = {};
    firstSeenUsers.forEach(u => {
      if (!cohorts[u.first_date]) cohorts[u.first_date] = [];
      cohorts[u.first_date].push(u.openid);
    });

    // 计算每个 cohort 的 N 日留存
    const retentionData = Object.entries(cohorts).map(([date, openids]) => {
      const cohortSize = openids.length;
      const placeholders = openids.map(() => '?').join(',');

      // 次日留存
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      const day1Key = nextDay.toISOString().slice(0, 10);
      const day1Retained = db.prepare(
        `SELECT COUNT(DISTINCT openid) as cnt FROM user_events WHERE openid IN (${placeholders}) AND date(created_at) = ?`
      ).get(...openids, day1Key).cnt;

      // 7日留存
      const day7 = new Date(date);
      day7.setDate(day7.getDate() + 7);
      const day7Key = day7.toISOString().slice(0, 10);
      const day7Retained = db.prepare(
        `SELECT COUNT(DISTINCT openid) as cnt FROM user_events WHERE openid IN (${placeholders}) AND date(created_at) = ?`
      ).get(...openids, day7Key).cnt;

      // 30日留存
      const day30 = new Date(date);
      day30.setDate(day30.getDate() + 30);
      const day30Key = day30.toISOString().slice(0, 10);
      const day30Retained = db.prepare(
        `SELECT COUNT(DISTINCT openid) as cnt FROM user_events WHERE openid IN (${placeholders}) AND date(created_at) = ?`
      ).get(...openids, day30Key).cnt;

      return {
        date,
        cohortSize,
        day1: { count: day1Retained, rate: cohortSize > 0 ? ((day1Retained / cohortSize) * 100).toFixed(1) : '0.0' },
        day7: { count: day7Retained, rate: cohortSize > 0 ? ((day7Retained / cohortSize) * 100).toFixed(1) : '0.0' },
        day30: { count: day30Retained, rate: cohortSize > 0 ? ((day30Retained / cohortSize) * 100).toFixed(1) : '0.0' }
      };
    }).sort((a, b) => a.date.localeCompare(b.date));

    // 汇总
    const totalUsers = firstSeenUsers.length;
    const avgDay1 = retentionData.length > 0
      ? (retentionData.reduce((s, c) => s + parseFloat(c.day1.rate), 0) / retentionData.length).toFixed(1)
      : '0.0';
    const avgDay7 = retentionData.length > 0
      ? (retentionData.reduce((s, c) => s + parseFloat(c.day7.rate), 0) / retentionData.length).toFixed(1)
      : '0.0';

    res.json({
      days,
      cohorts: retentionData,
      summary: {
        totalUsers,
        avgDay1Retention: avgDay1 + '%',
        avgDay7Retention: avgDay7 + '%',
      }
    });
  } catch (err) {
    console.error('留存分析失败:', err);
    res.status(500).json({ error: '留存分析失败' });
  }
});

// ==================== 活跃用户统计 ====================

/**
 * GET /api/behavior/active-users
 * 活跃用户统计（DAU/WAU/MAU）
 */
router.get('/active-users', (req, res) => {
  try {
    const db = sqliteDB.getDB();
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const dau = db.prepare(
      `SELECT COUNT(DISTINCT openid) as cnt FROM user_events WHERE date(created_at) = date(?) AND openid != ''`
    ).get(today).cnt;

    const wau = db.prepare(
      `SELECT COUNT(DISTINCT openid) as cnt FROM user_events WHERE date(created_at) >= date(?) AND openid != ''`
    ).get(weekAgo).cnt;

    const mau = db.prepare(
      `SELECT COUNT(DISTINCT openid) as cnt FROM user_events WHERE date(created_at) >= date(?) AND openid != ''`
    ).get(monthAgo).cnt;

    // 最近14天 DAU 趋势
    const dauTrend = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const cnt = db.prepare(
        `SELECT COUNT(DISTINCT openid) as cnt FROM user_events WHERE date(created_at) = date(?) AND openid != ''`
      ).get(d).cnt;
      dauTrend.push({ date: d, dau: cnt });
    }

    // Stickiness (DAU/MAU)
    const stickiness = mau > 0 ? ((dau / mau) * 100).toFixed(1) : '0.0';

    res.json({
      dau,
      wau,
      mau,
      stickiness: stickiness + '%',
      dauTrend
    });
  } catch (err) {
    console.error('活跃用户统计失败:', err);
    res.status(500).json({ error: '活跃用户统计失败' });
  }
});

// ==================== 管理端：最近事件流 ====================

/**
 * GET /api/behavior/recent
 * 最近行为事件流（管理端实时监控）
 * Query: limit=50, event_type (可选筛选)
 */
router.get('/recent', (req, res) => {
  try {
    const db = sqliteDB.getDB();
    const limit = parseInt(req.query.limit) || 50;
    const eventType = req.query.event_type || '';

    let sql = `SELECT id, openid, event_type, event_key, page_path, product_title, search_keyword, source, created_at
               FROM user_events`;
    let params = [];

    if (eventType) {
      sql += ` WHERE event_type = ?`;
      params.push(eventType);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const events = db.prepare(sql).all(...params);
    res.json(events);
  } catch (err) {
    console.error('获取最近事件失败:', err);
    res.status(500).json({ error: '获取最近事件失败' });
  }
});

module.exports = router;
