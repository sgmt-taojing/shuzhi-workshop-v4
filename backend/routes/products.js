const { getDB, nextId, save } = require('../models/db');
const router = require('express').Router();

// 公开：获取已发布产品（支持分页）
// 无分页参数时返回数组（向后兼容），有分页参数时返回分页对象
router.get('/', (req, res) => {
  const db = getDB();
  let rows = (db.products || []).filter(r => r.published).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  // 检查是否请求分页
  const page = parseInt(req.query.page);
  const limit = parseInt(req.query.limit);

  // 如果提供了分页参数，返回分页格式
  if (page > 0 && limit > 0) {
    const total = rows.length;
    const start = (page -1) * limit;
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

// 公开：获取统计信息（必须放在 /:id 之前，避免被 Express 当作 ID 匹配）
router.get('/stats', (req, res) => {
  const db = getDB();
  const publishedProducts = (db.products || []).filter(r => r.published).length;
  const publishedClientProducts = (db.client_products || []).filter(r => r.published).length;
  const publishedArticles = (db.articles || []).filter(r => r.published).length;
  const servedClients = (db.clients || []).filter(r => r.published).length;
  res.json({
    productCount: publishedProducts,
    clientProductCount: publishedClientProducts,
    articleCount: publishedArticles,
    clientCount: servedClients,
    servedClients,
    avgSaveCost: 27,
    satisfaction: 96
  });
});

router.get('/:id', (req, res) => {
  // 参数校验
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的产品ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const row = db.products?.find(r => r.id === id && r.published);
  if (!row) return res.status(404).json({ error: '产品不存在', code: 'PRODUCT_NOT_FOUND' });
  res.json(row);
});

// 获取产品关联的软文
router.get('/:id/articles', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的产品ID', code: 'INVALID_ID' });
  }
  const db = getDB();
  const articles = (db.articles || []).filter(r => r.published && r.product_id === id);
  res.json(articles);
});

module.exports = router;
