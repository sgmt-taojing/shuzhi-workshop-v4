const { getDB, syncRow, nextId, insertRow, deleteRows, updateRow, getRawDB } = require('../models/db');
const router = require('express').Router();

// ==================== 工具函数 ====================

const LEVEL_MAP = {
  national: '国家',
  shandong: '山东',
  ningxia: '宁夏'
};

const CATEGORY_MAP = {
  digital: '数字化转型',
  tax: '财税',
  industry: '产业',
  talent: '人才',
  other: '其他'
};

// ==================== GET /api/policies — 政策列表 ====================
router.get('/', (req, res) => {
  const db = getDB();
  let rows = (db.policies || []).filter(r => r.published);

  // 按层级筛选
  const level = req.query.level;
  if (level && level !== 'all') {
    rows = rows.filter(r => r.level === level);
  }

  // 按类型筛选
  const category = req.query.category;
  if (category && category !== 'all') {
    rows = rows.filter(r => r.category === category);
  }

  // 按发文机构筛选
  const authority = req.query.authority;
  if (authority) {
    rows = rows.filter(r => r.issuing_authority && r.issuing_authority.includes(authority));
  }

  // 日期范围筛选
  const startDate = req.query.startDate;
  const endDate = req.query.endDate;
  if (startDate) {
    rows = rows.filter(r => r.publish_date && r.publish_date >= startDate);
  }
  if (endDate) {
    rows = rows.filter(r => r.publish_date && r.publish_date <= endDate);
  }

  // 排序：默认按发布日期倒序
  const sort = req.query.sort || 'date';
  if (sort === 'views') {
    rows.sort((a, b) => (b.views || 0) - (a.views || 0));
  } else {
    rows.sort((a, b) => {
      const da = a.publish_date || a.created_at || '';
      const db_ = b.publish_date || b.created_at || '';
      return db_.localeCompare(da);
    });
  }

  // 分页
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const start = (page - 1) * limit;
  const list = rows.slice(start, start + limit).map(r => ({
    ...r,
    level_label: LEVEL_MAP[r.level] || r.level_label || '',
    category_label: CATEGORY_MAP[r.category] || r.category_label || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));

  res.json({
    list,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  });
});

// ==================== GET /api/policies/stats — 统计信息 ====================
router.get('/stats', (req, res) => {
  const db = getDB();
  const all = db.policies || [];
  const published = all.filter(r => r.published);

  const byLevel = {};
  published.forEach(p => {
    byLevel[p.level] = (byLevel[p.level] || 0) + 1;
  });

  const byCategory = {};
  published.forEach(p => {
    const cat = p.category || 'other';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  });

  res.json({
    total: all.length,
    published: published.length,
    byLevel,
    byCategory
  });
});

// ==================== GET /api/policies/search — 搜索 ====================
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.json({ list: [], total: 0, query: q });
  }

  const db = getDB();
  const keyword = q.toLowerCase();
  let rows = (db.policies || []).filter(r => r.published);

  rows = rows.filter(r => {
    return (
      (r.title && r.title.toLowerCase().includes(keyword)) ||
      (r.subtitle && r.subtitle.toLowerCase().includes(keyword)) ||
      (r.summary && r.summary.toLowerCase().includes(keyword)) ||
      (r.content && r.content.toLowerCase().includes(keyword)) ||
      (r.issuing_authority && r.issuing_authority.toLowerCase().includes(keyword)) ||
      (r.document_no && r.document_no.toLowerCase().includes(keyword)) ||
      (r.tags && Array.isArray(r.tags) && r.tags.some(t => t.toLowerCase().includes(keyword)))
    );
  });

  // 层级筛选
  const level = req.query.level;
  if (level && level !== 'all') {
    rows = rows.filter(r => r.level === level);
  }

  rows.sort((a, b) => {
    const da = a.publish_date || a.created_at || '';
    const db_ = b.publish_date || b.created_at || '';
    return db_.localeCompare(da);
  });

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const start = (page - 1) * limit;
  const list = rows.slice(start, start + limit).map(r => ({
    ...r,
    level_label: LEVEL_MAP[r.level] || '',
    category_label: CATEGORY_MAP[r.category] || ''
  }));

  res.json({ list, total, page, limit, query: q });
});

// ==================== GET /api/policies/subscriptions — 获取用户订阅列表 ====================
router.get('/subscriptions', (req, res) => {
  const userId = Number(req.query.user_id);
  if (!userId) {
    return res.status(400).json({ error: 'user_id 不能为空', code: 'USER_ID_REQUIRED' });
  }

  const rawDb = getRawDB();
  const rows = rawDb.prepare('SELECT * FROM policy_subscriptions WHERE user_id = ? ORDER BY created_at DESC').all(userId);

  const list = rows.map(r => ({
    ...r,
    levels: JSON.parse(r.levels || '[]'),
    categories: JSON.parse(r.categories || '[]'),
    keywords: JSON.parse(r.keywords || '[]')
  }));

  res.json({ list, total: list.length });
});

// ==================== GET /api/policies/match — 根据订阅偏好匹配政策 ====================
router.get('/match', (req, res) => {
  const userId = Number(req.query.user_id);
  if (!userId) {
    return res.status(400).json({ error: 'user_id 不能为空', code: 'USER_ID_REQUIRED' });
  }

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  // 获取用户所有 active 订阅
  const rawDb = getRawDB();
  const subs = rawDb.prepare('SELECT * FROM policy_subscriptions WHERE user_id = ? AND status = ?').all(userId, 'active');

  if (subs.length === 0) {
    return res.json({ list: [], total: 0, page, limit, totalPages: 0, subscriptions: 0 });
  }

  // 合并所有订阅偏好
  const allLevels = new Set();
  const allCategories = new Set();
  const allKeywords = [];
  subs.forEach(s => {
    JSON.parse(s.levels || '[]').forEach(l => allLevels.add(l));
    JSON.parse(s.categories || '[]').forEach(c => allCategories.add(c));
    JSON.parse(s.keywords || '[]').forEach(k => allKeywords.push(k));
  });

  const db = getDB();
  let rows = (db.policies || []).filter(r => r.published);

  // 按层级匹配
  if (allLevels.size > 0) {
    rows = rows.filter(r => allLevels.has(r.level));
  }

  // 按分类匹配
  if (allCategories.size > 0) {
    rows = rows.filter(r => allCategories.has(r.category));
  }

  // 按关键词匹配（标题/摘要/内容/标签任一命中）
  if (allKeywords.length > 0) {
    rows = rows.filter(r => {
      return allKeywords.some(kw => {
        const lower = kw.toLowerCase();
        return (
          (r.title && r.title.toLowerCase().includes(lower)) ||
          (r.summary && r.summary.toLowerCase().includes(lower)) ||
          (r.content && r.content.toLowerCase().includes(lower)) ||
          (r.tags && Array.isArray(r.tags) && r.tags.some(t => t.toLowerCase().includes(lower)))
        );
      });
    });
  }

  // 按发布日期倒序
  rows.sort((a, b) => {
    const da = a.publish_date || a.created_at || '';
    const db_ = b.publish_date || b.created_at || '';
    return db_.localeCompare(da);
  });

  const total = rows.length;
  const start = (page - 1) * limit;
  const list = rows.slice(start, start + limit).map(r => ({
    ...r,
    level_label: LEVEL_MAP[r.level] || '',
    category_label: CATEGORY_MAP[r.category] || ''
  }));

  res.json({
    list,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    subscriptions: subs.length,
    matchedPreferences: {
      levels: Array.from(allLevels),
      categories: Array.from(allCategories),
      keywords: allKeywords
    }
  });
});

// ==================== GET /api/policies/push-history — 推送历史 ====================
router.get('/push-history', (req, res) => {
  const rawDb = getRawDB();
  let sql = 'SELECT * FROM policy_pushes WHERE 1=1';
  const params = [];

  if (req.query.policy_id) {
    sql += ' AND policy_id = ?';
    params.push(Number(req.query.policy_id));
  }
  if (req.query.user_id) {
    // user_ids 是 JSON 数组，用 LIKE 模糊匹配
    sql += ' AND user_ids LIKE ?';
    params.push(`%${req.query.user_id}%`);
  }
  if (req.query.channel) {
    sql += ' AND channel = ?';
    params.push(req.query.channel);
  }

  sql += ' ORDER BY pushed_at DESC';

  const allRows = rawDb.prepare(sql).all(...params);

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = allRows.length;
  const start = (page - 1) * limit;
  const list = allRows.slice(start, start + limit).map(r => ({
    ...r,
    user_ids: JSON.parse(r.user_ids || '[]')
  }));

  res.json({ list, total, page, limit, totalPages: Math.ceil(total / limit) });
});

// ==================== GET /api/policies/favorites — 用户收藏列表 ====================
router.get('/favorites', (req, res) => {
  const userId = Number(req.query.user_id);
  if (!userId) {
    return res.status(400).json({ error: 'user_id 不能为空', code: 'USER_ID_REQUIRED' });
  }

  const rawDb = getRawDB();
  const favs = rawDb.prepare('SELECT * FROM policy_favorites WHERE user_id = ? ORDER BY created_at DESC').all(userId);

  // 关联政策详情
  const db = getDB();
  const list = favs.map(f => {
    const policy = (db.policies || []).find(p => p.id === f.policy_id);
    return {
      ...f,
      policy: policy ? {
        ...policy,
        level_label: LEVEL_MAP[policy.level] || '',
        category_label: CATEGORY_MAP[policy.category] || ''
      } : null
    };
  });

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = list.length;
  const start = (page - 1) * limit;
  const pagedList = list.slice(start, start + limit);

  res.json({ list: pagedList, total, page, limit, totalPages: Math.ceil(total / limit) });
});

// ==================== POST /api/policies/subscribe — 创建订阅 ====================
router.post('/subscribe', (req, res) => {
  const { user_id, levels = [], categories = [], keywords = [] } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id 不能为空', code: 'USER_ID_REQUIRED' });
  }

  const id = nextId('policy_subscriptions');
  const now = new Date().toISOString();
  const sub = {
    id,
    user_id,
    levels,
    categories,
    keywords,
    status: 'active',
    created_at: now,
    updated_at: now
  };

  insertRow('policy_subscriptions', sub);

  res.status(201).json({
    ...sub,
    levels: Array.isArray(sub.levels) ? sub.levels : JSON.parse(sub.levels || '[]'),
    categories: Array.isArray(sub.categories) ? sub.categories : JSON.parse(sub.categories || '[]'),
    keywords: Array.isArray(sub.keywords) ? sub.keywords : JSON.parse(sub.keywords || '[]')
  });
});

// ==================== POST /api/policies/compare — 政策对比 ====================
router.post('/compare', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length < 2) {
    return res.status(400).json({ error: '至少需要两条政策ID进行对比', code: 'IDS_REQUIRED' });
  }
  if (ids.length > 5) {
    return res.status(400).json({ error: '最多支持5条政策对比', code: 'TOO_MANY_IDS' });
  }

  const db = getDB();
  const policies = ids.map(id => {
    const p = (db.policies || []).find(r => r.id === Number(id));
    if (!p) return null;
    return {
      id: p.id,
      title: p.title,
      level: p.level,
      level_label: LEVEL_MAP[p.level] || '',
      category: p.category,
      category_label: CATEGORY_MAP[p.category] || '',
      issuing_authority: p.issuing_authority,
      document_no: p.document_no,
      publish_date: p.publish_date,
      effective_date: p.effective_date,
      expiry_date: p.expiry_date,
      summary: p.summary,
      key_points: p.key_points || [],
      applicable_industries: p.applicable_industries || [],
      support_measures: p.support_measures || [],
      tags: p.tags || []
    };
  }).filter(Boolean);

  if (policies.length < 2) {
    return res.status(400).json({ error: '找到的有效政策不足两条', code: 'INSUFFICIENT_POLICIES' });
  }

  // 生成对比维度
  const dimensions = [
    { key: 'level', label: '政策层级' },
    { key: 'category', label: '政策类型' },
    { key: 'issuing_authority', label: '发文机构' },
    { key: 'document_no', label: '文号' },
    { key: 'publish_date', label: '发布日期' },
    { key: 'effective_date', label: '生效日期' },
    { key: 'expiry_date', label: '失效日期' },
    { key: 'summary', label: '摘要' },
    { key: 'key_points', label: '关键要点' },
    { key: 'applicable_industries', label: '适用行业' },
    { key: 'support_measures', label: '扶持措施' },
    { key: 'tags', label: '标签' }
  ];

  // 对比表格：每个维度对应每条政策的值
  const table = dimensions.map(dim => ({
    dimension: dim.key,
    dimension_label: dim.label,
    values: policies.map(p => {
      const val = p[dim.key];
      if (Array.isArray(val)) return val;
      return val || '';
    })
  }));

  res.json({
    policies,
    dimensions: dimensions.map(d => ({ key: d.key, label: d.label })),
    table,
    count: policies.length
  });
});

// ==================== PUT /api/policies/subscriptions/:id — 更新订阅偏好 ====================
router.put('/subscriptions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的订阅ID', code: 'INVALID_ID' });
  }

  const { levels, categories, keywords, status } = req.body;
  const updates = {};
  if (levels !== undefined) updates.levels = levels;
  if (categories !== undefined) updates.categories = categories;
  if (keywords !== undefined) updates.keywords = keywords;
  if (status !== undefined) updates.status = status;
  updates.updated_at = new Date().toISOString();

  updateRow('policy_subscriptions', { id }, updates);

  // 读取更新后的数据
  const rawDb = getRawDB();
  const row = rawDb.prepare('SELECT * FROM policy_subscriptions WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ error: '订阅不存在', code: 'SUB_NOT_FOUND' });
  }

  res.json({
    ...row,
    levels: JSON.parse(row.levels || '[]'),
    categories: JSON.parse(row.categories || '[]'),
    keywords: JSON.parse(row.keywords || '[]')
  });
});

// ==================== DELETE /api/policies/subscriptions/:id — 取消订阅 ====================
router.delete('/subscriptions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的订阅ID', code: 'INVALID_ID' });
  }

  deleteRows('policy_subscriptions', { id });
  res.json({ success: true, id, message: '订阅已取消' });
});

// ==================== PUT /api/policies/push/:id/read — 标记推送已读 ====================
router.put('/push/:id/read', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的推送ID', code: 'INVALID_ID' });
  }

  updateRow('policy_pushes', { id }, { read_at: new Date().toISOString() });
  res.json({ success: true, id, message: '已标记为已读' });
});

// ==================== GET /api/policies/:id — 政策详情 ====================
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的政策ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const row = (db.policies || []).find(r => r.id === id);
  if (!row) {
    return res.status(404).json({ error: '政策不存在', code: 'POLICY_NOT_FOUND' });
  }

  // 增加浏览量
  row.views = (row.views || 0) + 1;
  syncRow('policies', row);

  res.json({
    ...row,
    level_label: LEVEL_MAP[row.level] || '',
    category_label: CATEGORY_MAP[row.category] || ''
  });
});

// ==================== POST /api/policies — 添加政策 ====================
router.post('/', (req, res) => {
  const {
    title, subtitle, level, category, issuing_authority, document_no,
    publish_date, effective_date, expiry_date, summary, content,
    key_points, applicable_industries, support_measures, attachments,
    tags, sort_order, published
  } = req.body;

  if (!title) {
    return res.status(400).json({ error: '标题不能为空', code: 'TITLE_REQUIRED' });
  }

  const id = nextId('policies');
  const db = getDB();

  const newPolicy = {
    id,
    title,
    subtitle: subtitle || '',
    level: level || 'national',
    level_label: LEVEL_MAP[level] || '国家',
    category: category || 'other',
    category_label: CATEGORY_MAP[category] || '其他',
    issuing_authority: issuing_authority || '',
    document_no: document_no || '',
    publish_date: publish_date || '',
    effective_date: effective_date || '',
    expiry_date: expiry_date || '',
    summary: summary || '',
    content: content || '',
    key_points: key_points || [],
    applicable_industries: applicable_industries || [],
    support_measures: support_measures || [],
    attachments: attachments || [],
    tags: tags || [],
    views: 0,
    published: published !== undefined ? (published ? 1 : 0) : 1,
    sort_order: sort_order || 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.policies.push(newPolicy);

  res.status(201).json({
    ...newPolicy,
    level_label: LEVEL_MAP[newPolicy.level] || '',
    category_label: CATEGORY_MAP[newPolicy.category] || ''
  });
});

// ==================== PUT /api/policies/:id — 更新政策 ====================
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的政策ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const row = (db.policies || []).find(r => r.id === id);
  if (!row) {
    return res.status(404).json({ error: '政策不存在', code: 'POLICY_NOT_FOUND' });
  }

  const allowedFields = [
    'title', 'subtitle', 'level', 'category', 'issuing_authority', 'document_no',
    'publish_date', 'effective_date', 'expiry_date', 'summary', 'content',
    'key_points', 'applicable_industries', 'support_measures', 'attachments',
    'tags', 'sort_order', 'published'
  ];

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      row[field] = req.body[field];
    }
  }

  // 自动更新 label 字段
  if (req.body.level) {
    row.level_label = LEVEL_MAP[req.body.level] || '';
  }
  if (req.body.category) {
    row.category_label = CATEGORY_MAP[req.body.category] || '';
  }
  row.updated_at = new Date().toISOString();

  syncRow('policies', row);

  res.json({
    ...row,
    level_label: LEVEL_MAP[row.level] || '',
    category_label: CATEGORY_MAP[row.category] || ''
  });
});

// ==================== DELETE /api/policies/:id — 删除政策 ====================
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的政策ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const arr = db.policies;
  const idx = arr.findIndex(r => r.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: '政策不存在', code: 'POLICY_NOT_FOUND' });
  }

  arr.splice(idx, 1);

  res.json({ success: true, id, message: '政策已删除' });
});

// ==================== POST /api/policies/:id/push — 推送政策 ====================
router.post('/:id/push', (req, res) => {
  const policyId = Number(req.params.id);
  if (!policyId || policyId <= 0) {
    return res.status(400).json({ error: '无效的政策ID', code: 'INVALID_ID' });
  }

  const { user_ids = [], channel = 'miniprogram', pushed_by = '' } = req.body;
  if (!Array.isArray(user_ids) || user_ids.length === 0) {
    return res.status(400).json({ error: 'user_ids 不能为空', code: 'USER_IDS_REQUIRED' });
  }

  const db = getDB();
  const policy = (db.policies || []).find(r => r.id === policyId);
  if (!policy) {
    return res.status(404).json({ error: '政策不存在', code: 'POLICY_NOT_FOUND' });
  }

  const id = nextId('policy_pushes');
  const now = new Date().toISOString();
  const push = {
    id,
    policy_id: policyId,
    policy_title: policy.title,
    user_ids,
    channel,
    status: 'sent',
    pushed_by,
    read_at: '',
    pushed_at: now,
    created_at: now
  };

  insertRow('policy_pushes', push);

  res.status(201).json({
    ...push,
    user_ids: Array.isArray(push.user_ids) ? push.user_ids : JSON.parse(push.user_ids || '[]')
  });
});

// ==================== POST /api/policies/:id/favorite — 收藏政策 ====================
router.post('/:id/favorite', (req, res) => {
  const policyId = Number(req.params.id);
  if (!policyId || policyId <= 0) {
    return res.status(400).json({ error: '无效的政策ID', code: 'INVALID_ID' });
  }

  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id 不能为空', code: 'USER_ID_REQUIRED' });
  }

  const db = getDB();
  const policy = (db.policies || []).find(r => r.id === policyId);
  if (!policy) {
    return res.status(404).json({ error: '政策不存在', code: 'POLICY_NOT_FOUND' });
  }

  // 检查是否已收藏
  const rawDb = getRawDB();
  const existing = rawDb.prepare('SELECT id FROM policy_favorites WHERE user_id = ? AND policy_id = ?').get(user_id, policyId);
  if (existing) {
    return res.status(400).json({ error: '已收藏该政策', code: 'ALREADY_FAVORITED' });
  }

  const id = nextId('policy_favorites');
  const fav = {
    id,
    user_id,
    policy_id: policyId,
    policy_title: policy.title,
    created_at: new Date().toISOString()
  };

  insertRow('policy_favorites', fav);

  res.status(201).json({ success: true, ...fav });
});

// ==================== DELETE /api/policies/:id/favorite — 取消收藏 ====================
router.delete('/:id/favorite', (req, res) => {
  const policyId = Number(req.params.id);
  if (!policyId || policyId <= 0) {
    return res.status(400).json({ error: '无效的政策ID', code: 'INVALID_ID' });
  }

  const userId = Number(req.query.user_id || (req.body && req.body.user_id));
  if (!userId) {
    return res.status(400).json({ error: 'user_id 不能为空', code: 'USER_ID_REQUIRED' });
  }

  deleteRows('policy_favorites', { user_id: userId, policy_id: policyId });
  res.json({ success: true, policy_id: policyId, message: '已取消收藏' });
});

// ==================== POST /api/policies/:id/interpret — 政策解读 ====================
router.post('/:id/interpret', (req, res) => {
  const policyId = Number(req.params.id);
  if (!policyId || policyId <= 0) {
    return res.status(400).json({ error: '无效的政策ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const policy = (db.policies || []).find(r => r.id === policyId);
  if (!policy) {
    return res.status(404).json({ error: '政策不存在', code: 'POLICY_NOT_FOUND' });
  }

  // 基于规则提取关键信息
  const content = policy.content || policy.summary || '';
  const keyPoints = policy.key_points || [];
  const supportMeasures = policy.support_measures || [];
  const applicableIndustries = policy.applicable_industries || [];

  // 提取关键句（含关键词的句子）
  const KEYWORD_PATTERNS = [
    /[^。；;\n]*(?:支持|补贴|奖励|资助|优惠|减免|鼓励|促进|推动|加快|加强)[^。；;\n]*[。；;\n]?/gi,
    /[^。；;\n]*(?:条件|要求|资质|范围|适用|面向|针对)[^。；;\n]*[。；;\n]?/gi,
    /[^。；;\n]*(?:申报|申请|材料|流程|截止|期限|时间)[^。；;\n]*[。；;\n]?/gi
  ];

  const extractedSentences = new Set();
  for (const pattern of KEYWORD_PATTERNS) {
    const matches = content.match(pattern);
    if (matches) {
      matches.forEach(m => extractedSentences.add(m.trim()));
    }
  }

  // 提取适用条件
  const conditions = [];
  const conditionPatterns = [
    /(?:适用|面向|针对|适用于|适用范围)[：:·\s]*([^。；;\n]+)/gi,
    /(?:条件|要求|资质)[：:·\s]*([^。；;\n]+)/gi,
    /(?:企业|单位|机构|组织)[^。；;\n]*?(?:应当|须|需|应)[^。；;\n]*/gi
  ];
  for (const pattern of conditionPatterns) {
    const matches = content.match(pattern);
    if (matches) {
      matches.forEach(m => conditions.push(m.trim()));
    }
  }

  // 提取申报建议
  const suggestions = [];
  if (content.match(/申报|申请/gi)) {
    suggestions.push('该政策涉及申报/申请流程，建议关注相关时间节点和材料要求。');
  }
  if (content.match(/补贴|资助|奖励|资金/gi)) {
    suggestions.push('该政策包含资金支持，建议准备相关财务和项目材料。');
  }
  if (content.match(/资质|认定|认证|评审/gi)) {
    suggestions.push('该政策涉及资质认定，建议提前确认企业是否符合相关条件。');
  }
  if (content.match(/数字化转型|智能化|数字化/gi)) {
    suggestions.push('该政策与数字化转型相关，建议评估企业数字化现状并制定改造方案。');
  }
  if (content.match(/人才|引进|培养|培训/gi)) {
    suggestions.push('该政策涉及人才政策，建议关注人才引进和培养方面的申报要求。');
  }
  if (suggestions.length === 0) {
    suggestions.push('建议仔细阅读政策全文，了解具体要求和申报流程。');
  }

  // 生成结构化解读
  const interpretation = {
    policy_id: policyId,
    policy_title: policy.title,
    level: policy.level,
    level_label: LEVEL_MAP[policy.level] || '',
    category: policy.category,
    category_label: CATEGORY_MAP[policy.category] || '',
    generated_at: new Date().toISOString(),
    key_points: keyPoints.length > 0 ? keyPoints : Array.from(extractedSentences).slice(0, 5),
    applicable_conditions: conditions.length > 0
      ? conditions.slice(0, 5)
      : (applicableIndustries.length > 0
          ? [`适用于：${applicableIndustries.join('、')}`]
          : ['参见政策原文适用范围']),
    support_summary: supportMeasures.length > 0
      ? supportMeasures
      : Array.from(extractedSentences).filter(s =>
          /支持|补贴|奖励|资助|优惠|减免/i.test(s)
        ).slice(0, 3),
    suggestions,
    key_sentences: Array.from(extractedSentences).slice(0, 8),
    abstract: policy.summary || content.slice(0, 200) + (content.length > 200 ? '...' : '')
  };

  res.json(interpretation);
});

module.exports = router;
