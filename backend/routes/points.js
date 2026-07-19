const express = require('express');
const router = express.Router();
const db = require('../models/db');

// ==================== 等级配置 ====================
const LEVELS = [
  { level: 1, name: '体验用户', minPoints: 0, icon: '🌱', perks: ['基础浏览', '参与咨询'] },
  { level: 2, name: '活跃用户', minPoints: 200, icon: '🌿', perks: ['专属优惠券', '优先客服'] },
  { level: 3, name: '银牌用户', minPoints: 600, icon: '🥈', perks: ['方案折扣', '免费诊断', '专属客服'] },
  { level: 4, name: '金牌用户', minPoints: 1500, icon: '🥇', perks: ['VIP通道', '定制方案', '1对1顾问'] },
  { level: 5, name: '钻石用户', minPoints: 3000, icon: '💎', perks: ['专属经理', '优先交付', '年度复盘', '生态资源对接'] }
];

// ==================== 积分规则 ====================
const POINT_RULES = {
  daily_login:        { points: 5,   label: '每日登录',   type: 'daily',  icon: '📅' },
  browse_product:     { points: 2,   label: '浏览产品',   type: 'daily',  icon: '👀' },
  share_product:      { points: 10,  label: '分享产品',   type: 'action', icon: '📤' },
  share_article:      { points: 8,   label: '分享文章',   type: 'action', icon: '📰' },
  submit_feedback:    { points: 20,  label: '提交反馈',   type: 'action', icon: '💬' },
  write_review:       { points: 15,  label: '发表评价',   type: 'action', icon: '⭐' },
  place_order:        { points: 50,  label: '下单购买',   type: 'action', icon: '🛒' },
  complete_onboarding:{ points: 30,  label: '完成诊断',   type: 'action', icon: '📋' },
  invite_user:        { points: 30,  label: '邀请用户',   type: 'action', icon: '🤝' },
  daily_browse_3:     { points: 10,  label: '浏览3个产品', type: 'daily',  icon: '🎯' },
  daily_share_1:      { points: 15,  label: '分享1次',    type: 'daily',  icon: '📣' },
};

// 每日上限
const DAILY_LIMIT = 100;

// ==================== 工具函数 ====================

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function getDB() {
  return db.getDB();
}

function getLevelInfo(totalPoints) {
  let current = LEVELS[0];
  let next = null;
  for (let i = 0; i < LEVELS.length; i++) {
    if (totalPoints >= LEVELS[i].minPoints) {
      current = LEVELS[i];
      next = LEVELS[i + 1] || null;
    }
  }
  const progress = next 
    ? Math.min(100, Math.round(((totalPoints - current.minPoints) / (next.minPoints - current.minPoints)) * 100))
    : 100;
  const pointsToNext = next ? next.minPoints - totalPoints : 0;
  return { ...current, next, progress, pointsToNext };
}

function ensureUserPoints(openid) {
  const d = getDB();
  let userPoints = (d.user_points || []).find(u => u.openid === openid);
  if (!userPoints) {
    const today = getToday();
    userPoints = {
      id: db.nextId('user_points'),
      openid,
      user_id: null,
      total_points: 0,
      level: 1,
      level_name: '体验用户',
      today_points: 0,
      today_date: today,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (!d.user_points) d.user_points = [];
    d.user_points.push(userPoints);
    db.syncRow('user_points', userPoints);
  } else {
    // 每日重置
    const today = getToday();
    if (userPoints.today_date !== today) {
      userPoints.today_points = 0;
      userPoints.today_date = today;
      db.syncRow('user_points', userPoints);
    }
  }
  return userPoints;
}

function addPoints(openid, actionCode, refId = '', description = '') {
  const rule = POINT_RULES[actionCode];
  if (!rule) return { success: false, message: '未知积分行为' };

  const userPoint = ensureUserPoints(openid);
  const today = getToday();
  const d = getDB();

  // 获取今日记录
  const allRecords = d.point_records || [];
  const todayRecords = allRecords.filter(r => r.openid === openid && r.created_at && r.created_at.slice(0, 10) === today);

  // 每日任务检查是否已完成
  if (rule.type === 'daily') {
    const matchedToday = todayRecords.filter(r => r.action === actionCode);
    if (matchedToday.length > 0 && actionCode !== 'browse_product') {
      return { success: false, message: '今日已完成该任务' };
    }
    // browse_product 每日最多3次
    if (actionCode === 'browse_product' && matchedToday.length >= 3) {
      return { success: false, message: '今日浏览积分已上限' };
    }
  }

  // 每日积分上限检查
  const todayEarned = todayRecords.filter(r => r.points > 0).reduce((s, r) => s + r.points, 0);
  if (todayEarned + rule.points > DAILY_LIMIT) {
    return { success: false, message: '今日积分已达上限' };
  }

  // 记录积分明细
  const record = {
    id: db.nextId('point_records'),
    openid,
    user_id: userPoint.user_id,
    type: rule.type,
    action: actionCode,
    action_label: rule.label,
    points: rule.points,
    description: description || rule.label,
    ref_id: refId,
    ref_type: refId ? actionCode.split('_')[0] : '',
    created_at: new Date().toISOString()
  };
  if (!d.point_records) d.point_records = [];
  d.point_records.push(record);
  db.syncRow('point_records', record);

  // 更新用户总积分
  const newTotal = userPoint.total_points + rule.points;
  const levelInfo = getLevelInfo(newTotal);
  userPoint.total_points = newTotal;
  userPoint.today_points = todayEarned + rule.points;
  userPoint.level = levelInfo.level;
  userPoint.level_name = levelInfo.name;
  userPoint.updated_at = new Date().toISOString();
  db.syncRow('user_points', userPoint);

  return {
    success: true,
    points: rule.points,
    totalPoints: newTotal,
    level: levelInfo.level,
    levelName: levelInfo.name,
    action: actionCode,
    label: rule.label
  };
}

// ==================== API 接口 ====================

/**
 * GET /api/points/overview
 * 获取用户积分概览
 */
router.get('/overview', (req, res) => {
  const openid = req.query.openid;
  if (!openid) return res.status(400).json({ error: '缺少 openid' });

  const userPoint = ensureUserPoints(openid);
  const levelInfo = getLevelInfo(userPoint.total_points);
  const d = getDB();

  // 今日已获积分
  const today = getToday();
  const allRecords = d.point_records || [];
  const todayEarned = allRecords
    .filter(r => r.openid === openid && r.created_at && r.created_at.slice(0, 10) === today && r.points > 0)
    .reduce((sum, r) => sum + r.points, 0);

  // 近7天积分趋势
  const userRecords = allRecords.filter(r => r.openid === openid);
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const dayPoints = userRecords
      .filter(r => r.created_at && r.created_at.slice(0, 10) === date)
      .reduce((s, r) => s + r.points, 0);
    trend.push({ date, points: dayPoints });
  }

  res.json({
    totalPoints: userPoint.total_points,
    todayEarned,
    dailyLimit: DAILY_LIMIT,
    level: levelInfo.level,
    levelName: levelInfo.name,
    levelIcon: levelInfo.icon,
    perks: levelInfo.perks,
    nextLevel: levelInfo.next,
    progress: levelInfo.progress,
    pointsToNext: levelInfo.pointsToNext,
    trend
  });
});

/**
 * GET /api/points/tasks
 * 获取用户任务列表
 */
router.get('/tasks', (req, res) => {
  const openid = req.query.openid;
  if (!openid) return res.status(400).json({ error: '缺少 openid' });

  const today = getToday();
  const d = getDB();
  const allRecords = d.point_records || [];
  const todayArr = allRecords.filter(r => r.openid === openid && r.created_at && r.created_at.slice(0, 10) === today);

  const tasks = Object.entries(POINT_RULES).map(([code, rule]) => {
    let completed = false;
    let completedCount = 0;
    let targetCount = 1;

    if (rule.type === 'daily') {
      const matched = todayArr.filter(r => r.action === code);
      completedCount = matched.length;
      if (code === 'browse_product') {
        targetCount = 3;
        completed = completedCount >= 3;
      } else if (code === 'daily_browse_3') {
        completed = todayArr.filter(r => r.action === 'browse_product').length >= 3;
      } else if (code === 'daily_share_1') {
        completed = todayArr.filter(r => r.action.startsWith('share')).length >= 1;
      } else {
        completed = completedCount >= 1;
      }
    }

    return {
      code,
      title: rule.label,
      points: rule.points,
      icon: rule.icon,
      type: rule.type,
      completed,
      completedCount,
      targetCount
    };
  });

  const dailyEarned = todayArr.filter(r => r.points > 0).reduce((s, r) => s + r.points, 0);
  res.json({ tasks, dailyEarned, dailyLimit: DAILY_LIMIT });
});

/**
 * GET /api/points/records
 * 获取积分明细记录
 */
router.get('/records', (req, res) => {
  const openid = req.query.openid;
  if (!openid) return res.status(400).json({ error: '缺少 openid' });

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const type = req.query.type;

  const d = getDB();
  let records = (d.point_records || []).filter(r => r.openid === openid);
  
  if (type) {
    records = records.filter(r => r.type === type);
  }

  records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = records.length;
  const start = (page - 1) * limit;
  const data = records.slice(start, start + limit);

  res.json({ total, page, limit, data });
});

/**
 * POST /api/points/earn
 * 触发积分行为
 */
router.post('/earn', (req, res) => {
  const { openid, action, ref_id, description } = req.body;
  if (!openid || !action) return res.status(400).json({ error: '缺少参数' });

  const result = addPoints(openid, action, ref_id || '', description || '');
  if (!result.success) {
    return res.status(200).json({ success: false, message: result.message });
  }
  res.json(result);
});

/**
 * GET /api/points/rewards
 * 获取可兑换的积分商品
 */
router.get('/rewards', (req, res) => {
  const d = getDB();
  let rewards = (d.point_rewards || []).filter(r => r.status === 'active');
  rewards.sort((a, b) => a.points_required - b.points_required);
  res.json({ rewards });
});

/**
 * POST /api/points/redeem
 * 兑换积分商品
 */
router.post('/redeem', (req, res) => {
  const { openid, reward_id } = req.body;
  if (!openid || !reward_id) return res.status(400).json({ error: '缺少参数' });

  const userPoint = ensureUserPoints(openid);
  const d = getDB();
  const reward = (d.point_rewards || []).find(r => r.id === Number(reward_id));
  if (!reward) return res.status(404).json({ error: '商品不存在' });
  if (reward.status !== 'active') return res.status(400).json({ error: '商品已下架' });
  if (reward.stock !== -1 && reward.stock <= 0) return res.status(400).json({ error: '库存不足' });

  if (userPoint.total_points < reward.points_required) {
    return res.status(400).json({ error: '积分不足', needed: reward.points_required - userPoint.total_points });
  }

  // 扣减积分
  const newTotal = userPoint.total_points - reward.points_required;
  const levelInfo = getLevelInfo(newTotal);
  userPoint.total_points = newTotal;
  userPoint.level = levelInfo.level;
  userPoint.level_name = levelInfo.name;
  userPoint.updated_at = new Date().toISOString();
  db.syncRow('user_points', userPoint);

  // 记录兑换
  const redemption = {
    id: db.nextId('point_redemptions'),
    openid,
    user_id: userPoint.user_id,
    reward_id: reward.id,
    reward_title: reward.title,
    points_cost: reward.points_required,
    status: 'completed',
    coupon_id: null,
    created_at: new Date().toISOString()
  };
  if (!d.point_redemptions) d.point_redemptions = [];
  d.point_redemptions.push(redemption);
  db.syncRow('point_redemptions', redemption);

  // 记录积分扣减明细
  const record = {
    id: db.nextId('point_records'),
    openid,
    user_id: userPoint.user_id,
    type: 'redeem',
    action: 'redeem_reward',
    action_label: '兑换商品',
    points: -reward.points_required,
    description: `兑换: ${reward.title}`,
    ref_id: String(reward.id),
    ref_type: 'reward',
    created_at: new Date().toISOString()
  };
  if (!d.point_records) d.point_records = [];
  d.point_records.push(record);
  db.syncRow('point_records', record);

  // 扣库存
  if (reward.stock > 0) {
    reward.stock = reward.stock - 1;
    db.syncRow('point_rewards', reward);
  }

  res.json({
    success: true,
    redemption,
    remainingPoints: newTotal
  });
});

/**
 * GET /api/points/redemptions
 * 获取用户兑换记录
 */
router.get('/redemptions', (req, res) => {
  const openid = req.query.openid;
  if (!openid) return res.status(400).json({ error: '缺少 openid' });

  const d = getDB();
  let records = (d.point_redemptions || []).filter(r => r.openid === openid);
  records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json({ records });
});

/**
 * GET /api/points/levels
 * 获取所有等级信息
 */
router.get('/levels', (req, res) => {
  res.json({ levels: LEVELS });
});

// ==================== 管理端接口 ====================

/**
 * GET /api/points/admin/overview
 * 管理端积分总览
 */
router.get('/admin/overview', (req, res) => {
  const d = getDB();
  const allPoints = d.user_points || [];
  
  const totalUsers = allPoints.length;
  const totalPointsIssued = allPoints.reduce((s, u) => s + u.total_points, 0);
  const levelDistribution = {};
  LEVELS.forEach(l => levelDistribution[l.name] = 0);
  allPoints.forEach(u => {
    const info = getLevelInfo(u.total_points);
    levelDistribution[info.name] = (levelDistribution[info.name] || 0) + 1;
  });

  // 近7天积分发放趋势
  const allRecords = d.point_records || [];
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const dayRecords = allRecords.filter(r => r.created_at && r.created_at.slice(0, 10) === date && r.points > 0);
    trend.push({
      date,
      points: dayRecords.reduce((s, r) => s + r.points, 0),
      actions: dayRecords.length
    });
  }

  // 兑换统计
  const redemptions = d.point_redemptions || [];
  const totalRedeemed = redemptions.reduce((s, r) => s + r.points_cost, 0);

  res.json({
    totalUsers,
    totalPointsIssued,
    totalRedeemed,
    levelDistribution,
    trend,
    topUsers: allPoints.sort((a, b) => b.total_points - a.total_points).slice(0, 10).map(u => ({
      openid: u.openid,
      points: u.total_points,
      level: getLevelInfo(u.total_points).level,
      levelName: getLevelInfo(u.total_points).name
    }))
  });
});

/**
 * POST /api/points/admin/rewards
 * 创建积分商品
 */
router.post('/admin/rewards', (req, res) => {
  const { title, description, icon, points_required, type, value, stock } = req.body;
  if (!title || !points_required) return res.status(400).json({ error: '缺少参数' });

  const d = getDB();
  const reward = {
    id: db.nextId('point_rewards'),
    title,
    description: description || '',
    icon: icon || '🎁',
    points_required,
    type: type || 'coupon',
    value: value || '',
    stock: stock !== undefined ? stock : -1,
    status: 'active',
    created_at: new Date().toISOString()
  };
  if (!d.point_rewards) d.point_rewards = [];
  d.point_rewards.push(reward);
  db.syncRow('point_rewards', reward);
  res.json({ success: true, reward });
});

/**
 * PUT /api/points/admin/rewards/:id
 * 更新积分商品
 */
router.put('/admin/rewards/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const d = getDB();
  const reward = (d.point_rewards || []).find(r => r.id === id);
  if (!reward) return res.status(404).json({ error: '商品不存在' });
  
  const allowed = ['title', 'description', 'icon', 'points_required', 'type', 'value', 'stock', 'status'];
  allowed.forEach(f => { if (req.body[f] !== undefined) reward[f] = req.body[f]; });
  db.syncRow('point_rewards', reward);
  res.json({ success: true });
});

/**
 * DELETE /api/points/admin/rewards/:id
 * 删除积分商品（下架）
 */
router.delete('/admin/rewards/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const d = getDB();
  const reward = (d.point_rewards || []).find(r => r.id === id);
  if (!reward) return res.status(404).json({ error: '商品不存在' });
  reward.status = 'inactive';
  db.syncRow('point_rewards', reward);
  res.json({ success: true });
});

/**
 * GET /api/points/admin/records
 * 管理端：积分记录列表
 */
router.get('/admin/records', (req, res) => {
  const d = getDB();
  let records = d.point_records || [];
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  records = records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const total = records.length;
  const list = records.slice(offset, offset + parseInt(limit));
  res.json({ list, total, page: parseInt(page), limit: parseInt(limit) });
});

/**
 * GET /api/points/admin/redemptions
 * 管理端：兑换记录列表
 */
router.get('/admin/redemptions', (req, res) => {
  const d = getDB();
  let records = d.point_redemptions || [];
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  records = records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const total = records.length;
  const list = records.slice(offset, offset + parseInt(limit));
  res.json({ list, total, page: parseInt(page), limit: parseInt(limit) });
});

// 导出积分规则和等级配置供其他模块使用
router.POINT_RULES = POINT_RULES;
router.LEVELS = LEVELS;
router.addPoints = addPoints;

module.exports = router;
