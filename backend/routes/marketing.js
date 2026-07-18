const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

// ==================== 常量 ====================
const ARTICLE_STYLES = { pain_point:'痛点引入', story:'故事型', data:'数据型', comparison:'对比型' };
const ARTICLE_STATUS = { draft:'草稿', published:'已发布', archived:'已归档' };
const WECHAT_STATUS = { active:'活跃', inactive:'停用' };
const STAR_TYPES = { active:'活跃之星', growing:'成长之星', influential:'影响力之星', innovative:'创新之星' };
const CAMPAIGN_TYPES = { cross_promo:'交叉推广', group_buy:'联合团购', content_swap:'内容互换' };
const CAMPAIGN_STATUS = { planning:'筹备中', active:'进行中', completed:'已结束', cancelled:'已取消' };

// ==================== 产品软文 ====================

// GET /articles/product/:productId — 某产品的软文列表
router.get('/articles/product/:productId', (req, res) => {
  const pid = Number(req.params.productId);
  const db = getDB();
  const rows = (db.product_articles || []).filter(r => r.product_id === pid)
    .sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  res.json({ list: rows.map(r => ({...r, style_label: ARTICLE_STYLES[r.style]||r.style, status_label: ARTICLE_STATUS[r.status]||r.status})) });
});

// GET /articles/:id
router.get('/articles/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const article = (db.product_articles || []).find(r => r.id === id);
  if (!article) return res.status(404).json({ error: '软文不存在' });
  res.json({...article, style_label: ARTICLE_STYLES[article.style]||article.style, status_label: ARTICLE_STATUS[article.status]||article.status});
});

// POST /articles — 创建软文
router.post('/articles', (req, res) => {
  const { product_id, title, content, style, cta_config, wechat_format } = req.body;
  if (!product_id || !title) return res.status(400).json({ error: '缺少产品ID或标题' });

  const id = nextId('product_articles');
  const now = new Date().toISOString();
  const article = {
    id, product_id, title, content: content||'',
    style: style||'pain_point',
    cta_config: cta_config||{}, wechat_format: wechat_format||{},
    status: 'draft', views: 0, conversions: 0,
    created_at: now, updated_at: now
  };
  getDB().product_articles.push(article);
  res.status(201).json(article);
});

// PUT /articles/:id
router.put('/articles/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const article = (db.product_articles || []).find(r => r.id === id);
  if (!article) return res.status(404).json({ error: '软文不存在' });

  ['title','content','style','cta_config','wechat_format','status','views','conversions'].forEach(f => {
    if (req.body[f] !== undefined) article[f] = req.body[f];
  });
  article.updated_at = new Date().toISOString();
  syncRow('product_articles', article);
  res.json(article);
});

// DELETE /articles/:id
router.delete('/articles/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.product_articles || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '软文不存在' });
  db.product_articles.splice(idx, 1);
  deleteRows('product_articles', { id });
  res.json({ success: true });
});

// POST /articles/:id/publish — 发布软文
router.post('/articles/:id/publish', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const article = (db.product_articles || []).find(r => r.id === id);
  if (!article) return res.status(404).json({ error: '软文不存在' });
  article.status = 'published';
  article.updated_at = new Date().toISOString();
  syncRow('product_articles', article);
  res.json({...article, status_label: ARTICLE_STATUS[article.status]});
});

// GET /articles — 全部软文列表
router.get('/articles', (req, res) => {
  const db = getDB();
  let rows = (db.product_articles || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);

  const productId = req.query.productId;
  if (productId) rows = rows.filter(r => r.product_id === Number(productId));

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const list = rows.slice((page-1)*limit, page*limit).map(r => {
    const product = (db.products || []).find(p => p.id === r.product_id);
    return {
      ...r,
      style_label: ARTICLE_STYLES[r.style]||r.style,
      status_label: ARTICLE_STATUS[r.status]||r.status,
      product_name: product ? product.title : ''
    };
  });

  res.json({ list, total, page, limit });
});

// ==================== 客户公众号 ====================

// GET /wechat — 公众号列表
router.get('/wechat', (req, res) => {
  const db = getDB();
  let rows = (db.customer_wechat_accounts || []).slice().sort((a,b) => (b.follower_count||0) - (a.follower_count||0));

  const search = req.query.search;
  if (search) {
    const kw = search.toLowerCase();
    rows = rows.filter(r => (r.account_name||'').toLowerCase().includes(kw) || (r.industry||'').toLowerCase().includes(kw));
  }

  const list = rows.map(r => {
    const client = (db.clients || []).find(c => c.id === r.client_id);
    return {...r, client_name: client ? client.name : ''};
  });
  res.json({ list, total: list.length });
});

// POST /wechat
router.post('/wechat', (req, res) => {
  const { client_id, account_name, qrcode_url, industry, follower_count, follower_profile } = req.body;
  if (!client_id || !account_name) return res.status(400).json({ error: '缺少客户ID或公众号名称' });

  const id = nextId('customer_wechat_accounts');
  const account = {
    id, client_id, account_name,
    qrcode_url: qrcode_url||'', industry: industry||'',
    follower_count: follower_count||0, follower_profile: follower_profile||{},
    mutual_follow_count: 0, imported_traffic: 0, received_traffic: 0,
    status: 'active', created_at: new Date().toISOString()
  };
  getDB().customer_wechat_accounts.push(account);
  res.status(201).json(account);
});

// PUT /wechat/:id
router.put('/wechat/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const account = (db.customer_wechat_accounts || []).find(r => r.id === id);
  if (!account) return res.status(404).json({ error: '公众号不存在' });

  ['account_name','qrcode_url','industry','follower_count','follower_profile','mutual_follow_count','imported_traffic','received_traffic','status'].forEach(f => {
    if (req.body[f] !== undefined) account[f] = req.body[f];
  });
  syncRow('customer_wechat_accounts', account);
  res.json(account);
});

// DELETE /wechat/:id
router.delete('/wechat/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.customer_wechat_accounts || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '公众号不存在' });
  db.customer_wechat_accounts.splice(idx, 1);
  deleteRows('customer_wechat_accounts', { id });
  res.json({ success: true });
});

// ==================== 每周星级客户 ====================

// GET /weekly-star/current — 当周星级客户
router.get('/weekly-star/current', (req, res) => {
  const db = getDB();
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay() + 1);
  weekStart.setHours(0,0,0,0);
  const weekStr = weekStart.toISOString().slice(0,10);

  const stars = (db.weekly_star_clients || []).filter(r => r.week_start === weekStr);
  const list = stars.map(r => {
    const client = (db.clients || []).find(c => c.id === r.client_id);
    return {...r, client_name: client ? client.name : '', star_type_label: STAR_TYPES[r.star_type]||r.star_type};
  });
  res.json({ week_start: weekStr, list });
});

// GET /weekly-star — 星级客户历史
router.get('/weekly-star', (req, res) => {
  const db = getDB();
  const rows = (db.weekly_star_clients || []).slice().sort((a,b) => (b.week_start||'').localeCompare(a.week_start||''));
  const list = rows.map(r => {
    const client = (db.clients || []).find(c => c.id === r.client_id);
    return {...r, client_name: client ? client.name : '', star_type_label: STAR_TYPES[r.star_type]||r.star_type};
  });
  res.json({ list, total: list.length });
});

// POST /weekly-star — 提名星级客户
router.post('/weekly-star', (req, res) => {
  const { week_start, client_id, star_type, reason, cover_image, featured_products } = req.body;
  if (!client_id || !week_start) return res.status(400).json({ error: '缺少客户ID或周日期' });

  const db = getDB();
  const exist = (db.weekly_star_clients || []).find(r => r.week_start === week_start && r.client_id === client_id);
  if (exist) return res.status(409).json({ error: '该客户本周已提名' });

  const id = nextId('weekly_star_clients');
  const star = {
    id, week_start, client_id,
    star_type: star_type||'active', reason: reason||'',
    cover_image: cover_image||'', featured_products: featured_products||[],
    article_id: 0, published: 0, views: 0,
    created_at: new Date().toISOString()
  };
  db.weekly_star_clients.push(star);
  res.status(201).json(star);
});

// POST /weekly-star/:id/publish — 发布星级客户推荐
router.post('/weekly-star/:id/publish', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const star = (db.weekly_star_clients || []).find(r => r.id === id);
  if (!star) return res.status(404).json({ error: '记录不存在' });
  star.published = 1;
  syncRow('weekly_star_clients', star);
  res.json({...star, success: true});
});

// DELETE /weekly-star/:id
router.delete('/weekly-star/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.weekly_star_clients || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '记录不存在' });
  db.weekly_star_clients.splice(idx, 1);
  deleteRows('weekly_star_clients', { id });
  res.json({ success: true });
});

// ==================== 联合营销 ====================

// GET /campaigns
router.get('/campaigns', (req, res) => {
  const db = getDB();
  let rows = (db.joint_campaigns || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);

  const list = rows.map(r => {
    const participantNames = (r.participants||[]).map(pid => {
      const c = (db.clients || []).find(x => x.id === pid);
      return c ? c.name : '';
    }).filter(Boolean);
    return {...r, status_label: CAMPAIGN_STATUS[r.status]||r.status, type_label: CAMPAIGN_TYPES[r.campaign_type]||r.campaign_type, participant_names: participantNames};
  });
  res.json({ list, total: list.length });
});

// POST /campaigns
router.post('/campaigns', (req, res) => {
  const { title, description, campaign_type, participants, start_date, end_date, metrics } = req.body;
  if (!title) return res.status(400).json({ error: '标题不能为空' });

  const id = nextId('joint_campaigns');
  const now = new Date().toISOString();
  const campaign = {
    id, title, description: description||'',
    campaign_type: campaign_type||'cross_promo',
    participants: participants||[], start_date: start_date||'', end_date: end_date||'',
    status: 'planning', metrics: metrics||{},
    created_at: now, updated_at: now
  };
  getDB().joint_campaigns.push(campaign);
  res.status(201).json(campaign);
});

// PUT /campaigns/:id
router.put('/campaigns/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const campaign = (db.joint_campaigns || []).find(r => r.id === id);
  if (!campaign) return res.status(404).json({ error: '活动不存在' });

  ['title','description','campaign_type','participants','start_date','end_date','status','metrics'].forEach(f => {
    if (req.body[f] !== undefined) campaign[f] = req.body[f];
  });
  campaign.updated_at = new Date().toISOString();
  syncRow('joint_campaigns', campaign);
  res.json(campaign);
});

// DELETE /campaigns/:id
router.delete('/campaigns/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.joint_campaigns || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '活动不存在' });
  db.joint_campaigns.splice(idx, 1);
  deleteRows('joint_campaigns', { id });
  res.json({ success: true });
});

// ==================== 引流看板 ====================

// GET /traffic/dashboard — 引流效果看板
router.get('/traffic/dashboard', (req, res) => {
  const db = getDB();
  const records = (db.traffic_records || []).slice();

  // 按客户汇总
  const byClient = {};
  records.forEach(r => {
    if (!byClient[r.from_client_id]) byClient[r.from_client_id] = { imported: 0, received: 0, conversions: 0 };
    if (!byClient[r.to_client_id]) byClient[r.to_client_id] = { imported: 0, received: 0, conversions: 0 };
    byClient[r.from_client_id].imported += r.visitor_count || 0;
    byClient[r.to_client_id].received += r.visitor_count || 0;
    byClient[r.to_client_id].conversions += r.conversion_count || 0;
  });

  // 转成数组并附客户名
  const list = Object.entries(byClient).map(([cid, data]) => {
    const client = (db.clients || []).find(c => c.id === Number(cid));
    return { client_id: Number(cid), client_name: client ? client.name : '未知', ...data };
  }).sort((a,b) => (b.imported + b.received) - (a.imported + a.received));

  // 总计
  const totals = {
    total_visitors: records.reduce((s, r) => s + (r.visitor_count||0), 0),
    total_conversions: records.reduce((s, r) => s + (r.conversion_count||0), 0),
    total_records: records.length
  };

  // 按来源分布
  const bySource = {};
  records.forEach(r => {
    bySource[r.source] = (bySource[r.source]||0) + (r.visitor_count||0);
  });

  res.json({ totals, bySource, clients: list });
});

module.exports = router;
