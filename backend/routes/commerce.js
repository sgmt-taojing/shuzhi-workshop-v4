const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

// ==================== 产品SKU ====================

// GET /:productId/skus — 获取产品SKU列表
router.get('/:productId/skus', (req, res) => {
  const pid = Number(req.params.productId);
  const db = getDB();
  const rows = (db.product_skus || []).filter(r => r.product_id === pid && r.status === 'active')
    .sort((a,b) => (a.sort_order||0) - (b.sort_order||0));
  res.json({ list: rows });
});

// POST /:productId/skus — 创建SKU
router.post('/:productId/skus', (req, res) => {
  const pid = Number(req.params.productId);
  const { name, specs, price, original_price, stock, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'SKU名称不能为空' });

  const id = nextId('product_skus');
  const now = new Date().toISOString();
  const sku = {
    id, product_id: pid, name,
    specs: specs || {}, price: price||0, original_price: original_price||0,
    stock: stock??-1, sort_order: sort_order||0, status: 'active',
    created_at: now, updated_at: now
  };
  getDB().product_skus.push(sku);
  res.status(201).json(sku);
});

// PUT /:productId/skus/:skuId
router.put('/:productId/skus/:skuId', (req, res) => {
  const skuId = Number(req.params.skuId);
  const db = getDB();
  const sku = (db.product_skus || []).find(r => r.id === skuId);
  if (!sku) return res.status(404).json({ error: 'SKU不存在' });

  ['name','specs','price','original_price','stock','sort_order','status'].forEach(f => {
    if (req.body[f] !== undefined) sku[f] = req.body[f];
  });
  sku.updated_at = new Date().toISOString();
  syncRow('product_skus', sku);
  res.json(sku);
});

// DELETE /:productId/skus/:skuId
router.delete('/:productId/skus/:skuId', (req, res) => {
  const skuId = Number(req.params.skuId);
  const db = getDB();
  const idx = (db.product_skus || []).findIndex(r => r.id === skuId);
  if (idx === -1) return res.status(404).json({ error: 'SKU不存在' });
  db.product_skus.splice(idx, 1);
  deleteRows('product_skus', { id: skuId });
  res.json({ success: true });
});

// ==================== 购物车 ====================

// GET /cart/:userId — 获取购物车
router.get('/cart/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const db = getDB();
  const rows = (db.cart_items || []).filter(r => r.user_id === userId)
    .sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  
  const totalAmount = rows.filter(r => r.selected).reduce((s, r) => s + (r.price * r.quantity), 0);
  const totalCount = rows.filter(r => r.selected).reduce((s, r) => s + r.quantity, 0);
  
  res.json({ list: rows, totalAmount, totalCount, totalItems: rows.length });
});

// POST /cart — 添加到购物车
router.post('/cart', (req, res) => {
  const { user_id, user_openid, product_id, sku_id, product_title, sku_name, price, quantity, image } = req.body;
  if (!product_id || !user_id) return res.status(400).json({ error: '缺少产品ID或用户ID' });

  const db = getDB();
  // 检查是否已有相同SKU
  const existing = (db.cart_items || []).find(r => 
    r.user_id === user_id && r.product_id === product_id && r.sku_id === (sku_id||0)
  );
  
  if (existing) {
    existing.quantity = (existing.quantity || 1) + (quantity || 1);
    existing.updated_at = new Date().toISOString();
    syncRow('cart_items', existing);
    return res.json(existing);
  }

  const id = nextId('cart_items');
  const item = {
    id, user_id, user_openid: user_openid||'',
    product_id, sku_id: sku_id||0,
    product_title: product_title||'', sku_name: sku_name||'',
    price: price||0, quantity: quantity||1,
    image: image||'', selected: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  db.cart_items.push(item);
  res.status(201).json(item);
});

// PUT /cart/:itemId — 更新购物车项
router.put('/cart/:itemId', (req, res) => {
  const itemId = Number(req.params.itemId);
  const db = getDB();
  const item = (db.cart_items || []).find(r => r.id === itemId);
  if (!item) return res.status(404).json({ error: '购物车项不存在' });

  ['quantity','selected','sku_id','sku_name','price'].forEach(f => {
    if (req.body[f] !== undefined) item[f] = req.body[f];
  });
  item.updated_at = new Date().toISOString();
  syncRow('cart_items', item);
  res.json(item);
});

// DELETE /cart/:itemId — 删除购物车项
router.delete('/cart/:itemId', (req, res) => {
  const itemId = Number(req.params.itemId);
  const db = getDB();
  const idx = (db.cart_items || []).findIndex(r => r.id === itemId);
  if (idx === -1) return res.status(404).json({ error: '购物车项不存在' });
  db.cart_items.splice(idx, 1);
  deleteRows('cart_items', { id: itemId });
  res.json({ success: true });
});

// POST /cart/:userId/checkout — 从购物车结算（批量下单）
router.post('/cart/:userId/checkout', (req, res) => {
  const userId = Number(req.params.userId);
  const db = getDB();
  const { buyer_name, buyer_phone, buyer_openid, remark } = req.body;
  
  const selectedItems = (db.cart_items || []).filter(r => r.user_id === userId && r.selected);
  if (selectedItems.length === 0) return res.status(400).json({ error: '购物车没有选中商品' });

  const orders = [];
  const now = new Date().toISOString();
  
  selectedItems.forEach(item => {
    const orderId = nextId('orders');
    const orderNo = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);
    const order = {
      id: orderId, order_no: orderNo,
      product_type: 'product', product_id: item.product_id,
      product_title: item.product_title,
      sku_id: item.sku_id, sku_name: item.sku_name,
      amount: item.price * item.quantity,
      original_amount: item.price * item.quantity,
      discount_amount: 0, coupon_code: '', coupon_id: 0, coupon_info: '',
      quantity: item.quantity,
      buyer_name: buyer_name||'', buyer_phone: buyer_phone||'',
      buyer_openid: buyer_openid||'', user_id: userId,
      remark: remark||'', status: 'pending',
      payment_method: '', transaction_id: '',
      refund_status: '',
      created_at: now, updated_at: now
    };
    db.orders.push(order);
    orders.push(order);
    
    // 清除购物车项
    deleteRows('cart_items', { id: item.id });
  });
  
  const cartIdx = (db.cart_items || []).map((r, i) => r.user_id === userId && r.selected ? i : -1)
    .filter(i => i >= 0).sort((a,b) => b - a);
  cartIdx.forEach(i => db.cart_items.splice(i, 1));

  res.status(201).json({ orders, count: orders.length, totalAmount: orders.reduce((s,o) => s + o.amount, 0) });
});

// ==================== 退款管理 ====================

// GET /refunds — 退款列表
router.get('/refunds', (req, res) => {
  const db = getDB();
  let rows = (db.order_refunds || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  
  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);
  
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const list = rows.slice((page-1)*limit, page*limit);
  
  res.json({ list, total, page, limit });
});

// GET /refunds/:id
router.get('/refunds/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const refund = (db.order_refunds || []).find(r => r.id === id);
  if (!refund) return res.status(404).json({ error: '退款记录不存在' });
  
  const order = (db.orders || []).find(o => o.id === refund.order_id);
  res.json({ ...refund, order });
});

// POST /refunds — 申请退款
router.post('/refunds', (req, res) => {
  const { order_id, order_no, user_id, user_name, type, reason, amount } = req.body;
  if (!order_id) return res.status(400).json({ error: '缺少订单ID' });

  const db = getDB();
  const order = (db.orders || []).find(o => o.id === order_id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.refund_status === 'refunding') return res.status(400).json({ error: '该订单正在退款中' });
  if (order.refund_status === 'refunded') return res.status(400).json({ error: '该订单已退款' });

  const id = nextId('order_refunds');
  const now = new Date().toISOString();
  const refund = {
    id, order_id, order_no: order_no || order.order_no,
    user_id: user_id||0, user_name: user_name||'',
    type: type||'refund', reason: reason||'',
    amount: amount || order.amount,
    status: 'pending',
    applicant_at: now, approver: '', approver_comment: '', approved_at: '',
    created_at: now, updated_at: now
  };
  db.order_refunds.push(refund);

  // 更新订单退款状态
  order.refund_status = 'refunding';
  order.updated_at = now;
  syncRow('orders', order);

  res.status(201).json(refund);
});

// PUT /refunds/:id/process — 处理退款
router.put('/refunds/:id/process', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const refund = (db.order_refunds || []).find(r => r.id === id);
  if (!refund) return res.status(404).json({ error: '退款记录不存在' });
  if (refund.status !== 'pending') return res.status(400).json({ error: '该退款已处理' });

  const { status, approver, approver_comment } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: '无效状态' });

  refund.status = status;
  refund.approver = approver || '';
  refund.approver_comment = approver_comment || '';
  refund.approved_at = new Date().toISOString();
  refund.updated_at = new Date().toISOString();
  syncRow('order_refunds', refund);

  // 更新订单状态
  const order = (db.orders || []).find(o => o.id === refund.order_id);
  if (order) {
    if (status === 'approved') {
      order.refund_status = 'refunded';
      order.status = 'refunded';
    } else {
      order.refund_status = '';
    }
    order.updated_at = new Date().toISOString();
    syncRow('orders', order);
  }

  res.json({ ...refund, order_status: order ? order.status : '' });
});

// GET /:productId/endorsements — 产品背书列表
router.get('/:productId/endorsements', (req, res) => {
  const pid = Number(req.params.productId);
  const db = getDB();
  const rows = (db.product_endorsements || []).filter(r => r.product_id === pid && r.status === 'valid')
    .sort((a,b) => (a.sort_order||0) - (b.sort_order||0));
  const typeMap = {geo_cert:'地理标志', brand_auth:'大厂授权', govt_rec:'政府推介', quality_test:'质检报告', organic_cert:'有机认证', honor:'荣誉资质'};
  const typeIcon = {geo_cert:'📍', brand_auth:'🏭', govt_rec:'🏛️', quality_test:'🔬', organic_cert:'🌿', honor:'🏆'};
  res.json({ list: rows.map(r => ({...r, type_label: typeMap[r.type]||r.type, type_icon: typeIcon[r.type]||'📋'})) });
});

module.exports = router;
