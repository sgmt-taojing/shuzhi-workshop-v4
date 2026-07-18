const express = require('express');
const router = express.Router();
const db = require('../models/db');

/**
 * GET /api/search?q=keyword&type=all
 * 全局搜索：跨产品、甲方产品、文章
 */
router.get('/', async (req, res) => {
  try {
    const { q: keyword, type = 'all' } = req.query;
    if (!keyword || !keyword.trim()) {
      return res.json({ products: [], clientProducts: [], articles: [], total: 0 });
    }

    const kw = keyword.trim().toLowerCase();
    const results = { products: [], clientProducts: [], articles: [], total: 0 };

    // 搜索产品
    if (type === 'all' || type === 'product') {
      const products = db.prepare(`
        SELECT id, title, subtitle, icon, category, price, unit, image, tags
        FROM products WHERE status = 'published'
        AND (LOWER(title) LIKE ? OR LOWER(subtitle) LIKE ? OR LOWER(category) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ?)
        ORDER BY id LIMIT 20
      `).all(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`);
      results.products = products;
    }

    // 搜索甲方产品
    if (type === 'all' || type === 'clientProduct') {
      const clientProducts = db.prepare(`
        SELECT cp.id, cp.title, cp.description, cp.price, cp.unit, cp.type, cp.image,
               c.name as client_name
        FROM client_products cp
        LEFT JOIN clients c ON cp.client_id = c.id
        WHERE cp.status = 'published'
        AND (LOWER(cp.title) LIKE ? OR LOWER(cp.description) LIKE ? OR LOWER(c.name) LIKE ?)
        ORDER BY cp.id LIMIT 20
      `).all(`%${kw}%`, `%${kw}%`, `%${kw}%`);
      results.clientProducts = clientProducts;
    }

    // 搜索文章
    if (type === 'all' || type === 'article') {
      const articles = db.prepare(`
        SELECT id, title, summary, category, tag, image, created_at
        FROM articles WHERE status = 'published'
        AND (LOWER(title) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(category) LIKE ? OR LOWER(content) LIKE ?)
        ORDER BY created_at DESC LIMIT 20
      `).all(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`);
      results.articles = articles;
    }

    results.total = results.products.length + results.clientProducts.length + results.articles.length;
    res.json(results);
  } catch (err) {
    console.error('搜索失败:', err);
    res.status(500).json({ error: '搜索失败' });
  }
});

/**
 * GET /api/search/suggest?q=keyword
 * 搜索建议（快速返回产品标题列表）
 */
router.get('/suggest', async (req, res) => {
  try {
    const { q: keyword } = req.query;
    if (!keyword || keyword.trim().length < 1) {
      return res.json([]);
    }

    const kw = keyword.trim().toLowerCase();

    const products = db.prepare(`
      SELECT id, title, 'product' as type FROM products
      WHERE status = 'published' AND LOWER(title) LIKE ?
      LIMIT 5
    `).all(`%${kw}%`);

    const clientProducts = db.prepare(`
      SELECT cp.id, cp.title, 'clientProduct' as type FROM client_products cp
      WHERE cp.status = 'published' AND LOWER(cp.title) LIKE ?
      LIMIT 5
    `).all(`%${kw}%`);

    const articles = db.prepare(`
      SELECT id, title, 'article' as type FROM articles
      WHERE status = 'published' AND LOWER(title) LIKE ?
      LIMIT 5
    `).all(`%${kw}%`);

    res.json([...products, ...clientProducts, ...articles].slice(0, 10));
  } catch (err) {
    console.error('搜索建议失败:', err);
    res.json([]);
  }
});

module.exports = router;
