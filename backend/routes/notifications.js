const { getDB, nextId, save, syncRow, deleteRows } = require('../models/db');
const router = require('express').Router();

/**
 * 通知类型：
 *  system    - 系统公告
 *  order     - 订单状态变更
 *  onboarding - 入驻审核结果
 *  product   - 产品更新/上架
 *  activity  - 活动推广
 */

// 获取通知统计（必须放在 /:id 路由之前）
router.get('/stats', (req, res) => {
  const db = getDB();
  if (!db.notifications) db.notifications = [];
  const all = db.notifications;
  const byType = {};
  all.forEach(n => { byType[n.type] = (byType[n.type] || 0) + 1; });
  res.json({
    total: all.length,
    byType,
    recent: all.filter(n => {
      const d = new Date(n.created_at);
      const now = new Date();
      return (now - d) < 7 * 24 * 60 * 60 * 1000;
    }).length
  });
});

// 获取通知列表（支持按用户手机号筛选）
router.get('/', (req, res) => {
  const db = getDB();
  if (!db.notifications) {
    db.notifications = [];
  }
  let list = db.notifications;
  const { phone, type, unread_only } = req.query;
  if (phone) {
    list = list.filter(n => !n.target_phones || n.target_phones.length === 0 || n.target_phones.includes(phone));
  }
  if (type) {
    list = list.filter(n => n.type === type);
  }
  if (unread_only === '1' && phone) {
    const readSet = getReadSet(db, phone);
    list = list.filter(n => !readSet.has(n.id));
  }
  // 按时间倒序
  list = list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  // 注入已读状态
  if (phone) {
    const readSet2 = getReadSet(db, phone);
    list = list.map(n => ({ ...n, _isRead: readSet2.has(n.id) }));
  }
  res.json(list);
});

// 获取未读数量
router.get('/unread-count', (req, res) => {
  const db = getDB();
  if (!db.notifications) db.notifications = [];
  const { phone } = req.query;
  if (!phone) return res.json({ count: 0 });
  const readSet = getReadSet(db, phone);
  const count = db.notifications.filter(n => {
    if (n.target_phones && n.target_phones.length > 0 && !n.target_phones.includes(phone)) return false;
    return !readSet.has(n.id);
  }).length;
  res.json({ count });
});

// 标记单条已读
router.post('/:id/read', (req, res) => {
  const db = getDB();
  const { id } = req.params;
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: '缺少phone' });
  if (!db.notification_reads) db.notification_reads = {};
  if (!db.notification_reads[phone]) db.notification_reads[phone] = [];
  if (!db.notification_reads[phone].includes(Number(id))) {
    db.notification_reads[phone].push(Number(id));
    // notification_reads is a key-value structure handled by getDB() Proxy
  }
  res.json({ ok: true });
});

// 标记全部已读
router.post('/read-all', (req, res) => {
  const db = getDB();
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: '缺少phone' });
  if (!db.notifications) db.notifications = [];
  if (!db.notification_reads) db.notification_reads = {};
  if (!db.notification_reads[phone]) db.notification_reads[phone] = [];
  const readArr = db.notification_reads[phone];
  db.notifications.forEach(n => {
    if (!readArr.includes(n.id)) readArr.push(n.id);
  });
  // notification_reads is a key-value structure handled by getDB() Proxy
  res.json({ ok: true });
});

// 创建通知（管理端/系统内部调用）
router.post('/', (req, res) => {
  const db = getDB();
  if (!db.notifications) db.notifications = [];
  if (!db._nextId.notifications) db._nextId.notifications = 1;
  const { type, title, content, target_phones, link_type, link_id, icon } = req.body;
  if (!title || !content) return res.status(400).json({ error: '缺少title或content' });
  const notification = {
    id: nextId('notifications'),
    type: type || 'system',
    title,
    content,
    target_phones: target_phones || [], // 空=全员
    link_type: link_type || '', // order / product / onboarding / article
    link_id: link_id || '',
    icon: icon || '',
    created_at: new Date().toISOString()
  };
  db.notifications.push(notification);
  // save() not needed - push auto-writes
  res.json(notification);
});

// 删除通知（管理端）
router.delete('/:id', (req, res) => {
  const db = getDB();
  if (!db.notifications) return res.status(404).json({ error: '通知不存在' });
  const idx = db.notifications.findIndex(n => n.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: '通知不存在' });
  db.notifications.splice(idx, 1);
  // splice auto-writes to SQLite
  res.json({ ok: true });
});

// 内部辅助：创建通知（供其他路由调用）
function createNotification({ type, title, content, target_phones, link_type, link_id, icon }) {
  const db = getDB();
  if (!db.notifications) db.notifications = [];
  if (!db._nextId.notifications) db._nextId.notifications = 1;
  const notification = {
    id: nextId('notifications'),
    type: type || 'system',
    title,
    content,
    target_phones: target_phones || [],
    link_type: link_type || '',
    link_id: link_id || '',
    icon: icon || '',
    created_at: new Date().toISOString()
  };
  db.notifications.push(notification);
  // save() not needed - push auto-writes
  return notification;
}

function getReadSet(db, phone) {
  if (!db.notification_reads || !db.notification_reads[phone]) return new Set();
  return new Set(db.notification_reads[phone]);
}

module.exports = router;
module.exports.createNotification = createNotification;
