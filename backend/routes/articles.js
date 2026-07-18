const { getDB, syncRow, nextId, getRawDB } = require('../models/db');
const router = require('express').Router();

// 确保 articles 表有 product_id 列（自动迁移）
function ensureProductColumn() {
  try {
    const db = getRawDB();
    const cols = db.prepare('PRAGMA table_info(articles)').all();
    if (!cols.find(c => c.name === 'product_id')) {
      db.exec('ALTER TABLE articles ADD COLUMN product_id INTEGER DEFAULT 0');
      console.log('  ✅ 添加列: articles.product_id');
    }
    if (!cols.find(c => c.name === 'article_type')) {
      db.exec('ALTER TABLE articles ADD COLUMN article_type TEXT DEFAULT "article"');
      console.log('  ✅ 添加列: articles.article_type');
    }
  } catch(e) { /* 列已存在 */ }
}
ensureProductColumn();

router.get('/', (req, res) => {
  const db = getDB();
  let rows = (db.articles || []).filter(r => r.published);

  // 分类筛选
  const category = req.query.category;
  if (category && category !== 'all') {
    rows = rows.filter(r => r.category === category);
  }

  // 标签筛选（支持多标签逗号分隔）
  const tag = req.query.tag;
  if (tag) {
    const tags = tag.split(',').map(t => t.trim());
    rows = rows.filter(r => tags.some(t => (r.tags || []).includes(t)));
  }

  // 排序（默认按发布时间倒序）
  const sort = req.query.sort || 'date';
  if (sort === 'views') {
    rows.sort((a, b) => (b.views || 0) - (a.views || 0));
  } else {
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  // 分页
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const start = (page - 1) * limit;
  const list = rows.slice(start, start + limit).map(r => ({
    ...r,
    // 统一返回驼峰字段，便于前端映射
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    readTime: r.read_time || '5分钟'
  }));

  res.json({
    list,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  });
});

// 公开：获取文章统计信息（必须放在 /:id 之前）
router.get('/stats', (req, res) => {
  const db = getDB();
  const all = (db.articles || []);
  const published = all.filter(r => r.published);
  const byCategory = {};
  published.forEach(a => {
    const cat = a.category || '未分类';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  });
  res.json({
    total: all.length,
    published: published.length,
    byCategory,
    featured: published.filter(r => r.featured).length
  });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的文章ID', code: 'INVALID_ID' });
  }
  const db = getDB();
  const row = (db.articles || []).find(r => r.id === id && r.published);
  if (!row) return res.status(404).json({ error: '文章不存在', code: 'ARTICLE_NOT_FOUND' });
  // 增加浏览量
  row.views = (row.views || 0) + 1;
  syncRow('articles', row);
  res.json(row);
});

// ==================== 产品软文接口 ====================

// GET /api/articles/product/:productId — 获取某产品关联的软文
router.get('/product/:productId', (req, res) => {
  const productId = Number(req.params.productId);
  if (!productId || productId <= 0) {
    return res.status(400).json({ error: '无效的产品ID', code: 'INVALID_ID' });
  }
  const db = getDB();
  const rows = (db.articles || []).filter(r => r.published && r.product_id === productId);
  res.json(rows);
});

// POST /api/articles/product/:productId — 为某产品添加软文
router.post('/product/:productId', (req, res) => {
  const productId = Number(req.params.productId);
  if (!productId || productId <= 0) {
    return res.status(400).json({ error: '无效的产品ID', code: 'INVALID_ID' });
  }
  const { title, subtitle, cover, category, tags, summary, content, author, source } = req.body;
  if (!title) {
    return res.status(400).json({ error: '标题不能为空', code: 'TITLE_REQUIRED' });
  }
  
  const id = nextId('articles');
  const db = getDB();
  const newArticle = {
    id,
    title,
    subtitle: subtitle || '',
    cover: cover || '',
    category: category || '产品软文',
    tags: tags || [],
    summary: summary || '',
    content: content || '',
    author: author || '',
    source: source || '',
    views: 0,
    published: 1,
    product_id: productId,
    article_type: 'product_article',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  db.articles.push(newArticle);
  
  res.status(201).json(newArticle);
});

module.exports = router;
