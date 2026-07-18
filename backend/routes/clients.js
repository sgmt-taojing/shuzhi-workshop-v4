const { getDB, nextId, save } = require('../models/db');
const router = require('express').Router();

// 公开：获取甲方列表
router.get('/', (req, res) => {
  const db = getDB();
  const rows = (db.clients || []).filter(r => r.published).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  res.json(rows);
});

// 公开：获取甲方统计信息（必须放在 /:id 之前）
router.get('/stats', (req, res) => {
  const db = getDB();
  const all = (db.clients || []);
  const published = all.filter(r => r.published);
  const byIndustry = {};
  published.forEach(c => {
    const ind = c.industry || '其他';
    byIndustry[ind] = (byIndustry[ind] || 0) + 1;
  });
  res.json({
    total: all.length,
    published: published.length,
    byIndustry,
    withWechat: published.filter(r => r.wechat_account_id).length
  });
});

// 每日推荐客户
router.get('/featured/today', (req, res) => {
  const db = getDB();
  const today = new Date().toISOString().slice(0,10);
  let client = (db.clients || []).find(r => r.daily_featured === 1 && r.featured_date === today && r.published);
  
  // 如果今天还没设置，自动轮换
  if (!client) {
    const published = (db.clients || []).filter(r => r.published);
    if (published.length === 0) return res.json({ client: null });
    // 按ID轮换，取今天日期模总数
    const idx = parseInt(today.replace(/-/g,'')) % published.length;
    client = published[idx];
    client.daily_featured = 1;
    client.featured_date = today;
    // 清除其他
    (db.clients || []).forEach(c => { if (c.id !== client.id) { c.daily_featured = 0; } });
  }
  
  // 获取客户产品和画像
  const products = (db.client_products || []).filter(p => 
    p.client_id == client.id || p.client_id == 'c'+client.id || (p.client_name||'') === client.name
  );
  const profile = (db.enterprise_profiles || []).find(p => p.client_id === client.id);
  const certs = (db.enterprise_certificates || []).filter(c => c.client_id === client.id);
  
  res.json({
    client: {
      ...client,
      advantages: typeof client.advantages === 'string' ? JSON.parse(client.advantages || '[]') : (client.advantages || []),
      qualifications: typeof client.qualifications === 'string' ? JSON.parse(client.qualifications || '[]') : (client.qualifications || [])
    },
    products: products.slice(0, 5),
    profile,
    certificates: certs,
    featured_date: today
  });
});

// 公开：获取单个甲方详情（含其所有产品）
router.get('/:id', (req, res) => {
  const db = getDB();
  const client = (db.clients || []).find(r => r.id === Number(req.params.id) && r.published);
  if (!client) return res.status(404).json({ error: '甲方不存在' });
  const products = (db.client_products || []).filter(p => p.clientId === `c${client.id}`);
  res.json({ ...client, products });
});

module.exports = router;
