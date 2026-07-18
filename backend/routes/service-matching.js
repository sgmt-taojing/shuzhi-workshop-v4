const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

// ==================== 常量 ====================
const DEMAND_STATUS = { open:'待匹配', matched:'已匹配', closed:'已关闭', cancelled:'已取消' };
const OFFER_STATUS = { active:'上架中', inactive:'已下架', draft:'草稿' };
const MATCH_STATUS = { suggested:'推荐中', viewed:'已查看', accepted:'已接受', rejected:'已拒绝' };
const CATEGORIES = ['digital','consulting','development','operations','security','training','other'];
const CAT_MAP = { digital:'数字化转型', consulting:'咨询服务', development:'软件开发', operations:'运维服务', security:'信息安全', training:'培训服务', other:'其他' };

// ==================== 统计 ====================
router.get('/stats/overview', (req, res) => {
  const db = getDB();
  const demands = (db.service_demands || []).filter(d => d.status !== 'cancelled');
  const offers = (db.service_offers || []).filter(o => o.status !== 'inactive');
  const matches = db.service_matches || [];
  res.json({
    demands: {
      total: demands.length,
      open: demands.filter(d => d.status === 'open').length,
      matched: demands.filter(d => d.status === 'matched').length,
      closed: demands.filter(d => d.status === 'closed').length
    },
    offers: {
      total: offers.length,
      active: offers.filter(o => o.status === 'active').length
    },
    matches: {
      total: matches.length,
      suggested: matches.filter(m => m.status === 'suggested').length,
      accepted: matches.filter(m => m.status === 'accepted').length,
      rejected: matches.filter(m => m.status === 'rejected').length
    }
  });
});

// ==================== 需求 CRUD ====================
router.get('/demands', (req, res) => {
  const db = getDB();
  let rows = (db.service_demands || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);

  const category = req.query.category;
  if (category && category !== 'all') rows = rows.filter(r => r.category === category);

  const search = req.query.search;
  if (search) {
    const kw = search.toLowerCase();
    rows = rows.filter(r => (r.title||'').toLowerCase().includes(kw) || (r.description||'').toLowerCase().includes(kw));
  }

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const list = rows.slice((page-1)*limit, page*limit).map(r => ({...r, status_label: DEMAND_STATUS[r.status]||r.status, category_label: CAT_MAP[r.category]||r.category}));

  res.json({ list, total, page, limit });
});

router.get('/demands/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const demand = (db.service_demands || []).find(r => r.id === id);
  if (!demand) return res.status(404).json({ error: '需求不存在' });

  // 找匹配的服务
  const matches = (db.service_matches || []).filter(m => m.demand_id === id);
  const matchedOffers = matches.map(m => {
    const offer = (db.service_offers || []).find(o => o.id === m.offer_id);
    return offer ? {...offer, match_score: m.match_score, match_status: m.status, match_reasons: m.match_reasons} : null;
  }).filter(Boolean);

  res.json({...demand, status_label: DEMAND_STATUS[demand.status]||demand.status, category_label: CAT_MAP[demand.category]||demand.category, matched_offers: matchedOffers});
});

router.post('/demands', (req, res) => {
  const { user_id, user_name, title, category, budget_min, budget_max, description, requirements, deadline, location } = req.body;
  if (!title) return res.status(400).json({ error: '标题不能为空' });

  const id = nextId('service_demands');
  const now = new Date().toISOString();
  const demand = {
    id, user_id: user_id||0, user_name: user_name||'',
    title, category: category||'other',
    budget_min: budget_min||0, budget_max: budget_max||0,
    description: description||'', requirements: requirements||[],
    deadline: deadline||'', location: location||'',
    status: 'open', matched_service_id: 0, view_count: 0,
    created_at: now, updated_at: now
  };
  getDB().service_demands.push(demand);
  res.status(201).json({...demand, status_label: DEMAND_STATUS[demand.status], category_label: CAT_MAP[demand.category]||demand.category});
});

router.put('/demands/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const demand = (db.service_demands || []).find(r => r.id === id);
  if (!demand) return res.status(404).json({ error: '需求不存在' });

  ['title','category','budget_min','budget_max','description','requirements','deadline','location','status','matched_service_id'].forEach(f => {
    if (req.body[f] !== undefined) demand[f] = req.body[f];
  });
  demand.updated_at = new Date().toISOString();
  syncRow('service_demands', demand);
  res.json({...demand, status_label: DEMAND_STATUS[demand.status], category_label: CAT_MAP[demand.category]||demand.category});
});

router.delete('/demands/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.service_demands || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '需求不存在' });
  db.service_demands.splice(idx, 1);
  deleteRows('service_demands', { id });
  // 同时删除关联匹配
  const oldMatches = (db.service_matches || []).filter(m => m.demand_id === id);
  oldMatches.forEach(m => deleteRows('service_matches', { id: m.id }));
  db.service_matches = (db.service_matches || []).filter(m => m.demand_id !== id);
  res.json({ success: true });
});

// ==================== 服务供给 CRUD ====================
router.get('/offers', (req, res) => {
  const db = getDB();
  let rows = (db.service_offers || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);

  const category = req.query.category;
  if (category && category !== 'all') rows = rows.filter(r => r.category === category);

  const search = req.query.search;
  if (search) {
    const kw = search.toLowerCase();
    rows = rows.filter(r => (r.title||'').toLowerCase().includes(kw) || (r.description||'').toLowerCase().includes(kw));
  }

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const list = rows.slice((page-1)*limit, page*limit).map(r => ({...r, status_label: OFFER_STATUS[r.status]||r.status, category_label: CAT_MAP[r.category]||r.category}));

  res.json({ list, total, page, limit });
});

router.get('/offers/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const offer = (db.service_offers || []).find(r => r.id === id);
  if (!offer) return res.status(404).json({ error: '服务不存在' });
  res.json({...offer, status_label: OFFER_STATUS[offer.status]||offer.status, category_label: CAT_MAP[offer.category]||offer.category});
});

router.post('/offers', (req, res) => {
  const { client_id, client_name, title, category, price, price_unit, description, capabilities, cases } = req.body;
  if (!title) return res.status(400).json({ error: '标题不能为空' });

  const id = nextId('service_offers');
  const now = new Date().toISOString();
  const offer = {
    id, client_id: client_id||0, client_name: client_name||'',
    title, category: category||'other',
    price: price||0, price_unit: price_unit||'次',
    description: description||'', capabilities: capabilities||[], cases: cases||[],
    status: 'active', rating: 0, view_count: 0,
    created_at: now, updated_at: now
  };
  getDB().service_offers.push(offer);
  res.status(201).json({...offer, status_label: OFFER_STATUS[offer.status], category_label: CAT_MAP[offer.category]||offer.category});
});

router.put('/offers/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const offer = (db.service_offers || []).find(r => r.id === id);
  if (!offer) return res.status(404).json({ error: '服务不存在' });

  ['title','category','price','price_unit','description','capabilities','cases','status','rating'].forEach(f => {
    if (req.body[f] !== undefined) offer[f] = req.body[f];
  });
  offer.updated_at = new Date().toISOString();
  syncRow('service_offers', offer);
  res.json({...offer, status_label: OFFER_STATUS[offer.status], category_label: CAT_MAP[offer.category]||offer.category});
});

router.delete('/offers/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.service_offers || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '服务不存在' });
  db.service_offers.splice(idx, 1);
  deleteRows('service_offers', { id });
  const oldMatches = (db.service_matches || []).filter(m => m.offer_id === id);
  oldMatches.forEach(m => deleteRows('service_matches', { id: m.id }));
  db.service_matches = (db.service_matches || []).filter(m => m.offer_id !== id);
  res.json({ success: true });
});

// ==================== 智能匹配 ====================
// POST /matches/suggest/:demandId — 为需求生成匹配推荐
router.post('/matches/suggest/:demandId', (req, res) => {
  const demandId = Number(req.params.demandId);
  const db = getDB();
  const demand = (db.service_demands || []).find(r => r.id === demandId);
  if (!demand) return res.status(404).json({ error: '需求不存在' });

  const offers = (db.service_offers || []).filter(o => o.status === 'active');

  // 匹配算法：分类匹配(40) + 预算匹配(30) + 关键词匹配(30)
  const matches = offers.map(offer => {
    let score = 0;
    const reasons = [];

    // 分类匹配
    if (demand.category && offer.category === demand.category) {
      score += 40;
      reasons.push('服务类别匹配');
    }

    // 预算匹配
    if (demand.budget_max > 0 && offer.price > 0) {
      if (offer.price >= demand.budget_min && offer.price <= demand.budget_max) {
        score += 30;
        reasons.push('价格在预算范围内');
      } else if (offer.price < demand.budget_min) {
        score += 15;
        reasons.push('价格低于预算');
      }
    } else {
      score += 10;
    }

    // 关键词匹配
    const demandWords = (demand.title + ' ' + demand.description).toLowerCase().split(/\s+/);
    const offerWords = (offer.title + ' ' + offer.description).toLowerCase();
    const matched = demandWords.filter(w => w.length > 1 && offerWords.includes(w));
    if (matched.length > 0) {
      score += Math.min(matched.length * 10, 30);
      reasons.push('关键词匹配: ' + matched.slice(0,3).join('、'));
    }

    return { offer, score: Math.min(score, 100), reasons };
  }).filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);

  // 保存匹配记录
  matches.forEach(m => {
    const exist = (db.service_matches || []).find(r => r.demand_id === demandId && r.offer_id === m.offer.id);
    if (!exist) {
      const mid = nextId('service_matches');
      const now = new Date().toISOString();
      const match = {
        id: mid, demand_id: demandId, offer_id: m.offer.id,
        match_score: m.score, match_reasons: m.reasons,
        status: 'suggested', created_at: now, updated_at: now
      };
      db.service_matches.push(match);
    } else {
      exist.match_score = m.score;
      exist.match_reasons = m.reasons;
      syncRow('service_matches', exist);
    }
  });

  res.json({
    demand: {...demand, status_label: DEMAND_STATUS[demand.status], category_label: CAT_MAP[demand.category]||demand.category},
    matches: matches.map(m => ({
      ...m.offer,
      match_score: m.score,
      match_reasons: m.reasons,
      category_label: CAT_MAP[m.offer.category]||m.offer.category
    }))
  });
});

// PUT /matches/:id — 更新匹配状态
router.put('/matches/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const match = (db.service_matches || []).find(r => r.id === id);
  if (!match) return res.status(404).json({ error: '匹配记录不存在' });

  const { status } = req.body;
  if (!['suggested','viewed','accepted','rejected'].includes(status)) {
    return res.status(400).json({ error: '无效状态' });
  }

  match.status = status;
  match.updated_at = new Date().toISOString();
  syncRow('service_matches', match);

  // 如果接受匹配，更新需求状态
  if (status === 'accepted') {
    const demand = (db.service_demands || []).find(r => r.id === match.demand_id);
    if (demand) {
      demand.status = 'matched';
      demand.matched_service_id = match.offer_id;
      demand.updated_at = new Date().toISOString();
      syncRow('service_demands', demand);
    }
  }

  res.json({...match, status_label: MATCH_STATUS[match.status]||match.status});
});

// GET /matches — 匹配列表
router.get('/matches', (req, res) => {
  const db = getDB();
  let rows = (db.service_matches || []).slice().sort((a,b) => (b.match_score||0) - (a.match_score||0));

  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);

  const demandId = req.query.demandId;
  if (demandId) rows = rows.filter(r => r.demand_id === Number(demandId));

  const list = rows.map(r => {
    const demand = (db.service_demands || []).find(d => d.id === r.demand_id);
    const offer = (db.service_offers || []).find(o => o.id === r.offer_id);
    return {
      ...r,
      status_label: MATCH_STATUS[r.status]||r.status,
      demand_title: demand ? demand.title : '',
      offer_title: offer ? offer.title : '',
      offer_client: offer ? offer.client_name : '',
      offer_price: offer ? offer.price : 0
    };
  });

  res.json({ list, total: list.length });
});

module.exports = router;
