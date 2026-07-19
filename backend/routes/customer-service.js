const express = require('express');
const { getDB, getRawDB, nextId, save, syncRow } = require('../models/db');
const { sendTemplateMessage } = require('./template-msg');

const router = express.Router();

// ===== 数据说明 =====
// cs_conversations: { id, openid, nickname, avatar, last_message, last_time, unread_count, status, created_at }
// cs_messages:      { id, conversation_id, openid, content, type(message/text), direction(in/out), is_read, created_at }

// ===== 中间件：简单鉴权（管理后台用） =====
function authCheck(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "未授权" });
  const token = auth.slice(7);
  try {
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

// ===== 小程序端：发送消息（用户 → 客服） =====
// POST /api/customer-service/send
// Body: { openid, nickname, avatar, content }
router.post('/send', (req, res) => {
  const { openid, nickname, avatar, content } = req.body;
  if (!openid || !content) return res.status(400).json({ error: '缺少 openid 或 content' });

  const db = getDB();
  if (!db.cs_conversations) db.cs_conversations = [];
  if (!db.cs_messages) db.cs_messages = [];

  // 查找或创建会话
  let conv = db.cs_conversations.find(c => c.openid === openid);
  const now = new Date().toISOString();
  if (!conv) {
    conv = {
      id: nextId('cs_conversations'),
      openid,
      nickname: nickname || '访客',
      avatar: avatar || '',
      last_message: content,
      last_time: now,
      unread_count: 0,
      status: 'open',
      created_at: now
    };
    db.cs_conversations.push(conv);
  } else {
    conv.last_message = content;
    conv.last_time = now;
    conv.unread_count = (conv.unread_count || 0) + 1;
  }

  // 保存消息
  const msg = {
    id: nextId('cs_messages'),
    conversation_id: conv.id,
    openid,
    content,
    type: 'text',
    direction: 'in',
    is_read: 0,
    created_at: now
  };
  db.cs_messages.push(msg);
  // save() not needed - push auto-writes

  // 异步触发公众号模板消息通知管理员（不阻塞返回）
  setImmediate(async () => {
    try {
      const templateId = process.env.WECHAT_TEMPLATE_ID;
      const adminOpenid = process.env.WECHAT_ADMIN_OPENID;
      const { getDB, nextId, save: saveDB } = require('../models/db');

      if (!templateId || !adminOpenid) {
        // 模拟模式：写入日志
        const db = getDB();
        if (!db.template_msg_logs) db.template_msg_logs = [];
        db.template_msg_logs.unshift({
          id: nextId('template_msg_logs'),
          type: 'cs_message',
          status: 'mock',
          request: { openid, nickname: conv.nickname, content },
          response: { errcode: 0, errmsg: 'mock mode' },
          created_at: new Date().toISOString()
        });
        // saveDB() not needed - unshift auto-writes
        console.log('[客服→模板消息] ℹ️ 未配置，已记录 mock 日志');
        return;
      }

      const displayName = conv.nickname || openid;
      const shortContent = content.length > 80 ? content.slice(0, 80) + '…' : content;

      const msgData = {
        first:    { value: '💬 您收到一条新的客服消息', color: '#2563eb' },
        keyword1: { value: displayName, color: '#333333' },
        keyword2: { value: shortContent, color: '#333333' },
        keyword3: { value: new Date().toLocaleString('zh-CN'), color: '#666666' },
        remark:   { value: '请尽快回复客户消息', color: '#e67e22' }
      };

      const result = await sendTemplateMessage({
        toOpenid: adminOpenid,
        templateId,
        data: msgData,
        url: process.env.WECHAT_TEMPLATE_LEAD_URL || ''
      });

      // 写入日志
      const db = getDB();
      if (!db.template_msg_logs) db.template_msg_logs = [];
      db.template_msg_logs.unshift({
        id: nextId('template_msg_logs'),
        type: 'cs_message',
        status: result.errcode === 0 ? 'success' : 'failed',
        request: { openid, nickname: conv.nickname, content },
        response: result,
        created_at: new Date().toISOString()
      });
      // saveDB() not needed - unshift auto-writes

      console.log('[客服→模板消息]', result.errcode === 0 ? '✅ 已通知管理员' : '❌ 通知失败', result);
    } catch (err) {
      // 写入错误日志
      try {
        const { getDB, nextId, save: saveDB } = require('../models/db');
        const db = getDB();
        if (!db.template_msg_logs) db.template_msg_logs = [];
        db.template_msg_logs.unshift({
          id: nextId('template_msg_logs'),
          type: 'cs_message',
          status: 'error',
          request: { openid, nickname: conv ? conv.nickname : '', content },
          error: err.message,
          created_at: new Date().toISOString()
        });
        // saveDB() not needed - unshift auto-writes
      } catch (e) { /* 忽略 */ }
      console.error('[客服→模板消息] ❌ 异常:', err.message);
    }
  });

  console.log(`[客服] 新消息 from ${openid}: ${content}`);

  res.json({ message: '发送成功', data: { conversation_id: conv.id, message_id: msg.id } });
});

// ===== 小程序端：拉取消息记录 =====
// GET /api/customer-service/messages?openid=xxx&page=1&limit=50
router.get('/messages', (req, res) => {
  const { openid, page = 1, limit = 50 } = req.query;
  if (!openid) return res.status(400).json({ error: '缺少 openid' });

  const db = getDB();
  const messages = (db.cs_messages || [])
    .filter(m => m.openid === openid)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // 标记已读（用户端拉取时，将客服发出的消息标记为已读）
  messages.forEach(m => {
    if (m.direction === 'out') m.is_read = 1;
    syncRow('cs_messages', m);
  });
  // save() not needed - syncRow auto-writes

  const start = (page - 1) * limit;
  const pageMessages = messages.slice(start, start + parseInt(limit));

  res.json({
    data: pageMessages,
    total: messages.length,
    page: parseInt(page),
    limit: parseInt(limit)
  });
});

// ===== 管理后台：会话列表 =====
// GET /api/customer-service/conversations (需鉴权)
router.get('/conversations', authCheck, (req, res) => {
  const db = getDB();
  const conversations = (db.cs_conversations || [])
    .sort((a, b) => new Date(b.last_time) - new Date(a.last_time));
  res.json({ total: conversations.length, data: conversations });
});

// ===== 管理后台：会话详情 + 消息列表 =====
// GET /api/customer-service/conversations/:id (需鉴权)
router.get('/conversations/:id', authCheck, (req, res) => {
  const db = getDB();
  const conv = (db.cs_conversations || []).find(c => c.id === parseInt(req.params.id));
  if (!conv) return res.status(404).json({ error: '会话不存在' });

  const messages = (db.cs_messages || [])
    .filter(m => m.conversation_id === conv.id)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // 标记所有消息为已读
  messages.forEach(m => { m.is_read = 1; syncRow('cs_messages', m); });
  conv.unread_count = 0;
  syncRow('cs_conversations', conv);

  res.json({ data: { conversation: conv, messages } });
});

// ===== 管理后台：回复消息 =====
// POST /api/customer-service/reply (需鉴权)
// Body: { conversation_id, content }
router.post('/reply', authCheck, (req, res) => {
  const { conversation_id, content } = req.body;
  if (!conversation_id || !content) return res.status(400).json({ error: '缺少参数' });

  const db = getDB();
  const conv = (db.cs_conversations || []).find(c => c.id === parseInt(conversation_id));
  if (!conv) return res.status(404).json({ error: '会话不存在' });

  const now = new Date().toISOString();

  // 保存客服消息
  const msg = {
    id: nextId('cs_messages'),
    conversation_id: parseInt(conversation_id),
    openid: conv.openid,
    content,
    type: 'text',
    direction: 'out',
    is_read: 1,
    created_at: now
  };
  if (!db.cs_messages) db.cs_messages = [];
  db.cs_messages.push(msg);

  // 更新会话
  conv.last_message = content;
  conv.last_time = now;
  syncRow('cs_conversations', conv);
  // save() not needed - push + syncRow auto-writes

  console.log(`[客服] 管理员回复 to ${conv.openid}: ${content}`);

  res.json({ message: '回复成功', data: { message_id: msg.id } });
});

// ===== 管理后台：关闭/重启会话 =====
// PUT /api/customer-service/conversations/:id/status
// Body: { status: 'open' | 'closed' }
router.put('/conversations/:id/status', authCheck, (req, res) => {
  const { status } = req.body;
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'status 必须是 open 或 closed' });

  const db = getDB();
  const conv = (db.cs_conversations || []).find(c => c.id === parseInt(req.params.id));
  if (!conv) return res.status(404).json({ error: '会话不存在' });

  conv.status = status;
  syncRow('cs_conversations', conv);

  res.json({ message: `会话已${status === 'closed' ? '关闭' : '重启'}`, data: conv });
});

// ===== 小程序端：新建或获取会话 =====
// POST /api/customer-service/conversation
// Body: { openid, nickname, avatar }
router.post('/conversation', (req, res) => {
  const { openid, nickname, avatar } = req.body;
  if (!openid) return res.status(400).json({ error: '缺少 openid' });

  const db = getDB();
  if (!db.cs_conversations) db.cs_conversations = [];

  let conv = db.cs_conversations.find(c => c.openid === openid);
  if (!conv) {
    conv = {
      id: nextId('cs_conversations'),
      openid,
      nickname: nickname || '访客',
      avatar: avatar || '',
      last_message: '',
      last_time: new Date().toISOString(),
      unread_count: 0,
      status: 'open',
      created_at: new Date().toISOString()
    };
    db.cs_conversations.push(conv);
    // save() not needed - push auto-writes
  }

  res.json({ data: conv });
});

// ===== 获取未读消息数（小程序端用）=====
// GET /api/customer-service/unread?openid=xxx
router.get('/unread', (req, res) => {
  const { openid } = req.query;
  if (!openid) return res.status(400).json({ error: '缺少 openid' });

  const db = getDB();
  const unread = (db.cs_messages || []).filter(m => m.openid === openid && m.direction === 'out' && !m.is_read).length;
  res.json({ unread });
});

/**
 * Admin: 按会话ID查消息
 * GET /api/customer-service/admin/messages?conversation_id=1
 */
router.get('/admin/messages', (req, res) => {
  const { conversation_id, page = 1, limit = 50 } = req.query;
  if (!conversation_id) return res.status(400).json({ error: '缺少 conversation_id' });
  const db = getDB();
  const messages = (db.cs_messages || [])
    .filter(m => m.conversation_id === parseInt(conversation_id))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const start = (page - 1) * limit;
  const pageMessages = messages.slice(start, start + parseInt(limit));
  res.json({ data: pageMessages, total: messages.length, page: parseInt(page), limit: parseInt(limit) });
});

/**
 * Admin: 关闭会话
 * PUT /api/customer-service/admin/close/:id
 */
router.put('/admin/close/:id', (req, res) => {
  const db = getDB();
  const conv = (db.cs_conversations || []).find(c => c.id === parseInt(req.params.id));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  conv.status = 'closed';
  syncRow('cs_conversations', conv);
  res.json({ success: true });
});

module.exports = router;
