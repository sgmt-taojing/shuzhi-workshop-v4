/**
 * 售后工单系统 API
 *
 * B2B 售后工单管理系统，支持：
 * - 用户端：提交工单、查看工单列表、查看详情、回复工单、评价、关闭
 * - 管理端：工单列表、分配处理人、回复、更改状态/优先级、统计
 *
 * 工单类型：bug / feature / question / complaint / other
 * 优先级：low / medium / high / urgent
 * 状态流转：open → in_progress → resolved → closed，resolved 可 reopened
 */

const { getDB, nextId, save, syncRow } = require('../models/db');
const { createNotification } = require('./notifications');
const { log: auditLog } = require('../middleware/audit');
const router = require('express').Router();

// ==================== 工具函数 ====================

function isValidPhone(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone));
}

function generateTicketNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `TK${ymd}${rand}`;
}

const CATEGORY_LABELS = {
  bug: '缺陷报告', feature: '需求变更', question: '使用咨询',
  complaint: '投诉', other: '其他'
};
const PRIORITY_LABELS = { low: '低', medium: '中', high: '高', urgent: '紧急' };
const STATUS_LABELS = {
  open: '待处理', in_progress: '处理中', resolved: '已解决',
  closed: '已关闭', reopened: '已重开'
};

function safeParse(str, fallback) {
  try { return JSON.parse(str) || fallback; } catch { return fallback; }
}

function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ==================== 管理端接口（必须放在 /:id 之前）====================

/**
 * GET /api/tickets/admin/list
 * 管理端工单列表
 */
router.get('/admin/list', (req, res) => {
  const { status, priority, category, keyword, page = 1, pageSize = 10 } = req.query;
  const db = getDB();
  let list = [...(db.tickets || [])];

  if (status && status !== 'all') list = list.filter(t => t.status === status);
  if (priority && priority !== 'all') list = list.filter(t => t.priority === priority);
  if (category && category !== 'all') list = list.filter(t => t.category === category);
  if (keyword) {
    const kw = keyword.toLowerCase();
    list = list.filter(t =>
      (t.title || '').toLowerCase().includes(kw) ||
      (t.description || '').toLowerCase().includes(kw) ||
      (t.ticket_no || '').toLowerCase().includes(kw) ||
      (t.applicant_name || '').toLowerCase().includes(kw) ||
      (t.applicant_phone || '').includes(kw) ||
      (t.product_title || '').toLowerCase().includes(kw)
    );
  }

  const priOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
  list.sort((a, b) => {
    const po = (priOrder[a.priority] ?? 4) - (priOrder[b.priority] ?? 4);
    if (po !== 0) return po;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });

  const total = list.length;
  const pageNum = Math.max(1, parseInt(page));
  const size = Math.min(50, Math.max(1, parseInt(pageSize)));
  const pageList = list.slice((pageNum - 1) * size, pageNum * size);

  pageList.forEach(t => {
    t.attachments = safeParse(t.attachments, []);
    t.reply_count = (db.ticket_replies || []).filter(r => r.ticket_id === t.id).length;
  });

  const all = db.tickets || [];
  const stats = {
    total: all.length,
    open: all.filter(t => t.status === 'open').length,
    in_progress: all.filter(t => t.status === 'in_progress').length,
    resolved: all.filter(t => t.status === 'resolved').length,
    closed: all.filter(t => t.status === 'closed').length,
    reopened: all.filter(t => t.status === 'reopened').length,
    urgent: all.filter(t => t.priority === 'urgent' && t.status !== 'closed').length,
    avg_satisfaction: (() => {
      const rated = all.filter(t => t.satisfaction > 0);
      return rated.length > 0 ? Math.round(rated.reduce((s, t) => s + t.satisfaction, 0) / rated.length * 10) / 10 : 0;
    })()
  };

  res.json({ code: 0, data: { list: pageList, total, page: pageNum, pageSize: size, stats } });
});

/**
 * GET /api/tickets/admin/stats
 * 管理端工单统计
 */
router.get('/admin/stats', (req, res) => {
  const db = getDB();
  const all = db.tickets || [];
  const replies = db.ticket_replies || [];

  const byStatus = {};
  ['open', 'in_progress', 'resolved', 'closed', 'reopened'].forEach(s => {
    byStatus[s] = all.filter(t => t.status === s).length;
  });

  const byPriority = {};
  ['urgent', 'high', 'medium', 'low'].forEach(p => {
    byPriority[p] = all.filter(t => t.priority === p && t.status !== 'closed').length;
  });

  const byCategory = {};
  ['bug', 'feature', 'question', 'complaint', 'other'].forEach(c => {
    byCategory[c] = all.filter(t => t.category === c).length;
  });

  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const created = all.filter(t => (t.created_at || '').slice(0, 10) === dateStr).length;
    const resolved = all.filter(t => t.status === 'resolved' || t.status === 'closed')
      .filter(t => (t.resolved_at || '').slice(0, 10) === dateStr).length;
    trend.push({ date: dateStr, created, resolved });
  }

  const rated = all.filter(t => t.satisfaction > 0);
  const avgSatisfaction = rated.length > 0
    ? Math.round(rated.reduce((s, t) => s + t.satisfaction, 0) / rated.length * 10) / 10 : 0;

  const totalReplies = replies.filter(r => r.replier_role === 'admin').length;

  let avgResponseHours = 0;
  let validCount = 0;
  all.forEach(t => {
    if (t.status === 'open' || !t.created_at) return;
    const firstAdminReply = replies
      .filter(r => r.ticket_id === t.id && r.replier_role === 'admin')
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))[0];
    if (firstAdminReply && firstAdminReply.created_at) {
      const diff = (new Date(firstAdminReply.created_at) - new Date(t.created_at)) / 3600000;
      if (diff >= 0) { avgResponseHours += diff; validCount++; }
    }
  });
  if (validCount > 0) avgResponseHours = avgResponseHours / validCount;

  res.json({
    code: 0,
    data: {
      byStatus, byPriority, byCategory, trend,
      avgSatisfaction, totalReplies,
      avgResponseHours: Math.round(avgResponseHours * 10) / 10,
      total: all.length
    }
  });
});

/**
 * GET /api/tickets/admin/:id
 * 管理端获取工单详情（含所有回复，含内部备注）
 */
router.get('/admin/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的工单ID' });

  const db = getDB();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: '工单不存在' });

  const ticketData = { ...ticket, attachments: safeParse(ticket.attachments, []) };
  const replies = (db.ticket_replies || [])
    .filter(r => r.ticket_id === id)
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  replies.forEach(r => { r.attachments = safeParse(r.attachments, []); });

  res.json({ code: 0, data: { ticket: ticketData, replies } });
});

/**
 * PUT /api/tickets/admin/:id
 * 管理端更新工单（状态、优先级、处理人）
 */
router.put('/admin/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { status, priority, assignee, resolution } = req.body;
  const db = getDB();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: '工单不存在' });

  const oldStatus = ticket.status;
  if (status && status !== ticket.status) {
    ticket.status = status;
    if (status === 'resolved') {
      ticket.resolved_at = nowStr();
      ticket.resolved_by = req.admin?.username || 'admin';
    } else if (status === 'closed') {
      ticket.closed_at = nowStr();
    }
  }
  if (priority) ticket.priority = priority;
  if (assignee !== undefined) ticket.assignee = assignee;
  if (resolution !== undefined) ticket.resolution = resolution;
  ticket.updated_at = nowStr();
  syncRow('tickets', ticket);

  // 状态变更通知用户
  if (status && status !== oldStatus) {
    try {
      createNotification({
        title: `工单状态更新: ${ticket.title.slice(0, 30)}`,
        content: `您的工单 ${ticket.ticket_no} 状态已变更为「${STATUS_LABELS[status] || status}」`,
        type: 'ticket',
        target_phones: [ticket.applicant_phone],
        target_role: 'user'
      });
    } catch (e) {}
  }

  const result = { ...ticket, attachments: safeParse(ticket.attachments, []) };
  res.json({ code: 0, data: result, message: '工单已更新' });
});

/**
 * POST /api/tickets/admin/:id/reply
 * 管理员回复工单
 */
router.post('/admin/:id/reply', (req, res) => {
  const id = parseInt(req.params.id);
  const { content, attachments, is_internal } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '回复内容不能为空' });

  const db = getDB();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: '工单不存在' });

  if (!db.ticket_replies) db.ticket_replies = [];
  const replyId = nextId('ticket_replies');
  const adminName = req.admin?.username || '管理员';
  const reply = {
    id: replyId, ticket_id: id,
    replier_name: adminName, replier_role: 'admin',
    content: content.trim(),
    attachments: JSON.stringify(attachments || []),
    is_internal: is_internal ? 1 : 0,
    created_at: nowStr()
  };
  db.ticket_replies.push(reply);
  syncRow('ticket_replies', reply);

  // 公开回复且工单为 open 时自动变为 in_progress
  if (!is_internal && ticket.status === 'open') {
    ticket.status = 'in_progress';
    ticket.assignee = adminName;
  }
  ticket.updated_at = nowStr();
  syncRow('tickets', ticket);

  // 通知用户（非内部备注）
  if (!is_internal) {
    try {
      createNotification({
        title: `工单有新回复: ${ticket.title.slice(0, 30)}`,
        content: `${adminName}: ${content.trim().slice(0, 100)}`,
        type: 'ticket',
        target_phones: [ticket.applicant_phone],
        target_role: 'user'
      });
    } catch (e) {}
  }

  reply.attachments = safeParse(reply.attachments, []);
  res.json({ code: 0, data: reply, message: '回复成功' });
});

// ==================== 用户端接口 ====================

/**
 * GET /api/tickets
 * 用户查看自己的工单列表
 */
router.get('/', (req, res) => {
  const { phone, status, page = 1, pageSize = 10 } = req.query;
  if (!phone) return res.status(400).json({ error: '缺少 phone 参数' });

  const db = getDB();
  let list = (db.tickets || []).filter(t => t.applicant_phone === phone);

  if (status && status !== 'all') {
    list = list.filter(t => t.status === status);
  }

  list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = list.length;
  const pageNum = Math.max(1, parseInt(page));
  const size = Math.min(50, Math.max(1, parseInt(pageSize)));
  const pageList = list.slice((pageNum - 1) * size, pageNum * size);

  pageList.forEach(t => {
    t.attachments = safeParse(t.attachments, []);
    t.reply_count = (db.ticket_replies || []).filter(r => r.ticket_id === t.id && !r.is_internal).length;
  });

  res.json({ code: 0, data: { list: pageList, total, page: pageNum, pageSize: size } });
});

/**
 * GET /api/tickets/:id
 * 获取工单详情（含公开回复）
 */
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的工单ID' });

  const db = getDB();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: '工单不存在' });

  const ticketData = { ...ticket, attachments: safeParse(ticket.attachments, []) };
  const replies = (db.ticket_replies || [])
    .filter(r => r.ticket_id === id && !r.is_internal)
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  replies.forEach(r => { r.attachments = safeParse(r.attachments, []); });

  res.json({ code: 0, data: { ticket: ticketData, replies } });
});

/**
 * POST /api/tickets
 * 提交新工单
 */
router.post('/', (req, res) => {
  const { order_id, order_no, applicant_name, applicant_phone, applicant_openid,
    title, description, category, priority, product_title, attachments } = req.body;

  if (!applicant_phone) return res.status(400).json({ error: '缺少联系电话' });
  if (!isValidPhone(applicant_phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (!title || !title.trim()) return res.status(400).json({ error: '请填写工单标题' });
  if (!description || !description.trim()) return res.status(400).json({ error: '请描述具体问题' });

  const db = getDB();
  if (!db.tickets) db.tickets = [];

  const id = nextId('tickets');
  const ticketNo = generateTicketNo();
  const now = nowStr();

  const ticket = {
    id, ticket_no: ticketNo,
    order_id: order_id || 0, order_no: order_no || '',
    applicant_name: applicant_name || '', applicant_phone, applicant_openid: applicant_openid || '',
    title: title.trim(), description: description.trim(),
    category: category || 'question', priority: priority || 'medium',
    product_title: product_title || '',
    attachments: JSON.stringify(attachments || []),
    status: 'open', assignee: '',
    resolution: '', resolved_at: '', resolved_by: '',
    closed_at: '',
    satisfaction: 0, satisfaction_comment: '',
    created_at: now, updated_at: now
  };

  db.tickets.push(ticket);
  syncRow('tickets', ticket);

  try {
    createNotification({
      title: `新工单: ${title.trim().slice(0, 30)}`,
      content: `${CATEGORY_LABELS[category] || '工单'} - ${PRIORITY_LABELS[priority] || '中'}优先级\n${description.trim().slice(0, 100)}`,
      type: 'ticket',
      target_phones: [],
      target_role: 'admin'
    });
  } catch (e) { console.warn('通知发送失败:', e.message); }

  ticket.attachments = safeParse(ticket.attachments, []);
  res.json({ code: 0, data: ticket, message: '工单提交成功' });
});

/**
 * POST /api/tickets/:id/reply
 * 用户回复工单
 */
router.post('/:id/reply', (req, res) => {
  const id = parseInt(req.params.id);
  const { content, replier_name, attachments } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '回复内容不能为空' });

  const db = getDB();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: '工单不存在' });
  if (ticket.status === 'closed') return res.status(400).json({ error: '工单已关闭，无法回复' });

  if (!db.ticket_replies) db.ticket_replies = [];
  const replyId = nextId('ticket_replies');
  const reply = {
    id: replyId, ticket_id: id,
    replier_name: replier_name || ticket.applicant_name || '用户',
    replier_role: 'user',
    content: content.trim(),
    attachments: JSON.stringify(attachments || []),
    is_internal: 0,
    created_at: nowStr()
  };
  db.ticket_replies.push(reply);
  syncRow('ticket_replies', reply);

  if (ticket.status === 'resolved') {
    ticket.status = 'reopened';
  }
  ticket.updated_at = nowStr();
  syncRow('tickets', ticket);

  try {
    createNotification({
      title: `工单有新回复: ${ticket.title.slice(0, 30)}`,
      content: `${replier_name || '用户'}: ${content.trim().slice(0, 100)}`,
      type: 'ticket',
      target_phones: [],
      target_role: 'admin'
    });
  } catch (e) {}

  reply.attachments = safeParse(reply.attachments, []);
  res.json({ code: 0, data: reply, message: '回复成功' });
});

/**
 * POST /api/tickets/:id/close
 * 用户关闭工单
 */
router.post('/:id/close', (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDB();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: '工单不存在' });

  ticket.status = 'closed';
  ticket.closed_at = nowStr();
  ticket.updated_at = nowStr();
  syncRow('tickets', ticket);

  res.json({ code: 0, message: '工单已关闭' });
});

/**
 * POST /api/tickets/:id/evaluate
 * 用户评价工单
 */
router.post('/:id/evaluate', (req, res) => {
  const id = parseInt(req.params.id);
  const { satisfaction, satisfaction_comment } = req.body;
  if (!satisfaction || satisfaction < 1 || satisfaction > 5) {
    return res.status(400).json({ error: '满意度评分为 1-5 分' });
  }

  const db = getDB();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: '工单不存在' });
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    return res.status(400).json({ error: '只有已解决或已关闭的工单才能评价' });
  }

  ticket.satisfaction = satisfaction;
  ticket.satisfaction_comment = satisfaction_comment || '';
  ticket.updated_at = nowStr();
  syncRow('tickets', ticket);

  res.json({ code: 0, message: '评价成功' });
});

module.exports = router;
