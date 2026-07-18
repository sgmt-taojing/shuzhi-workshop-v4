const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();
const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// POST /register — H5用户注册
router.post('/register', (req, res) => {
  const { phone, password, nickname, user_type, employee_name, department } = req.body;
  if (!phone || !password) return res.status(400).json({ error: '请填写手机号和密码' });
  
  const db = getDB();
  const exist = (db.h5_users || []).find(u => u.phone === phone);
  if (exist) return res.status(409).json({ error: '该手机号已注册' });
  
  const id = nextId('h5_users');
  const now = new Date().toISOString();
  const user = {
    id, phone, password, nickname: nickname || phone.slice(-4),
    user_type: user_type || 'public', client_id: 0, agent_id: 0,
    employee_name: employee_name || '', department: department || '',
    role_id: 0, role_name: '', permissions: JSON.stringify([]),
    status: 'pending', created_at: now, updated_at: now
  };
  db.h5_users.push(user);
  res.status(201).json({ id, phone, nickname: user.nickname, user_type: user.user_type, status: user.status, message: '注册成功，请等待管理员审核' });
});

// POST /login — H5用户登录
router.post('/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: '请填写手机号和密码' });
  
  const db = getDB();
  const user = (db.h5_users || []).find(u => u.phone === phone && u.password === password);
  if (!user) return res.status(401).json({ error: '手机号或密码错误' });
  if (user.status === 'disabled') return res.status(403).json({ error: '账号已禁用' });
  if (user.status === 'pending') return res.status(403).json({ error: '账号待审核，请联系管理员' });
  
  const token = generateToken();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const perms = typeof user.permissions === 'string' ? JSON.parse(user.permissions || '[]') : (user.permissions || []);
  
  const sessionId = nextId('h5_sessions');
  db.h5_sessions.push({
    id: sessionId, token, user_id: user.id, phone: user.phone,
    user_type: user.user_type, role_id: user.role_id || 0,
    permissions: JSON.stringify(perms), created_at: now, expires_at: expires
  });
  // Clean old sessions
  db.h5_sessions = (db.h5_sessions || []).filter(s => s.user_id !== user.id || s.id === sessionId);
  
  res.json({
    token, user_id: user.id, phone: user.phone, nickname: user.nickname,
    user_type: user.user_type, role_id: user.role_id || 0, role_name: user.role_name || '',
    permissions: perms
  });
});

// POST /logout
router.post('/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const db = getDB();
    const idx = (db.h5_sessions || []).findIndex(s => s.token === token);
    if (idx !== -1) db.h5_sessions.splice(idx, 1);
  }
  res.json({ success: true });
});

// GET /me — 当前H5用户信息
router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
  const token = auth.slice(7);
  const db = getDB();
  const session = (db.h5_sessions || []).find(s => s.token === token);
  if (!session) return res.status(401).json({ error: '登录已过期' });
  if (new Date(session.expires_at) < new Date()) return res.status(401).json({ error: '登录已过期' });
  
  const user = (db.h5_users || []).find(u => u.id === session.user_id);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  
  res.json({
    id: user.id, phone: user.phone, nickname: user.nickname,
    user_type: user.user_type, role_id: user.role_id, role_name: user.role_name,
    permissions: typeof session.permissions === 'string' ? JSON.parse(session.permissions || '[]') : (session.permissions || [])
  });
});

// --- Admin endpoints for managing H5 users ---

// GET /list — H5用户列表（管理员）
router.get('/list', (req, res) => {
  const db = getDB();
  let rows = (db.h5_users || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const status = req.query.status;
  if (status) rows = rows.filter(r => r.status === status);
  res.json({ list: rows.map(u => ({...u, password: undefined})), total: rows.length });
});

// PUT /:id — 更新H5用户（管理员审核/分配角色）
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const user = (db.h5_users || []).find(u => u.id === id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  
  ['nickname','user_type','employee_name','department','role_id','role_name','status','client_id','agent_id'].forEach(f => {
    if (req.body[f] !== undefined) user[f] = req.body[f];
  });
  if (req.body.permissions) user.permissions = req.body.permissions;
  if (req.body.password) user.password = req.body.password;
  user.updated_at = new Date().toISOString();
  syncRow('h5_users', user);
  res.json({ ...user, password: undefined });
});

// DELETE /:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.h5_users || []).findIndex(u => u.id === id);
  if (idx === -1) return res.status(404).json({ error: '用户不存在' });
  db.h5_users.splice(idx, 1);
  deleteRows('h5_users', { id });
  res.json({ success: true });
});

module.exports = router;
