const { getDB, nextId, save, syncRow } = require('../models/db');
const { createNotification } = require('./notifications');
const pointsRoute = require('./points');
const router = require('express').Router();

/**
 * GET /api/reviews?product_type=client_product&product_id=1
 * 获取某个产品的评价列表
 */
router.get('/', (req, res) => {
  const db = getDB();
  let reviews = db.reviews || [];

  if (req.query.product_type) {
    reviews = reviews.filter(r => r.product_type === req.query.product_type);
  }
  if (req.query.product_id) {
    reviews = reviews.filter(r => r.product_id === Number(req.query.product_id));
  }

  // 只返回已发布的评价
  reviews = reviews.filter(r => r.status === 'published' || r.status === undefined);

  // 按时间倒序
  reviews.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // 分页参数校验
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const total = reviews.length;
  const paged = reviews.slice((page - 1) * limit, page * limit);

  res.json({
    list: paged,
    total,
    page,
    limit,
    // 统计信息
    stats: calculateStats(reviews)
  });
});

/**
 * GET /api/reviews/stats?product_type=xxx&product_id=xxx
 * 评价统计（必须放在 /:id 之前）
 */
router.get('/stats', (req, res) => {
  const db = getDB();
  let reviews = (db.reviews || []).filter(r => r.status === 'published' || r.status === undefined);

  if (req.query.product_type) {
    reviews = reviews.filter(r => r.product_type === req.query.product_type);
  }
  if (req.query.product_id) {
    reviews = reviews.filter(r => r.product_id === Number(req.query.product_id));
  }

  res.json(calculateStats(reviews));
});

/**
 * GET /api/reviews/summary/:product_type/:product_id
 * 获取产品评价概要（评分统计，必须放在 /:id 之前）
 */
router.get('/summary/:product_type/:product_id', (req, res) => {
  const db = getDB();
  const { product_type, product_id } = req.params;

  let reviews = (db.reviews || []).filter(r =>
    r.product_type === product_type &&
    r.product_id === Number(product_id) &&
    (r.status === 'published' || r.status === undefined)
  );

  res.json(calculateStats(reviews));
});

/**
 * GET /api/reviews/:id
 * 获取单条评价详情
 */
router.get('/:id', (req, res) => {
  const db = getDB();
  const review = (db.reviews || []).find(r => r.id === Number(req.params.id));
  if (!review) return res.status(404).json({ error: '评价不存在' });
  res.json(review);
});

/**
 * POST /api/reviews
 * 提交评价
 */
router.post('/', (req, res) => {
  const {
    order_id, product_type, product_id, product_title,
    rating, content, images,
    reviewer_name, reviewer_phone, reviewer_avatar
  } = req.body;

  // 校验
  if (!product_id || !product_title) {
    return res.status(400).json({ error: '缺少产品信息' });
  }
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: '评分需在1-5星之间' });
  }
  if (!content || content.trim().length < 5) {
    return res.status(400).json({ error: '评价内容至少5个字' });
  }
  if (content.trim().length > 500) {
    return res.status(400).json({ error: '评价内容不能超过500个字' });
  }
  if (!reviewer_name || !reviewer_phone) {
    return res.status(400).json({ error: '请填写姓名和手机号' });
  }
  // XSS 防护：拒绝包含可疑脚本内容
  const xssPattern = /<script|javascript:|on\w+=/i;
  if (xssPattern.test(content + reviewer_name + reviewer_phone)) {
    return res.status(400).json({ error: '提交内容包含不安全字符' });
  }

  const db = getDB();
  if (!db.reviews) db.reviews = [];

  // 检查是否已评价过该订单
  if (order_id) {
    const existing = db.reviews.find(r => r.order_id === Number(order_id));
    if (existing) {
      return res.status(400).json({ error: '该订单已评价，不可重复评价' });
    }

    // 检查订单是否存在且已完成
    const order = (db.orders || []).find(o => o.id === Number(order_id));
    if (order && order.status !== 'completed') {
      return res.status(400).json({ error: '订单完成后才能评价' });
    }
  }

  const review = {
    id: nextId('reviews'),
    order_id: order_id ? Number(order_id) : null,
    product_type: product_type || 'client_product',
    product_id: Number(product_id),
    product_title,
    rating: Number(rating),
    content: content.trim(),
    images: images || [],
    reviewer_name,
    reviewer_phone,
    reviewer_avatar: reviewer_avatar || '',
    status: 'published',
    admin_reply: '',
    admin_replied_at: null,
    likes: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.reviews.unshift(review);
  // save() not needed - unshift auto-writes

  // 如果有关联订单，标记订单为已评价
  if (order_id) {
    const order = (db.orders || []).find(o => o.id === Number(order_id));
    if (order) {
      order.reviewed = true;
      order.reviewed_at = new Date().toISOString();
      order.updated_at = new Date().toISOString();
      syncRow('orders', order);
    }
  }

  // 通知管理员 - 新评价
  createNotification({
    type: 'review',
    title: '新产品评价',
    content: `${reviewer_name} 对「${product_title}」评价了 ${rating} 星`,
    target_phones: [],
    link_type: 'review',
    link_id: String(review.id),
    icon: '⭐'
  });

  // 积分奖励
  const openid = req.body.openid || '';
  if (openid) {
    pointsRoute.addPoints(openid, 'write_review', String(review.id), '评价: ' + product_title);
  }

  res.json({ id: review.id, message: '评价提交成功' });
});

/**
 * PUT /api/reviews/:id/like
 * 点赞评价（必须放在 /:id 之后，但不能是 /:id/like 被 /:id 误匹配）
 * 注意：这个路由必须放在 /:id 之后，但 Express 会正确区分 /:id/like 和 /:id
 */
router.put('/:id/like', (req, res) => {
  const db = getDB();
  const review = (db.reviews || []).find(r => r.id === Number(req.params.id));
  if (!review) return res.status(404).json({ error: '评价不存在' });

  review.likes = (review.likes || 0) + 1;
  review.updated_at = new Date().toISOString();
  syncRow('reviews', review);

  res.json({ likes: review.likes, message: '点赞成功' });
});

// ──────────────────────────────────────
// 管理端接口
// ──────────────────────────────────────

/**
 * GET /api/reviews/admin/list
 * 管理端获取所有评价（含未发布）
 */
router.get('/admin/list', (req, res) => {
  const db = getDB();
  let reviews = db.reviews || [];

  if (req.query.status) {
    reviews = reviews.filter(r => r.status === req.query.status);
  }
  if (req.query.product_id) {
    reviews = reviews.filter(r => r.product_id === Number(req.query.product_id));
  }

  reviews.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // 分页参数校验
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const total = reviews.length;
  const paged = reviews.slice((page - 1) * limit, page * limit);

  res.json({
    list: paged,
    total,
    page,
    limit
  });
});

/**
 * PUT /api/reviews/admin/:id
 * 管理端更新评价状态 / 回复
 */
router.put('/admin/:id', (req, res) => {
  const db = getDB();
  const review = (db.reviews || []).find(r => r.id === Number(req.params.id));
  if (!review) return res.status(404).json({ error: '评价不存在' });

  const { status, admin_reply } = req.body;

  if (status) {
    review.status = status;
  }
  if (admin_reply !== undefined) {
    review.admin_reply = admin_reply;
    review.admin_replied_at = admin_reply ? new Date().toISOString() : null;
  }
  review.updated_at = new Date().toISOString();
  syncRow('reviews', review);

  // 如果是回复，发送订阅消息通知用户
  if (admin_reply && review.reviewer_phone) {
    try {
      const subscribeMsg = require('./subscribe-msg');
      const db2 = require('../models/sqlite-db').getDB();
      const user = db2.prepare('SELECT openid FROM users WHERE phone = ?').get(review.reviewer_phone);
      if (user && user.openid) {
        subscribeMsg.notifyUser(
          user.openid,
          'review_reply',
          {
            thing1: { value: (review.content || '').substring(0, 20) },
            thing2: { value: admin_reply.substring(0, 20) },
            time1: { value: new Date().toLocaleString('zh-CN') }
          },
          '',
          'review',
          review.id
        );
      }
    } catch (e) {
      console.warn('[Reviews] 发送订阅消息失败:', e.message);
    }
  }

  res.json({ message: '更新成功' });
});

/**
 * DELETE /api/reviews/admin/:id
 * 管理端删除评价
 */
router.delete('/admin/:id', (req, res) => {
  const db = getDB();
  const idx = (db.reviews || []).findIndex(r => r.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: '评价不存在' });

  db.reviews.splice(idx, 1);
  // splice auto-writes to SQLite
  res.json({ message: '删除成功' });
});

/**
 * 计算评价统计
 */
function calculateStats(reviews) {
  if (!reviews.length) {
    return {
      avg_rating: 0,
      total: 0,
      distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
    };
  }

  const total = reviews.length;
  const sum = reviews.reduce((s, r) => s + (r.rating || 0), 0);
  const avg = Math.round((sum / total) * 10) / 10;

  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  reviews.forEach(r => {
    const d = Math.floor(r.rating);
    if (distribution[d] !== undefined) distribution[d]++;
  });

  return { avg_rating: avg, total, distribution };
}

module.exports = router;
