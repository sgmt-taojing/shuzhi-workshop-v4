const { getDB } = require('../models/db');
const router = require('express').Router();

// 公开：获取已发布甲方产品（支持分页）
// 无分页参数时返回数组（向后兼容），有分页参数时返回分页对象
router.get('/', (req, res) => {
  const db = getDB();
  let rows = (db.client_products || []).filter(r => r.published).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  // 行业筛选
  const industry = req.query.industry;
  if (industry && industry !== 'all') {
    rows = rows.filter(r => r.industry === industry);
  }

  // 搜索
  const keyword = req.query.keyword;
  if (keyword) {
    const kw = keyword.toLowerCase();
    rows = rows.filter(r =>
      (r.name && r.name.toLowerCase().includes(kw)) ||
      (r.description && r.description.toLowerCase().includes(kw))
    );
  }

  // 检查是否请求分页
  const page = parseInt(req.query.page);
  const limit = parseInt(req.query.limit);

  if (page > 0 && limit > 0) {
    const total = rows.length;
    const start = (page - 1) * limit;
    const list = rows.slice(start, start + limit);
    return res.json({
      list,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  }

  // 否则返回数组（保持向后兼容）
  res.json(rows);
});

// 公开：获取甲方产品统计信息（必须放在 /:id 之前）
router.get('/stats', (req, res) => {
  const db = getDB();
  const all = (db.client_products || []);
  const published = all.filter(r => r.published);
  const byIndustry = {};
  published.forEach(p => {
    const ind = p.industry || '其他';
    byIndustry[ind] = (byIndustry[ind] || 0) + 1;
  });
  res.json({
    total: all.length,
    published: published.length,
    byIndustry,
    featured: published.filter(r => r.featured).length
  });
});

// 公开：获取单个甲方产品（含甲方企业信息）
router.get('/:id', (req, res) => {
  // 参数校验
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的甲方产品ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const row = (db.client_products || []).find(r => r.id === id && r.published);
  if (!row) return res.status(404).json({ error: '甲方产品不存在', code: 'CLIENT_PRODUCT_NOT_FOUND' });
  // 附加甲方企业信息
  const clientId = row.clientId;
  if (clientId) {
    const numId = Number(clientId.replace('c', ''));
    const client = (db.clients || []).find(c => c.id === numId);
    if (client) {
      row.client_name = row.clientName || client.short_name || client.name;
      row.client_industry = row.clientIndustry || client.industry;
      row.client_avatar = row.clientAvatar || client.avatar;
      row.client_id = clientId;
    }
  }
  res.json(row);
});

module.exports = router;
