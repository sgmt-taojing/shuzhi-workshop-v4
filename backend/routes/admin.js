const { getDB, nextId, save, syncRow, updateRow, deleteRows, insertRow } = require('../models/db');
const { log: auditLog } = require('../middleware/audit');
const router = require('express').Router();

const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authCheck(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: '未授权' });
  const token = auth.slice(7);
  const db = getDB();
  const session = (db.admin_sessions || []).find(s => s.token === token);
  if (!session) return res.status(401).json({ error: '登录已过期，请重新登录' });
  // Check expiry
  if (new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
  // Attach user info to request
  req.adminUser = { id: session.admin_id, username: session.username, role_id: session.role_id, role_name: session.role_name, permissions: typeof session.permissions === 'string' ? JSON.parse(session.permissions||'[]') : (session.permissions||[]) };
  next();
}

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDB();
  const admin = (db.admins || []).find(a => a.username === username && a.password === password);
  if (admin) {
    if (admin.status === 'disabled') return res.status(403).json({ error: '账号已禁用' });
    let role = null;
    let permissions = ['*'];
    if (admin.role_id) {
      role = (db.roles || []).find(r => r.id === admin.role_id);
      if (role) {
        permissions = typeof role.permissions === 'string' ? JSON.parse(role.permissions || '[]') : (role.permissions || []);
      }
    }
    // 生成真实 session token
    const token = generateToken();
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const sessionId = nextId('admin_sessions');
    db.admin_sessions.push({
      id: sessionId, token, admin_id: admin.id, username: admin.username,
      role_id: admin.role_id || 0, role_name: admin.role_name || '',
      permissions: JSON.stringify(permissions), created_at: now, expires_at: expires
    });
    // 清理旧 session
    db.admin_sessions = (db.admin_sessions || []).filter(s => s.admin_id !== admin.id || s.id === sessionId);
    
    auditLog('admin.login', {
      actor_type: 'admin', actor_id: username, actor_name: admin.display_name || username,
      description: `管理员登录成功: ${username} (${admin.role_name || '未分配角色'})`,
      severity: 'info', metadata: { username, role: admin.role_name }
    });
    res.json({
      token, username: admin.username, display_name: admin.display_name || admin.username,
      role_id: admin.role_id || 0, role_name: admin.role_name || '',
      department: admin.department || '', permissions
    });
  } else {
    auditLog('admin.login_failed', {
      actor_type: 'admin', actor_id: username || 'unknown',
      description: `管理员登录失败: ${username || '未知用户'}`,
      severity: 'warning', metadata: { username }
    });
    res.status(401).json({ error: '用户名或密码错误' });
  }
});

// POST /logout — 退出登录
router.post('/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const db = getDB();
    const idx = (db.admin_sessions || []).findIndex(s => s.token === token);
    if (idx !== -1) {
      db.admin_sessions.splice(idx, 1);
    }
  }
  res.json({ success: true });
});

// GET /me — 当前用户信息
router.get('/me', authCheck, (req, res) => {
  res.json(req.adminUser);
});

router.get('/dashboard', authCheck, (req, res) => {
  const db = getDB();
  const contacts = (db.contacts || []).length;
  const pendingContacts = (db.contacts || []).filter(r => r.status === 'pending').length;
  const onboardings = (db.onboardings || []).length;
  const pendingOnboardings = (db.onboardings || []).filter(r => r.status === 'pending').length;
  const products = (db.products || []).length;
  const articles = (db.articles || []).length;
  const clientProducts = (db.client_products || []).length;
  const clients = (db.clients || []).length;
  const allOrders = db.orders || [];
  const pendingOrders = allOrders.filter(o => o.status === 'pending').length;
  // 客服会话统计
  const csMessages = db.cs_messages || [];
  const csConversations = new Set();
  csMessages.forEach(m => { csConversations.add(m.from_user || m.openid || 'unknown'); });
  const csUnhandled = csMessages.filter(m => m.direction === 'user_to_service' && !m.handled).length;
  // 模板消息统计
  const tmLogs = db.template_msg_logs || [];
  const tmSuccess = tmLogs.filter(l => l.status === 'success').length;
  const tmFailed = tmLogs.filter(l => l.status === 'failed' || l.status === 'error').length;
  const tmEnabled = !!(process.env.WECHAT_TEMPLATE_ID && process.env.WECHAT_ADMIN_OPENID);
  
  // 订单分类统计
  const validOrders = allOrders.filter(o => o.status !== 'cancelled');
  const totalRevenue = validOrders.reduce((s, o) => s + (o.amount || 0), 0);
  
  // 按产品类型分类营收
  const categoryRevenue = {};
  const categoryOrders = {};
  validOrders.forEach(o => {
    let cat = '其他';
    if (o.product_type === 'product') {
      const p = (db.products || []).find(p => p.id === o.product_id);
      cat = p ? (p.category || '数字化产品') : '数字化产品';
    } else if (o.product_type === 'client_product') {
      const cp = (db.client_products || []).find(p => p.id === o.product_id);
      cat = cp ? (cp.category || '客户产品') : '客户产品';
    } else if (o.order_no && o.order_no.startsWith('MALL')) {
      cat = '名优特产';
    } else if (o.order_no && o.order_no.startsWith('GROUP')) {
      cat = '团购';
    }
    categoryRevenue[cat] = (categoryRevenue[cat] || 0) + (o.amount || 0);
    categoryOrders[cat] = (categoryOrders[cat] || 0) + 1;
  });
  
  // 团购订单统计
  const groupOrders = db.group_buy_orders || [];
  if (groupOrders.length > 0) {
    const groupRev = groupOrders.reduce((s, o) => s + (o.total_price || 0), 0);
    categoryRevenue['团购'] = (categoryRevenue['团购'] || 0) + groupRev;
    categoryOrders['团购'] = (categoryOrders['团购'] || 0) + groupOrders.length;
  }
  
  res.json({
    contacts, pendingContacts, 
    products, articles, clientProducts, clients, 
    orders: {
      total: validOrders.length,
      totalRevenue,
      categoryRevenue,
      categoryOrders,
      completed: allOrders.filter(o => o.status === 'completed' || o.status === 'paid').length,
      pending: pendingOrders
    },
    pendingOrders,
    pendingOnboardings,
    csConversations: csConversations.size, csUnhandled,
    tmTotal: tmLogs.length,
    tmSuccess: tmSuccess,
    tmFailed: tmFailed,
    tmEnabled: tmEnabled
  });
});

// Products CRUD
router.get('/products', authCheck, (req, res) => {
  const db = getDB();
  res.json((db.products || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)));
});

router.post('/products', authCheck, (req, res) => {
  const db = getDB();
  const item = { id: nextId('products'), ...req.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (item.published === undefined) item.published = 1;
  if (!Array.isArray(item.tags)) item.tags = [];
  if (!Array.isArray(item.highlights)) item.highlights = [];
  if (!Array.isArray(item.cases)) item.cases = [];
  db.products.push(item);
  res.json({ id: item.id, message: '产品创建成功' });
});

router.put('/products/:id', authCheck, (req, res) => {
  const db = getDB();
  const item = (db.products || []).find(r => r.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '不存在' });
  Object.assign(item, req.body, { id: item.id, updated_at: new Date().toISOString() });
  syncRow('products', item);
  res.json({ message: '更新成功' });
});

router.delete('/products/:id', authCheck, (req, res) => {
  const db = getDB();
  deleteRows('products', { id: Number(req.params.id) });
  res.json({ message: '删除成功' });
});

// Client Products CRUD
router.get('/client-products', authCheck, (req, res) => {
  const db = getDB();
  res.json((db.client_products || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

router.post('/client-products', authCheck, (req, res) => {
  const db = getDB();
  const item = { id: nextId('client_products'), ...req.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (item.published === undefined) item.published = 1;
  if (!Array.isArray(item.tags)) item.tags = [];
  db.client_products.push(item);
  res.json({ id: item.id, message: '甲方产品创建成功' });
});

router.put('/client-products/:id', authCheck, (req, res) => {
  const db = getDB();
  const item = (db.client_products || []).find(r => r.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '不存在' });
  Object.assign(item, req.body, { id: item.id, updated_at: new Date().toISOString() });
  syncRow('client_products', item);
  res.json({ message: '更新成功' });
});

router.delete('/client-products/:id', authCheck, (req, res) => {
  const db = getDB();
  deleteRows('client_products', { id: Number(req.params.id) });
  res.json({ message: '删除成功' });
});

// Articles CRUD
router.get('/articles', authCheck, (req, res) => {
  const db = getDB();
  res.json((db.articles || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

router.post('/articles', authCheck, (req, res) => {
  const db = getDB();
  const item = { id: nextId('articles'), ...req.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (item.published === undefined) item.published = 0;
  db.articles.push(item);
  res.json({ id: item.id, message: '文章创建成功' });
});

router.put('/articles/:id', authCheck, (req, res) => {
  const db = getDB();
  const item = (db.articles || []).find(r => r.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '不存在' });
  Object.assign(item, req.body, { id: item.id, updated_at: new Date().toISOString() });
  syncRow('articles', item);
  res.json({ message: '更新成功' });
});

router.delete('/articles/:id', authCheck, (req, res) => {
  const db = getDB();
  deleteRows('articles', { id: Number(req.params.id) });
  res.json({ message: '删除成功' });
});

// POST /api/admin/articles/:id/push - 推送文章到公众号
router.post('/articles/:id/push', authCheck, async (req, res) => {
  const { wechat_account_id } = req.body;
  const db = getDB();
  const article = (db.articles || []).find(a => a.id === Number(req.params.id));
  if (!article) return res.status(404).json({ error: '文章不存在' });
  const account = wechat_account_id
    ? (db.wechat_accounts || []).find(a => a.id === Number(wechat_account_id))
    : (db.wechat_accounts || []).find(a => a.type === 'our');
  const media_id = `draft_${Date.now()}`;
  const history = {
    id: nextId('push_history'),
    article_id: article.id,
    article_title: article.title,
    account_id: account?.id || null,
    account_name: account?.name || '默认',
    media_id,
    status: 'simulated',
    pushed_at: new Date().toISOString()
  };
  if (!db.push_history) db.push_history = [];
  db.push_history.push(history);
  res.json({ media_id, message: '文章已推送到公众号', status: 'simulated' });
});

// GET /api/admin/push-history
router.get('/push-history', authCheck, (req, res) => {
  const db = getDB();
  const { page = 1, limit = 20 } = req.query;
  const history = (db.push_history || []).sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
  const total = history.length;
  const start = (Number(page) - 1) * Number(limit);
  res.json({ total, page: Number(page), limit: Number(limit), data: history.slice(start, start + Number(limit)) });
});

// GET /api/admin/orders - 管理端订单列表（支持多条件筛选）
// 返回数组，兼容 admin 前端直接遍历；同时支持分页参数（page/limit）
router.get('/orders', authCheck, (req, res) => {
  const db = getDB();
  let orders = db.orders || [];
  const { status, search, date_from, date_to, min_amount, max_amount, product_type, openid } = req.query;

  if (status && status !== 'all') {
    orders = orders.filter(o => o.status === status);
  }

  if (search && search.trim()) {
    const kw = search.trim().toLowerCase();
    orders = orders.filter(o =>
      (o.order_no && o.order_no.toLowerCase().includes(kw)) ||
      (o.product_title && o.product_title.toLowerCase().includes(kw)) ||
      (o.buyer_name && o.buyer_name.toLowerCase().includes(kw)) ||
      (o.buyer_phone && o.buyer_phone.includes(kw))
    );
  }

  if (date_from) {
    const fromDate = new Date(date_from + 'T00:00:00');
    orders = orders.filter(o => new Date(o.created_at) >= fromDate);
  }
  if (date_to) {
    const toDate = new Date(date_to + 'T23:59:59');
    orders = orders.filter(o => new Date(o.created_at) <= toDate);
  }

  if (min_amount) {
    orders = orders.filter(o => Number(o.amount) >= Number(min_amount));
  }
  if (max_amount) {
    orders = orders.filter(o => Number(o.amount) <= Number(max_amount));
  }

  if (product_type) {
    orders = orders.filter(o => o.product_type === product_type);
  }

  if (openid) {
    orders = orders.filter(o => o.openid === openid);
  }

  orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // admin 前端直接遍历数组，优先返回完整数组
  // 支持 page + limit 参数时返回分页格式（供外部调用）
  const page = Number(req.query.page) || null;
  const limit = Number(req.query.limit) || null;

  if (page && limit) {
    const total = orders.length;
    const start = (page - 1) * limit;
    const paged = orders.slice(start, start + limit);
    return res.json({ total, page, limit, pages: Math.ceil(total / limit), data: paged });
  }

  res.json(orders);
});

// PUT /api/admin/orders/:id - 更新订单状态（含状态流转校验）
router.put('/orders/:id', authCheck, (req, res) => {
  const db = getDB();
  const order = (db.orders || []).find(o => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const { status, tracking_number, tracking_company, cancel_reason } = req.body;
  
  // 合法状态流转校验
  const VALID_TRANSITIONS = {
    pending: ['paid', 'cancelled'],
    paid: ['shipped', 'refunding', 'cancelled'],
    shipped: ['completed', 'refunding'],
    completed: [],
    cancelled: [],
    refunding: ['refunded', 'paid'],
    refunded: []
  };
  
  if (status) {
    const allowed = VALID_TRANSITIONS[order.status];
    if (!allowed || !allowed.includes(status)) {
      return res.status(400).json({ 
        error: `订单状态不允许从「${order.status}」变更为「${status}」`,
        current_status: order.status,
        allowed_transitions: allowed || []
      });
    }
    order.status = status;
    if (status === 'paid') order.paid_at = new Date().toISOString();
    if (status === 'shipped') { order.shipped_at = new Date().toISOString(); order.tracking_number = tracking_number || ''; order.tracking_company = tracking_company || ''; }
    if (status === 'completed') order.completed_at = new Date().toISOString();
    if (status === 'cancelled') { order.cancelled_at = new Date().toISOString(); order.cancel_reason = cancel_reason || ''; }
    if (status === 'refunded') { order.cancelled_at = new Date().toISOString(); }
  }
  order.updated_at = new Date().toISOString();
  syncRow('orders', order);
  
  // 状态变更通知用户
  const statusText = { pending: '待支付', paid: '已支付', shipped: '已发货', completed: '已完成', cancelled: '已取消', refunding: '退款中', refunded: '已退款' };
  if (status && order.buyer_phone) {
    createNotification({
      type: 'order',
      title: `订单${statusText[status] || '状态更新'}`,
      content: `订单 ${order.order_no} 状态已更新为「${statusText[status] || status}」${status === 'shipped' && tracking_number ? '，物流单号：' + tracking_number : ''}`,
      target_phones: [order.buyer_phone],
      link_type: 'order',
      link_id: String(order.id),
      icon: status === 'completed' ? '✅' : status === 'cancelled' ? '❌' : status === 'shipped' ? '🚚' : '📋'
    });
  }
  
  res.json({ message: '订单更新成功' });
});

// GET /api/admin/clients - 管理端甲方列表
router.get('/clients', authCheck, (req, res) => {
  const db = getDB();
  res.json(db.clients || []);
});

// POST /api/admin/clients
router.post('/clients', authCheck, (req, res) => {
  const db = getDB();
  const item = { id: nextId('clients'), ...req.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (!db.clients) db.clients = [];
  db.clients.push(item);
  res.json({ id: item.id, message: '甲方创建成功' });
});

// PUT /api/admin/clients/:id
router.put('/clients/:id', authCheck, (req, res) => {
  const db = getDB();
  const item = (db.clients || []).find(r => r.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '不存在' });
  Object.assign(item, req.body, { id: item.id, updated_at: new Date().toISOString() });
  syncRow('clients', item);
  res.json({ message: '更新成功' });
});

// DELETE /api/admin/clients/:id
router.delete('/clients/:id', authCheck, (req, res) => {
  const db = getDB();
  deleteRows('clients', { id: Number(req.params.id) });
  res.json({ message: '删除成功' });
});

// ===== Pain Points CRUD =====
router.get('/pain-points', authCheck, (req, res) => {
  const db = getDB();
  res.json((db.pain_points || []).sort((a, b) => a.id - b.id));
});

router.post('/pain-points', authCheck, (req, res) => {
  const db = getDB();
  const item = { id: req.body.id || 'custom_' + Date.now(), ...req.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (item.published === undefined) item.published = 1;
  if (!Array.isArray(item.solutions)) item.solutions = [];
  if (!Array.isArray(item.effects)) item.effects = [];
  if (!db.pain_points) db.pain_points = [];
  db.pain_points.push(item);
  res.json({ id: item.id, message: '痛点创建成功' });
});

router.put('/pain-points/:id', authCheck, (req, res) => {
  const db = getDB();
  const id = req.params.id;
  const item = (db.pain_points || []).find(r => String(r.id) === String(id));
  if (!item) return res.status(404).json({ error: '不存在' });
  Object.assign(item, req.body, { id: item.id, updated_at: new Date().toISOString() });
  syncRow('pain_points', item);
  res.json({ message: '更新成功' });
});

router.delete('/pain-points/:id', authCheck, (req, res) => {
  const db = getDB();
  deleteRows('pain_points', { id: req.params.id });
  res.json({ message: '删除成功' });
});

// ===== Industries CRUD =====
router.get('/industries', authCheck, (req, res) => {
  const db = getDB();
  res.json((db.industries || []).sort((a, b) => a.name.localeCompare(b.name)));
});

router.post('/industries', authCheck, (req, res) => {
  const db = getDB();
  const item = { id: req.body.id || 'ind_' + Date.now(), ...req.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (item.published === undefined) item.published = 1;
  if (!db.industries) db.industries = [];
  db.industries.push(item);
  res.json({ id: item.id, message: '行业创建成功' });
});

router.put('/industries/:id', authCheck, (req, res) => {
  const db = getDB();
  const id = req.params.id;
  const item = (db.industries || []).find(r => String(r.id) === String(id));
  if (!item) return res.status(404).json({ error: '不存在' });
  Object.assign(item, req.body, { id: item.id, updated_at: new Date().toISOString() });
  syncRow('industries', item);
  res.json({ message: '更新成功' });
});

router.delete('/industries/:id', authCheck, (req, res) => {
  const db = getDB();
  deleteRows('industries', { id: req.params.id });
  res.json({ message: '删除成功' });
});

// ==================== 角色与权限管理 ====================

// GET /roles — 角色列表
router.get('/roles', authCheck, (req, res) => {
  const db = getDB();
  const roles = (db.roles || []).map(r => ({
    ...r,
    permissions: typeof r.permissions === 'string' ? JSON.parse(r.permissions || '[]') : (r.permissions || [])
  })).sort((a,b) => (a.sort_order||0) - (b.sort_order||0));
  res.json({ list: roles, total: roles.length });
});

// POST /roles — 创建角色
router.post('/roles', authCheck, (req, res) => {
  const { name, code, description, permissions, sort_order } = req.body;
  if (!name || !code) return res.status(400).json({ error: '缺少角色名称或代码' });
  const id = nextId('roles');
  const role = { id, name, code, description: description||'', permissions: permissions||[], sort_order: sort_order||0, status: 'active', created_at: new Date().toISOString() };
  getDB().roles.push(role);
  res.status(201).json(role);
});

// PUT /roles/:id
router.put('/roles/:id', authCheck, (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const role = (db.roles || []).find(r => r.id === id);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  ['name','code','description','permissions','sort_order','status'].forEach(f => {
    if (req.body[f] !== undefined) role[f] = req.body[f];
  });
  syncRow('roles', role);
  res.json(role);
});

// DELETE /roles/:id
router.delete('/roles/:id', authCheck, (req, res) => {
  const id = Number(req.params.id);
  if (id === 1) return res.status(400).json({ error: '超级管理员角色不可删除' });
  const db = getDB();
  const idx = (db.roles || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '角色不存在' });
  db.roles.splice(idx, 1);
  deleteRows('roles', { id });
  res.json({ success: true });
});

// GET /admins — 管理员列表
router.get('/admins', authCheck, (req, res) => {
  const db = getDB();
  const admins = (db.admins || []).map(a => ({
    id: a.id, username: a.username, display_name: a.display_name || '',
    role_id: a.role_id || 0, role_name: a.role_name || '',
    department: a.department || '', phone: a.phone || '', status: a.status || 'active'
  }));
  res.json({ list: admins, total: admins.length });
});

// POST /admins — 创建管理员
router.post('/admins', authCheck, (req, res) => {
  const { username, password, display_name, role_id, department, phone } = req.body;
  if (!username || !password) return res.status(400).json({ error: '缺少用户名或密码' });
  const db = getDB();
  if ((db.admins || []).find(a => a.username === username)) return res.status(409).json({ error: '用户名已存在' });
  const role = (db.roles || []).find(r => r.id === role_id);
  const id = nextId('admins');
  const admin = {
    id, username, password, display_name: display_name||'',
    role_id: role_id||0, role_name: role ? role.name : '',
    department: department||'', phone: phone||'', status: 'active'
  };
  db.admins.push(admin);
  res.status(201).json({ ...admin, password: undefined });
});

// PUT /admins/:id
router.put('/admins/:id', authCheck, (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const admin = (db.admins || []).find(a => a.id === id);
  if (!admin) return res.status(404).json({ error: '管理员不存在' });
  ['display_name','role_id','department','phone','status'].forEach(f => {
    if (req.body[f] !== undefined) admin[f] = req.body[f];
  });
  if (req.body.role_id) {
    const role = (db.roles || []).find(r => r.id === req.body.role_id);
    if (role) admin.role_name = role.name;
  }
  if (req.body.password) admin.password = req.body.password;
  syncRow('admins', admin);
  res.json({ ...admin, password: undefined });
});

// DELETE /admins/:id
router.delete('/admins/:id', authCheck, (req, res) => {
  const id = Number(req.params.id);
  if (id === 1) return res.status(400).json({ error: '超级管理员不可删除' });
  const db = getDB();
  const idx = (db.admins || []).findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ error: '管理员不存在' });
  db.admins.splice(idx, 1);
  deleteRows('admins', { id });
  res.json({ success: true });
});

module.exports = router;
