/**
 * 用户认证与账户管理路由
 * 
 * 提供微信小程序登录、手机号绑定、用户信息管理
 * 
 * 认证流程:
 *   wx.login() → 获取 code → POST /api/auth/login → 返回 token + openid
 *   手机号绑定: POST /api/auth/bind-phone
 *   用户信息: GET /api/auth/me (需要 token)
 */

const { getDB, save, syncRow, deleteRows } = require('../models/db');
const crypto = require('crypto');
const router = require('express').Router();

// ==================== 工具函数 ====================

/**
 * 生成用户 Token（SHA256 哈希）
 */
function generateToken(openid, secret = 'dt-mall-secret') {
  const raw = `${openid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * 生成模拟 openid（真实环境需对接微信 code2Session 接口）
 */
function generateOpenid(code) {
  // 使用 code 的哈希生成稳定 openid（同一 code 始终同一 id）
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  return 'u_' + hash.slice(0, 28);
}

/**
 * 查找或创建用户
 */
function findOrCreateUser(openid) {
  const db = getDB();
  if (!db.users) db.users = [];
  if (!db._nextId.users) db._nextId.users = 1;

  let user = db.users.find(u => u.openid === openid);
  if (!user) {
    user = {
      id: db._nextId.users++,
      openid,
      nickname: '',
      avatar: '',
      phone: '',
      is_admin: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_login: new Date().toISOString()
    };
    db.users.push(user);
    // save() not needed - push auto-writes to SQLite
  } else {
    user.last_login = new Date().toISOString();
    syncRow('users', user);
  }
  return user;
}

// ==================== API 端点 ====================

/**
 * POST /api/auth/login
 * 用户登录（微信 wx.login 模式）
 * Body: { code: "wx_login_code" }
 */
router.post('/login', (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: '缺少 code 参数，请先调用 wx.login()' });
  }

  // 生成 openid（真实环境应调用微信 code2Session 接口）
  let openid;
  try {
    openid = generateOpenid(code);
  } catch (e) {
    // 兜底：随机 openid
    openid = 'u_' + crypto.randomBytes(16).toString('hex');
  }

  // 查找或创建用户
  const user = findOrCreateUser(openid);

  // 生成会话 token
  const token = generateToken(openid);

  // 保存活跃 token
  const db = getDB();
  if (!db.sessions) db.sessions = [];
  deleteRows('sessions', { openid: openid }); // 清旧 token
  db.sessions.push({
    token,
    openid,
    user_id: user.id,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30天
  });

  res.json({
    token,
    openid,
    user: sanitizeUser(user)
  });
});

/**
 * POST /api/auth/bind-phone
 * 绑定手机号（使用 wx.getPhoneNumber 返回的 code）
 * Body: { token, phoneCode }
 * 
 * 注意：真实环境下 phoneCode 需通过微信服务端接口解密获取手机号。
 * 当前为模拟实现，直接接受 phone 参数。
 */
router.post('/bind-phone', (req, res) => {
  const { token, phone } = req.body;

  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }

  // 验证 token
  const db = getDB();
  const session = (db.sessions || []).find(s => s.token === token);
  if (!session) {
    return res.status(401).json({ error: 'Token 无效或已过期，请重新登录' });
  }

  if (!phone || !/^1\d{10}$/.test(phone)) {
    return res.status(400).json({ error: '请输入有效的手机号' });
  }

  // 检查手机号是否已被其他用户绑定
  const existingUser = (db.users || []).find(u => u.phone === phone && u.openid !== session.openid);
  if (existingUser) {
    return res.status(400).json({ error: '该手机号已绑定其他账号' });
  }

  const user = (db.users || []).find(u => u.openid === session.openid);
  if (user) {
    user.phone = phone;
    user.updated_at = new Date().toISOString();
    syncRow('users', user);
    res.json({ message: '手机号绑定成功', user: sanitizeUser(user) });
  } else {
    res.status(404).json({ error: '用户不存在' });
  }
});

/**
 * POST /api/auth/update-profile
 * 更新用户信息（昵称、头像）
 * Body: { token, nickname, avatar }
 */
router.post('/update-profile', (req, res) => {
  const { token, nickname, avatar } = req.body;

  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }

  const db = getDB();
  const session = (db.sessions || []).find(s => s.token === token);
  if (!session) {
    return res.status(401).json({ error: 'Token 无效或已过期' });
  }

  const user = (db.users || []).find(u => u.openid === session.openid);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  if (nickname !== undefined) user.nickname = nickname;
  if (avatar !== undefined) user.avatar = avatar;
  user.updated_at = new Date().toISOString();
  syncRow('users', user);

  res.json({ message: '更新成功', user: sanitizeUser(user) });
});

/**
 * GET /api/auth/me?token=xxx
 * 获取当前用户信息
 */
router.get('/me', (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }

  const db = getDB();
  const session = (db.sessions || []).find(s => s.token === token);
  if (!session) {
    return res.status(401).json({ error: 'Token 无效或已过期' });
  }

  const user = (db.users || []).find(u => u.openid === session.openid);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  res.json({ user: sanitizeUser(user) });
});

/**
 * POST /api/auth/logout
 * 退出登录（销毁 token）
 */
router.post('/logout', (req, res) => {
  const token = req.body.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.json({ message: '已退出' });
  }

  const db = getDB();
  deleteRows('sessions', { token: token });

  res.json({ message: '已退出登录' });
});

// ==================== 管理端接口 ====================

/**
 * GET /api/auth/admin/users?token=xxx&page=1&limit=20
 * 管理端查看用户列表（需 admin 权限）
 * 接受 admin panel token (admin123) 或用户 token
 */
router.get('/admin/users', (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录' });

  const db = getDB();

  // 兼容 admin panel 的固定 token
  if (token === 'admin123') {
    let users = (db.users || []).map(sanitizeUser);
    users.sort((a, b) => new Date(b.last_login || b.created_at) - new Date(a.last_login || a.created_at));
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const total = users.length;
    const paged = users.slice((page - 1) * limit, page * limit);
    return res.json({ list: paged, total, page, limit });
  }

  const session = (db.sessions || []).find(s => s.token === token);
  if (!session) return res.status(401).json({ error: 'Token 无效' });

  const adminUser = (db.users || []).find(u => u.openid === session.openid);
  if (!adminUser?.is_admin) return res.status(403).json({ error: '权限不足' });

  let users = (db.users || []).map(sanitizeUser);
  users.sort((a, b) => new Date(b.last_login || b.created_at) - new Date(a.last_login || a.created_at));

  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const total = users.length;
  const paged = users.slice((page - 1) * limit, page * limit);

  res.json({ list: paged, total, page, limit });
});

/**
 * PUT /api/auth/admin/users/:id
 * 管理端更新用户状态（禁用/启用）
 * 需要 admin 权限
 */
router.put('/admin/users/:id', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
  if (!token) return res.status(401).json({ error: '未登录' });

  const db = getDB();

  // 兼容 admin panel 的固定 token
  if (token !== 'admin123') {
    const session = (db.sessions || []).find(s => s.token === token);
    if (!session) return res.status(401).json({ error: 'Token 无效' });
    const adminUser = (db.users || []).find(u => u.openid === session.openid);
    if (!adminUser?.is_admin) return res.status(403).json({ error: '权限不足' });
  }

  const userId = Number(req.params.id);
  const user = (db.users || []).find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 只允许更新受限字段
  const { disabled, nickname, avatar } = req.body;
  if (disabled !== undefined) user.disabled = !!disabled;
  if (nickname !== undefined) user.nickname = nickname;
  if (avatar !== undefined) user.avatar = avatar;
  user.updated_at = new Date().toISOString();
  syncRow('users', user);

  res.json({ message: '用户更新成功', user: sanitizeUser(user) });
});

// ==================== 兼容旧路由 ====================

/**
 * 向下兼容：旧版 POST /api/auth/openid
 */
router.post('/openid', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '缺少 code' });
  
  // 使用旧版逻辑生成 mock openid 保持兼容
  const openid = 'mock_' + require('uuid').v4().replace(/-/g, '').slice(0, 16);
  res.json({ openid });
});

// ==================== 辅助函数 ====================

/**
 * 脱敏用户信息（隐藏部分手机号、排除敏感字段）
 */
function sanitizeUser(user) {
  if (!user) return null;
  const phone = user.phone || '';
  const maskedPhone = phone.length >= 11
    ? phone.slice(0, 3) + '****' + phone.slice(7)
    : phone;

  return {
    id: user.id,
    openid: user.openid,
    nickname: user.nickname || '',
    avatar: user.avatar || '',
    phone: maskedPhone,
    phone_bound: !!user.phone,
    is_admin: !!user.is_admin,
    disabled: !!user.disabled,
    created_at: user.created_at,
    last_login: user.last_login
  };
}

// 导出 sanitizeUser 供其他路由使用
module.exports = router;
module.exports.sanitizeUser = sanitizeUser;
