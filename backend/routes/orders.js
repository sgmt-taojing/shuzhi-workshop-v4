const { getDB, nextId, save, syncRow } = require('../models/db');
const { createNotification } = require('./notifications');
const { log: auditLog } = require('../middleware/audit');
const router = require('express').Router();

// 合法订单状态及允许的流转方向
const STATUS_TRANSITIONS = {
  pending: ['paid', 'cancelled'],      // 待支付 → 已支付 / 已取消
  paid: ['shipped', 'refunding', 'cancelled'],  // 已支付 → 已发货 / 退款中 / 已取消
  shipped: ['completed', 'refunding'],  // 已发货 → 已完成 / 退款中
  completed: [],                         // 已完成 → 终态
  cancelled: [],                         // 已取消 → 终态
  refunding: ['refunded', 'paid'],      // 退款中 → 已退款 / 退回已支付
  refunded: []                           // 已退款 → 终态
};

function isValidPhone(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone));
}

function isValidStatusTransition(from, to) {
  const allowed = STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

// 创建订单
router.post('/', (req, res) => {
  const {
    product_type, product_id, product_title, amount, quantity,
    buyer_name, buyer_phone, buyer_openid, remark,
    user_id, coupon_code, coupon_id, discount_amount, original_amount
  } = req.body;

  if (!product_id || !product_title || !buyer_name || !buyer_phone) {
    return res.status(400).json({ error: '缺少必填项（product_id, product_title, buyer_name, buyer_phone）' });
  }
  if (!isValidPhone(buyer_phone)) {
    return res.status(400).json({ error: '手机号格式不正确' });
  }
  if (Number(amount) < 0 || isNaN(Number(amount))) {
    return res.status(400).json({ error: '金额必须为非负数' });
  }
  if (quantity && (Number(quantity) < 1 || Number(quantity) > 999)) {
    return res.status(400).json({ error: '数量须在1-999之间' });
  }

  const db = getDB();
  const orderNo = 'DT' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const order = {
    id: nextId('orders'),
    order_no: orderNo,
    product_type: product_type || 'client_product',
    product_id: Number(product_id),
    product_title,
    amount: Number(amount) || 0,
    original_amount: Number(original_amount) || Number(amount) || 0,
    discount_amount: Number(discount_amount) || 0,
    coupon_code: coupon_code || '',
    coupon_id: coupon_id || null,
    quantity: Number(quantity) || 1,
    buyer_name,
    buyer_phone,
    buyer_openid: buyer_openid || '',
    user_id: user_id ? Number(user_id) : null,
    remark: remark || '',
    status: 'pending',
    payment_method: '',
    paid_at: null,
    shipped_at: null,
    completed_at: null,
    cancelled_at: null,
    cancel_reason: '',
    tracking_number: '',
    tracking_company: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.orders) db.orders = [];
  db.orders.unshift(order);
  // save() not needed - unshift auto-writes
  // 创建订单通知
  createNotification({
    type: 'order',
    title: '订单创建成功',
    content: `您的订单 ${orderNo} 已创建，产品：${product_title}，金额：¥${Number(amount).toFixed(2)}`,
    target_phones: [buyer_phone],
    link_type: 'order',
    link_id: String(order.id),
    icon: '📦'
  });
  res.json({ id: order.id, order_no: orderNo, message: '订单创建成功' });
});

// 订单统计（必须放在 /:id 和 /no/:orderNo 之前）
router.get('/stats', (req, res) => {
  const db = getDB();
  const orders = db.orders || [];
  const byStatus = {};
  orders.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
  const totalAmount = orders.filter(o => o.status === 'paid' || o.status === 'shipped' || o.status === 'completed').reduce((s, o) => s + (o.amount || 0), 0);
  res.json({
    total: orders.length,
    byStatus,
    totalAmount: Math.round(totalAmount * 100) / 100,
    pending: orders.filter(o => o.status === 'pending').length,
    paid: orders.filter(o => o.status === 'paid' || o.status === 'shipped' || o.status === 'completed').length
  });
});

// 查询订单（按手机号、openid 或用户ID）
router.get('/', (req, res) => {
  const db = getDB();
  let orders = db.orders || [];

  // 支持多种查询方式
  if (req.query.user_id) {
    orders = orders.filter(o => o.user_id === Number(req.query.user_id));
  } else if (req.query.openid) {
    orders = orders.filter(o => o.buyer_openid === req.query.openid);
  } else if (req.query.phone) {
    orders = orders.filter(o => o.buyer_phone === req.query.phone);
  }

  if (req.query.status) orders = orders.filter(o => o.status === req.query.status);
  orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // 分页支持
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const total = orders.length;
  const start = (page - 1) * limit;
  const paged = orders.slice(start, start + limit);
  res.json({ total, page, limit, data: paged });
});

// 按订单号查询（必须放在 /:id 之前）
router.get('/no/:orderNo', (req, res) => {
  const db = getDB();
  const order = (db.orders || []).find(o => o.order_no === req.params.orderNo);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  res.json(order);
});

// 获取单个订单
router.get('/:id', (req, res) => {
  const db = getDB();
  const order = (db.orders || []).find(o => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: '订单不存在' });
  res.json(order);
});

// PUT /api/orders/:id - 用户端更新订单状态（确认收货等）
router.put('/:id', (req, res) => {
  const db = getDB();
  const order = (db.orders || []).find(o => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: '订单不存在' });

  const { status } = req.body;

  // 用户端只允许：completed（确认收货）和 cancelled（取消未支付订单）
  if (status === 'completed') {
    if (!isValidStatusTransition(order.status, 'completed')) {
      return res.status(400).json({ error: '仅已发货的订单可确认收货' });
    }
    order.status = 'completed';
    order.completed_at = new Date().toISOString();
  } else if (status === 'cancelled') {
    if (!isValidStatusTransition(order.status, 'cancelled')) {
      return res.status(400).json({ error: '仅待支付订单可取消' });
    }
    order.status = 'cancelled';
    order.cancelled_at = new Date().toISOString();
  } else {
    return res.status(400).json({ error: '不支持的状态变更' });
  }

  order.updated_at = new Date().toISOString();
  syncRow('orders', order);

  // 记录审计日志
  auditLog('order.update', {
    actor_type: 'user',
    actor_id: order.buyer_phone || '',
    description: `订单状态变更: ${order.order_no} → ${status}`,
    resource_type: 'order',
    resource_id: order.order_no,
    severity: status === 'cancelled' ? 'warning' : 'info',
    metadata: { order_no: order.order_no, old_status: order.status, new_status: status }
  });

  // 通知用户
  createNotification({
    type: 'order',
    title: status === 'completed' ? '订单已完成' : '订单已取消',
    content: `订单 ${order.order_no} ${status === 'completed' ? '已确认收货' : '已取消'}`,
    target_phones: [order.buyer_phone],
    link_type: 'order',
    link_id: String(order.id),
    icon: status === 'completed' ? '✅' : '❌'
  });

  res.json({ message: '更新成功' });
});

module.exports = router;
