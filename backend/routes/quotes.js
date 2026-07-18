/**
 * 报价计算器 API 路由
 * POST /api/quotes  — 保存报价方案
 * GET  /api/quotes  — 查询报价列表（管理端）
 * GET  /api/quotes/:id — 查询报价详情
 */
const { getDB, nextId, syncRow } = require('../models/db');
const router = require('express').Router();

// ─────────────────────────────────────────
//  POST /api/quotes — 保存报价方案
// ─────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    name, phone, company, remark,
    productId, productTitle,
    edition, editionName,
    userCount,
    modules,        // [{id, name, price}]
    timeline, timelineName,
    totalPrice,
    basePrice, editionPrice, modulesPrice, userSurcharge, timelineSurcharge
  } = req.body;

  // 基础校验
  if (!name || !phone) {
    return res.status(400).json({ error: '请填写姓名和手机号' });
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ error: '手机号格式不正确' });
  }
  if (!productTitle || !totalPrice) {
    return res.status(400).json({ error: '缺少产品或报价信息' });
  }

  const db = getDB();
  if (!db.quotes) db.quotes = [];

  const quote = {
    id: nextId('quotes'),
    name: name.trim(),
    phone: phone.trim(),
    company: (company || '').trim(),
    remark: (remark || '').trim(),
    // 报价详情
    product_id: productId || 0,
    product_title: productTitle,
    edition: edition || 'standard',
    edition_name: editionName || '',
    user_count: userCount || 10,
    modules: JSON.stringify(modules || []),
    timeline: timeline || 'standard',
    timeline_name: timelineName || '',
    // 价格明细
    base_price: basePrice || 0,
    edition_price: editionPrice || 0,
    modules_price: modulesPrice || 0,
    user_surcharge: userSurcharge || 0,
    timeline_surcharge: timelineSurcharge || 0,
    total_price: totalPrice || 0,
    // 状态管理
    status: 'new',  // new / contacted / converted / lost
    lead_source: 'quote_calculator',
    assigned_to: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.quotes.unshift(quote);

  // 同时写入 contacts 表作为线索
  if (db.contacts) {
    const contactItem = {
      id: nextId('contacts'),
      name: name.trim(),
      company: (company || '').trim(),
      phone: phone.trim(),
      industry: '',
      demand: `【报价计算器】${productTitle} ${editionName} ${userCount}人 | 预估价: ¥${totalPrice.toLocaleString()} | ${remark || ''}`,
      status: 'new',
      lead_source: 'quote_calculator',
      lead_score: 30,  // 报价计算器线索评分较高
      assigned_to: '',
      next_followup_date: '',
      converted_at: '',
      converted_order_id: 0,
      lost_reason: '',
      template_msg_sent: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.contacts.unshift(contactItem);
  }

  console.log(`[报价计算器] ✅ 新报价: ${name} / ${productTitle} / ¥${totalPrice}`);

  res.json({
    success: true,
    quote_id: quote.id,
    message: '报价方案已保存，顾问将在24小时内联系您'
  });
});

// ─────────────────────────────────────────
//  GET /api/quotes — 查询报价列表
// ─────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDB();
  if (!db.quotes) return res.json([]);

  const { status, page = 1, pageSize = 20 } = req.query;
  let list = db.quotes;

  if (status) {
    list = list.filter(q => q.status === status);
  }

  const total = list.length;
  const start = (page - 1) * pageSize;
  const items = list.slice(start, start + Number(pageSize));

  res.json({
    total,
    page: Number(page),
    pageSize: Number(pageSize),
    items
  });
});

// ─────────────────────────────────────────
//  GET /api/quotes/:id — 报价详情
// ─────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db = getDB();
  if (!db.quotes) return res.status(404).json({ error: '报价记录不存在' });

  const quote = db.quotes.find(q => q.id === Number(req.params.id));
  if (!quote) return res.status(404).json({ error: '报价记录不存在' });

  // 解析 modules JSON
  let modules = [];
  try { modules = JSON.parse(quote.modules || '[]'); } catch (e) {}

  res.json({ ...quote, modules });
});

// ─────────────────────────────────────────
//  PATCH /api/quotes/:id — 更新报价状态
// ─────────────────────────────────────────
router.patch('/:id', (req, res) => {
  const db = getDB();
  if (!db.quotes) return res.status(404).json({ error: '报价记录不存在' });

  const quote = db.quotes.find(q => q.id === Number(req.params.id));
  if (!quote) return res.status(404).json({ error: '报价记录不存在' });

  const { status, assigned_to } = req.body;
  if (status) quote.status = status;
  if (assigned_to) quote.assigned_to = assigned_to;
  quote.updated_at = new Date().toISOString();

  res.json({ success: true, quote });
});

module.exports = router;
