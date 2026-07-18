const { getDB, nextId, save, syncRow, deleteRows } = require('../models/db');
const router = require('express').Router();

// 引入通知辅助函数（延迟加载，避免循环依赖）
let createNotification = null;
function getNotifFn() {
  if (createNotification) return createNotification;
  try {
    const notifModule = require('./notifications');
    createNotification = notifModule.createNotification || null;
  } catch (e) {
    // notifications.js 未导出 createNotification 时的兼容处理
  }
  return createNotification;
}

/**
 * 优惠券类型：
 *  - fixed: 固定金额减免
 *  - percent: 百分比折扣
 *  - free_shipping: 免费配送（服务类不适用）
 */

/**
 * GET /api/coupons
 * 获取优惠券列表（管理端）
 */
router.get('/', (req, res) => {
  const db = getDB();
  if (!db.coupons) db.coupons = [];
  res.json(db.coupons);
});

/**
 * GET /api/coupons/active
 * 获取当前有效的优惠券（用户端）
 */
router.get('/active', (req, res) => {
  const db = getDB();
  if (!db.coupons) db.coupons = [];

  const now = new Date().toISOString();
  const activeCoupons = db.coupons.filter(c => {
    if (c.status !== 'active') return false;
    if (c.start_time && c.start_time > now) return false;
    if (c.end_time && c.end_time < now) return false;
    if (c.usage_limit && c.used_count >= c.usage_limit) return false;
    return true;
  });

  res.json(activeCoupons);
});

/**
 * GET /api/coupons/check?code=XXX&amount=XXX
 * 验证优惠券是否可用
 */
router.get('/check', (req, res) => {
  const db = getDB();
  const { code, amount } = req.query;

  if (!code) {
    return res.status(400).json({ valid: false, error: '请输入优惠码' });
  }

  if (!db.coupons) db.coupons = [];
  const coupon = db.coupons.find(c => c.code.toUpperCase() === code.toUpperCase());

  if (!coupon) {
    return res.json({ valid: false, error: '优惠码不存在' });
  }

  if (coupon.status !== 'active') {
    return res.json({ valid: false, error: '优惠券已失效' });
  }

  const now = new Date().toISOString();
  if (coupon.start_time && coupon.start_time > now) {
    return res.json({ valid: false, error: '优惠券尚未生效' });
  }

  if (coupon.end_time && coupon.end_time < now) {
    return res.json({ valid: false, error: '优惠券已过期' });
  }

  if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
    return res.json({ valid: false, error: '优惠券已被领完' });
  }

  const orderAmount = parseFloat(amount) || 0;
  if (coupon.min_amount && orderAmount < coupon.min_amount) {
    return res.json({
      valid: false,
      error: `订单金额需满${coupon.min_amount}元才能使用此优惠券`
    });
  }

  // 计算优惠金额
  let discountAmount = 0;
  if (coupon.type === 'fixed') {
    discountAmount = coupon.value;
  } else if (coupon.type === 'percent') {
    discountAmount = Math.floor(orderAmount * coupon.value / 100);
    if (coupon.max_discount) {
      discountAmount = Math.min(discountAmount, coupon.max_discount);
    }
  }

  res.json({
    valid: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      title: coupon.title,
      type: coupon.type,
      value: coupon.value,
      discountAmount,
      minAmount: coupon.min_amount || 0
    }
  });
});

/**
 * POST /api/coupons
 * 创建优惠券（管理端）
 */
router.post('/', (req, res) => {
  const db = getDB();
  if (!db.coupons) db.coupons = [];
  if (!db._nextId) db._nextId = {};
  if (!db._nextId.coupons) db._nextId.coupons = 1;

  const {
    code, title, type, value,
    min_amount, max_discount, usage_limit,
    start_time, end_time, description
  } = req.body;

  if (!code || !title || !type || !value) {
    return res.status(400).json({ error: '缺少必要字段' });
  }

  // 检查编码是否重复
  if (db.coupons.find(c => c.code.toUpperCase() === code.toUpperCase())) {
    return res.status(400).json({ error: '优惠码已存在' });
  }

  const coupon = {
    id: nextId('coupons'),
    code: code.toUpperCase(),
    title,
    type, // fixed / percent
    value: parseFloat(value),
    min_amount: parseFloat(min_amount) || 0,
    max_discount: parseFloat(max_discount) || 0,
    usage_limit: parseInt(usage_limit) || 0,
    used_count: 0,
    start_time: start_time || null,
    end_time: end_time || null,
    description: description || '',
    status: 'active',
    created_at: new Date().toISOString()
  };

  db.coupons.push(coupon);
  // save() not needed - push auto-writes

  res.json(coupon);
});

/**
 * GET /api/coupons/stats
 * 优惠券统计（必须放在 /:id 之前）
 */
router.get('/stats', (req, res) => {
  const db = getDB();
  if (!db.coupons) db.coupons = [];
  const total = db.coupons.length;
  const active = db.coupons.filter(c => c.status === 'active').length;
  const expired = db.coupons.filter(c => c.status === 'expired').length;
  const now = new Date().toISOString();
  const expiringSoon = db.coupons.filter(c => c.status === 'active' && c.end_time && c.end_time < new Date(Date.now() + 7*24*60*60*1000).toISOString() && c.end_time > now).length;
  res.json({ total, active, expired, expiringSoon, usedTotal: db.coupons.reduce((s,c) => s + (c.used_count||0), 0) });
});

/**
 * GET /api/coupons/:id
 * 获取单个优惠券详情
 */
router.get('/:id', (req, res) => {
  const db = getDB();
  if (!db.coupons) return res.status(404).json({ error: '优惠券不存在' });
  const coupon = db.coupons.find(c => c.id === Number(req.params.id));
  if (!coupon) return res.status(404).json({ error: '优惠券不存在' });
  res.json(coupon);
});

/**
 * PUT /api/coupons/:id
 * 更新优惠券（管理端）
 */
router.put('/:id', (req, res) => {
  const db = getDB();
  if (!db.coupons) return res.status(404).json({ error: '优惠券不存在' });

  const idx = db.coupons.findIndex(c => c.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: '优惠券不存在' });

  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id;
  delete updates.code; // 不允许修改编码

  db.coupons[idx] = { ...db.coupons[idx], ...updates };
  syncRow('coupons', db.coupons[idx]);

  res.json(db.coupons[idx]);
});

/**
 * POST /api/coupons/:id/claim
 * 用户领取优惠券
 */
router.post('/:id/claim', (req, res) => {
  const db = getDB();
  const couponId = Number(req.params.id);
  const { openid } = req.body;

  if (!openid) {
    return res.status(400).json({ error: '缺少 openid' });
  }

  if (!db.coupons) return res.status(404).json({ error: '优惠券不存在' });

  const coupon = db.coupons.find(c => c.id === couponId);
  if (!coupon) return res.status(404).json({ error: '优惠券不存在' });

  // 校验优惠券状态
  if (coupon.status !== 'active') {
    return res.json({ ok: false, error: '优惠券已失效' });
  }
  const now = new Date().toISOString();
  if (coupon.end_time && coupon.end_time < now) {
    return res.json({ ok: false, error: '优惠券已过期' });
  }
  if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
    return res.json({ ok: false, error: '优惠券已被领完' });
  }

  // 检查是否已领取
  if (!db.user_coupons) db.user_coupons = [];
  const alreadyClaimed = db.user_coupons.find(
    uc => uc.coupon_id === couponId && uc.openid === openid
  );
  if (alreadyClaimed) {
    return res.json({ ok: false, error: '您已领取过该优惠券' });
  }

  // 创建用户优惠券记录
  if (!db._nextId) db._nextId = {};
  if (!db._nextId.user_coupons) db._nextId.user_coupons = 1;

  const userCoupon = {
    id: nextId('user_coupons'),
    coupon_id: couponId,
    openid,
    phone: req.body.phone || '',   // 领券时记录手机号，用于推送通知
    code: coupon.code,
    title: coupon.title,
    type: coupon.type,
    value: coupon.value,
    min_amount: coupon.min_amount || 0,
    max_discount: coupon.max_discount || 0,
    end_time: coupon.end_time || null,
    status: 'unused',  // unused / used / expired
    claimed_at: new Date().toISOString(),
    used_at: null,
    remind_sent: false   // 到期提醒是否已发送
  };

  db.user_coupons.push(userCoupon);

  // 增加领用计数
  coupon.used_count = (coupon.used_count || 0) + 1;
  syncRow('coupons', coupon);

  // save() not needed - push + syncRow auto-writes

  res.json({ ok: true, userCoupon });
});

/**
 * GET /api/coupons/my?openid=XXX
 * 获取用户已领取的优惠券
 */
router.get('/my', (req, res) => {
  const db = getDB();
  const { openid, status } = req.query;

  if (!openid) {
    return res.status(400).json({ error: '缺少 openid' });
  }

  if (!db.user_coupons) db.user_coupons = [];

  let myCoupons = db.user_coupons.filter(uc => uc.openid === openid);

  // 自动过期检查
  const now = new Date().toISOString();
  myCoupons.forEach(uc => {
    if (uc.status === 'unused' && uc.end_time && uc.end_time < now) {
      uc.status = 'expired';
      syncRow('user_coupons', uc);
    }
  });
  // save() not needed - syncRow auto-writes

  // 按状态过滤
  if (status) {
    myCoupons = myCoupons.filter(uc => uc.status === status);
  }

  // 按领取时间倒序
  myCoupons.sort((a, b) => new Date(b.claimed_at) - new Date(a.claimed_at));

  res.json(myCoupons);
});

/**
 * POST /api/coupons/:id/use
 * 使用优惠券（下单时调用）
 */
router.post('/:id/use', (req, res) => {
  const db = getDB();
  if (!db.coupons) return res.status(404).json({ error: '优惠券不存在' });

  const idx = db.coupons.findIndex(c => c.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: '优惠券不存在' });

  db.coupons[idx].used_count = (db.coupons[idx].used_count || 0) + 1;
  syncRow('coupons', db.coupons[idx]);

  res.json({ ok: true, used_count: db.coupons[idx].used_count });
});

/**
 * DELETE /api/coupons/:id
 * 删除优惠券（管理端）
 */
router.delete('/:id', (req, res) => {
  const db = getDB();
  if (!db.coupons) return res.status(404).json({ error: '优惠券不存在' });

  const idx = db.coupons.findIndex(c => c.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: '优惠券不存在' });

  db.coupons.splice(idx, 1);
  // splice auto-writes to SQLite

  res.json({ ok: true });
});

/**
 * POST /api/coupons/check-expiring
 * 扫描即将过期的用户优惠券，自动发送到期提醒通知
 * 设计为可被 cron 定时调用（默认提前 3 天提醒）
 * 请求体：{ days_before: 3 }
 */
router.post('/check-expiring', (req, res) => {
  const db = getDB();
  const daysBefore = parseInt(req.body.days_before) || 3;
  const now = new Date();
  const threshold = new Date(now.getTime() + daysBefore * 24 * 60 * 60 * 1000);

  if (!db.user_coupons) db.user_coupons = [];

  const expiring = db.user_coupons.filter(uc => {
    if (uc.status !== 'unused') return false;
    if (uc.remind_sent) return false;
    if (!uc.end_time) return false;
    const endTime = new Date(uc.end_time);
    return endTime > now && endTime <= threshold;
  });

  let notifiedCount = 0;
  const notifFn = getNotifFn();

  expiring.forEach(uc => {
    // 计算剩余天数（用于文案）
    const daysLeft = Math.ceil((new Date(uc.end_time) - now) / (24 * 60 * 60 * 1000));
    const valueText = uc.type === 'percent' ? `${uc.value}%折扣` : `¥${uc.value}减免`;

    // 优先用 phone 推送，否则尝试通过 openid 查找用户手机号
    let targetPhones = [];
    if (uc.phone) {
      targetPhones = [uc.phone];
    } else if (db.users) {
      const user = db.users.find(u => u.openid === uc.openid);
      if (user && user.phone) targetPhones = [user.phone];
    }

    // 创建通知
    if (notifFn) {
      try {
        notifFn({
          type: 'activity',
          title: `🎫 优惠券即将到期`,
          content: `您领取的「${uc.title}」(${valueText})还有${daysLeft}天到期，快去使用吧！`,
          target_phones: targetPhones,
          link_type: 'coupon',
          link_id: String(uc.id),
          icon: '🎫'
        });
      } catch (e) {
        console.error('发送优惠券到期通知失败:', e.message);
      }
    }

    // 同时写一条站内通知记录（即使没有 phone 也写，便于管理后台查看）
    if (!db.notifications) db.notifications = [];
    if (!db._nextId.notifications) db._nextId.notifications = 1;
    db.notifications.push({
      id: nextId('notifications'),
      type: 'activity',
      title: `🎫 优惠券即将到期`,
      content: `用户 ${uc.openid} 领取的「${uc.title}」还有${daysLeft}天到期`,
      target_phones: targetPhones,
      link_type: 'coupon',
      link_id: String(uc.id),
      icon: '🎫',
      created_at: new Date().toISOString()
    });

    uc.remind_sent = true;
    syncRow('user_coupons', uc);
    notifiedCount++;
  });

  if (notifiedCount > 0) {
    // syncRow already called per-item above
  }

  res.json({
    ok: true,
    checked_at: now.toISOString(),
    days_before: daysBefore,
    expiring_count: expiring.length,
    notified_count: notifiedCount
  });
});

/**
 * GET /api/coupons/expiring-preview
 * 管理端预览即将过期的用户优惠券（不发送通知）
 */
router.get('/expiring-preview', (req, res) => {
  const db = getDB();
  const daysBefore = parseInt(req.query.days_before) || 3;
  const now = new Date();
  const threshold = new Date(now.getTime() + daysBefore * 24 * 60 * 60 * 1000);

  if (!db.user_coupons) db.user_coupons = [];

  const expiring = db.user_coupons.filter(uc => {
    if (uc.status !== 'unused') return false;
    if (!uc.end_time) return false;
    const endTime = new Date(uc.end_time);
    return endTime > now && endTime <= threshold;
  }).map(uc => {
    const daysLeft = Math.ceil((new Date(uc.end_time) - now) / (24 * 60 * 60 * 1000));
    return {
      id: uc.id,
      coupon_id: uc.coupon_id,
      title: uc.title,
      value: uc.value,
      type: uc.type,
      openid: uc.openid,
      phone: uc.phone,
      end_time: uc.end_time,
      days_left: daysLeft,
      remind_sent: uc.remind_sent
    };
  });

  res.json({ total: expiring.length, days_before: daysBefore, list: expiring });
});

module.exports = router;
