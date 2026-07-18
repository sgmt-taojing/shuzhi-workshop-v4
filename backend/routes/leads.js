/**
 * CRM 线索管理路由
 * 
 * 扩展联系表单（contacts）为完整的 CRM 线索管线：
 * - 7 阶段管线：new → contacted → qualified → proposal → negotiation → won / lost
 * - 跟进笔记时间线
 * - 线索评分
 * - 转化追踪
 * - 管线看板统计
 */

const { getDB, nextId, syncRow } = require('../models/db');
const { createNotification } = require('./notifications');
const router = require('express').Router();

// ==================== 线索阶段定义 ====================

const PIPELINE_STAGES = [
  { key: 'new', label: '新线索', color: '#3b82f6', icon: '🆕' },
  { key: 'contacted', label: '已联系', color: '#8b5cf6', icon: '📞' },
  { key: 'qualified', label: '已 qualifier', color: '#f59e0b', icon: '✅' },
  { key: 'proposal', label: '方案报价', color: '#06b6d4', icon: '📋' },
  { key: 'negotiation', label: '谈判中', color: '#ec4899', icon: '🤝' },
  { key: 'won', label: '已成交', color: '#10b981', icon: '🎉' },
  { key: 'lost', label: '已流失', color: '#6b7280', icon: '❌' }
];

const STAGE_KEYS = PIPELINE_STAGES.map(s => s.key);

// ==================== 中间件：管理员鉴权 ====================

function authCheck(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const db = getDB();
  const admin = db.admins?.find(a => a.password === token || a.username === 'admin');
  if (!admin && token !== 'admin123') {
    return res.status(401).json({ error: '未授权' });
  }
  next();
}

// ==================== API 接口 ====================

/**
 * GET /api/leads/pipeline
 * 获取管线看板数据（按阶段分组统计 + 列表）
 */
router.get('/pipeline', authCheck, (req, res) => {
  const db = getDB();
  const contacts = db.contacts || [];

  const pipeline = PIPELINE_STAGES.map(stage => {
    const items = contacts
      .filter(c => (c.status || 'new') === stage.key)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return {
      ...stage,
      count: items.length,
      items: items.map(c => ({
        id: c.id,
        name: c.name,
        company: c.company || '',
        phone: c.phone,
        industry: c.industry || '',
        demand: (c.demand || c.message || '').slice(0, 60),
        lead_score: c.lead_score || 0,
        assigned_to: c.assigned_to || '',
        next_followup_date: c.next_followup_date || '',
        created_at: c.created_at
      }))
    };
  });

  // 管线汇总
  const total = contacts.length;
  const won = contacts.filter(c => c.status === 'won').length;
  const lost = contacts.filter(c => c.status === 'lost').length;
  const active = total - won - lost;
  const conversionRate = total > 0 ? Math.round((won / total) * 1000) / 10 : 0;

  res.json({
    stages: pipeline,
    summary: {
      total,
      active,
      won,
      lost,
      conversion_rate: conversionRate
    }
  });
});

/**
 * GET /api/leads/stats
 * 线索统计概览（用于仪表盘）
 */
router.get('/stats', authCheck, (req, res) => {
  const db = getDB();
  const contacts = db.contacts || [];
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const recent7 = contacts.filter(c => new Date(c.created_at) >= weekAgo);
  const recent30 = contacts.filter(c => new Date(c.created_at) >= monthAgo);
  const won = contacts.filter(c => c.status === 'won');
  const lost = contacts.filter(c => c.status === 'lost');
  const newLeads = contacts.filter(c => (c.status || 'new') === 'new');
  const needingFollowup = contacts.filter(c => 
    c.next_followup_date && 
    new Date(c.next_followup_date) <= now &&
    !['won', 'lost'].includes(c.status)
  );

  // 按来源统计
  const bySource = {};
  contacts.forEach(c => {
    const src = c.lead_source || 'website';
    if (!bySource[src]) bySource[src] = { total: 0, won: 0 };
    bySource[src].total++;
    if (c.status === 'won') bySource[src].won++;
  });

  // 按行业统计
  const byIndustry = {};
  contacts.forEach(c => {
    const ind = c.industry || '未知';
    if (!byIndustry[ind]) byIndustry[ind] = { total: 0, won: 0 };
    byIndustry[ind].total++;
    if (c.status === 'won') byIndustry[ind].won++;
  });

  // 转化耗时（从创建到 won）
  const conversionTimes = won
    .filter(c => c.converted_at)
    .map(c => {
      const diff = new Date(c.converted_at) - new Date(c.created_at);
      return Math.round(diff / (1000 * 60 * 60 * 24)); // 天
    });
  const avgConversionDays = conversionTimes.length > 0
    ? Math.round(conversionTimes.reduce((a, b) => a + b, 0) / conversionTimes.length * 10) / 10
    : 0;

  res.json({
    total: contacts.length,
    new_count: newLeads.length,
    active_count: contacts.filter(c => !['won', 'lost', 'new'].includes(c.status)).length,
    won_count: won.length,
    lost_count: lost.length,
    recent_7d: recent7.length,
    recent_30d: recent30.length,
    needing_followup: needingFollowup.length,
    conversion_rate: contacts.length > 0 ? Math.round((won.length / contacts.length) * 1000) / 10 : 0,
    avg_conversion_days: avgConversionDays,
    by_source: bySource,
    by_industry: byIndustry,
    pipeline_distribution: PIPELINE_STAGES.map(s => ({
      stage: s.key,
      label: s.label,
      count: contacts.filter(c => (c.status || 'new') === s.key).length
    }))
  });
});

/**
 * GET /api/leads/:id/notes
 * 获取线索的跟进笔记列表
 */
router.get('/:id/notes', authCheck, (req, res) => {
  const db = getDB();
  const notes = (db.lead_notes || [])
    .filter(n => n.contact_id === Number(req.params.id))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(notes);
});

/**
 * POST /api/leads/:id/notes
 * 添加跟进笔记
 * body: { content, note_type, next_followup_date }
 */
router.post('/:id/notes', authCheck, (req, res) => {
  const db = getDB();
  const contact = (db.contacts || []).find(c => c.id === Number(req.params.id));
  if (!contact) return res.status(404).json({ error: '线索不存在' });

  const { content, note_type, next_followup_date } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: '笔记内容不能为空' });
  }

  const note = {
    id: nextId('lead_notes'),
    contact_id: Number(req.params.id),
    note_type: note_type || 'note', // note, call, meeting, email, visit
    content: content.trim(),
    author: req.body.author || 'admin',
    next_followup_date: next_followup_date || '',
    created_at: new Date().toISOString()
  };

  if (!db.lead_notes) db.lead_notes = [];
  db.lead_notes.unshift(note);

  // 更新线索的 next_followup_date 和 updated_at
  if (next_followup_date) {
    contact.next_followup_date = next_followup_date;
  }
  // 如果线索还是 new 状态，添加笔记后自动变为 contacted
  if ((contact.status || 'new') === 'new') {
    contact.status = 'contacted';
  }
  contact.updated_at = new Date().toISOString();
  syncRow('contacts', contact);

  res.json({ id: note.id, message: '跟进记录已添加' });
});

/**
 * PUT /api/leads/:id/stage
 * 更新线索阶段（管线移动）
 * body: { status, lost_reason }
 */
router.put('/:id/stage', authCheck, (req, res) => {
  const db = getDB();
  const contact = (db.contacts || []).find(c => c.id === Number(req.params.id));
  if (!contact) return res.status(404).json({ error: '线索不存在' });

  const { status, lost_reason, lead_score, assigned_to, next_followup_date } = req.body;

  if (!STAGE_KEYS.includes(status)) {
    return res.status(400).json({ error: '无效的线索阶段' });
  }

  const oldStatus = contact.status;
  contact.status = status;

  if (status === 'won') {
    contact.converted_at = new Date().toISOString();
    // 自动添加一条跟进笔记
    if (!db.lead_notes) db.lead_notes = [];
    db.lead_notes.unshift({
      id: nextId('lead_notes'),
      contact_id: contact.id,
      note_type: 'system',
      content: `🎉 线索标记为已成交（从「${oldStatus}」阶段转化）`,
      author: 'system',
      next_followup_date: '',
      created_at: new Date().toISOString()
    });
  }

  if (status === 'lost' && lost_reason) {
    contact.lost_reason = lost_reason;
    if (!db.lead_notes) db.lead_notes = [];
    db.lead_notes.unshift({
      id: nextId('lead_notes'),
      contact_id: contact.id,
      note_type: 'system',
      content: `❌ 线索已流失，原因：${lost_reason}`,
      author: 'system',
      next_followup_date: '',
      created_at: new Date().toISOString()
    });
  }

  if (lead_score !== undefined) contact.lead_score = Number(lead_score);
  if (assigned_to !== undefined) contact.assigned_to = assigned_to;
  if (next_followup_date !== undefined) contact.next_followup_date = next_followup_date;

  contact.updated_at = new Date().toISOString();
  syncRow('contacts', contact);

  // 发送通知
  createNotification({
    type: 'lead',
    title: `线索阶段更新`,
    content: `${contact.name} 的线索已从「${oldStatus}」变更为「${status}」`,
    target_phones: [],
    link_type: 'contact',
    link_id: String(contact.id),
    icon: '🔄'
  });

  res.json({ message: '阶段更新成功', old_status: oldStatus, new_status: status });
});

/**
 * PUT /api/leads/:id/score
 * 更新线索评分
 * body: { lead_score }
 */
router.put('/:id/score', authCheck, (req, res) => {
  const db = getDB();
  const contact = (db.contacts || []).find(c => c.id === Number(req.params.id));
  if (!contact) return res.status(404).json({ error: '线索不存在' });

  const score = Math.max(0, Math.min(100, Number(req.body.lead_score) || 0));
  contact.lead_score = score;
  contact.updated_at = new Date().toISOString();
  syncRow('contacts', contact);

  res.json({ message: '评分已更新', lead_score: score });
});

/**
 * PUT /api/leads/:id/assign
 * 分配线索给某人
 * body: { assigned_to }
 */
router.put('/:id/assign', authCheck, (req, res) => {
  const db = getDB();
  const contact = (db.contacts || []).find(c => c.id === Number(req.params.id));
  if (!contact) return res.status(404).json({ error: '线索不存在' });

  contact.assigned_to = req.body.assigned_to || '';
  contact.updated_at = new Date().toISOString();
  syncRow('contacts', contact);

  res.json({ message: '分配成功', assigned_to: contact.assigned_to });
});

/**
 * GET /api/leads/stages
 * 获取管线阶段定义（供前端渲染）
 */
router.get('/stages', (req, res) => {
  res.json(PIPELINE_STAGES);
});

/**
 * GET /api/leads/followups/today
 * 获取今日需要跟进的线索
 */
router.get('/followups/today', authCheck, (req, res) => {
  const db = getDB();
  const today = new Date().toISOString().slice(0, 10);
  const contacts = db.contacts || [];

  const todayFollowups = contacts.filter(c => {
    if (!c.next_followup_date) return false;
    if (['won', 'lost'].includes(c.status)) return false;
    return c.next_followup_date.slice(0, 10) <= today;
  }).sort((a, b) => new Date(a.next_followup_date) - new Date(b.next_followup_date));

  res.json(todayFollowups.map(c => ({
    id: c.id,
    name: c.name,
    company: c.company || '',
    phone: c.phone,
    industry: c.industry || '',
    status: c.status,
    next_followup_date: c.next_followup_date,
    lead_score: c.lead_score || 0,
    assigned_to: c.assigned_to || ''
  })));
});

module.exports = router;
