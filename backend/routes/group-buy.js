const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

const TYPE_MAP = { welfare:'企业福利', canteen:'食堂', supply:'供销社', poverty:'扶贫机构' };

// GET /buyers — 采购方列表
router.get('/buyers', (req, res) => {
  const db = getDB();
  let rows = (db.group_buyers || []).slice();
  const type = req.query.type;
  if (type && type !== 'all') rows = rows.filter(r => r.type === type);
  res.json({ list: rows.map(r => ({...r, type_label: TYPE_MAP[r.type]||r.type})), total: rows.length });
});

// GET /buys — 团购活动列表
router.get('/buys', (req, res) => {
  const db = getDB();
  let rows = (db.group_buys || []).filter(r => r.status === 'open').sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  
  const type = req.query.type;
  if (type && type !== 'all') rows = rows.filter(r => r.buyer_type === type);
  
  const pov = req.query.poverty;
  if (pov === '1') rows = rows.filter(r => r.poverty_alleviation === 1);
  
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const list = rows.slice((page-1)*limit, page*limit).map(r => ({
    ...r,
    buyer_type_label: TYPE_MAP[r.buyer_type]||r.buyer_type,
    discount: r.original_price > 0 ? Math.round((1 - r.group_price / r.original_price) * 100) : 0,
    progress: r.min_qty > 0 ? Math.min(100, Math.round(r.current_qty / r.min_qty * 100)) : 0
  }));
  
  res.json({ list, total, page, limit });
});

// GET /buys/:id — 团购详情
router.get('/buys/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const gb = (db.group_buys || []).find(r => r.id === id);
  if (!gb) return res.status(404).json({ error: '团购不存在' });
  
  // 获取参团记录
  const orders = (db.group_buy_orders || []).filter(r => r.group_buy_id === id);
  
  // 获取产品信息
  const product = (db.client_products || []).find(p => p.id === gb.product_id);
  
  res.json({
    ...gb,
    buyer_type_label: TYPE_MAP[gb.buyer_type]||gb.buyer_type,
    discount: gb.original_price > 0 ? Math.round((1 - gb.group_price / gb.original_price) * 100) : 0,
    progress: gb.min_qty > 0 ? Math.min(100, Math.round(gb.current_qty / gb.min_qty * 100)) : 0,
    orders: orders.map(o => ({...o, cert_no: o.cert_no ? o.cert_no.slice(0,10)+'...' : ''})),
    product
  });
});

// POST /buys — 创建团购
router.post('/buys', (req, res) => {
  const { title, description, product_id, product_title, unit_price, original_price, group_price, min_qty, max_qty, buyer_id, buyer_name, buyer_type, end_date, poverty_alleviation, donation_enabled, donation_percent, donation_org, origin, tags } = req.body;
  if (!title || !product_id) return res.status(400).json({ error: '缺少标题或产品ID' });
  
  const id = nextId('group_buys');
  const now = new Date().toISOString();
  const gb = {
    id, title, description: description||'',
    product_id, product_title: product_title||'',
    unit_price: unit_price||0, original_price: original_price||0, group_price: group_price||0,
    min_qty: min_qty||10, max_qty: max_qty||0, current_qty: 0,
    buyer_id: buyer_id||0, buyer_name: buyer_name||'', buyer_type: buyer_type||'enterprise',
    status: 'open', start_date: now.slice(0,10), end_date: end_date||'',
    poverty_alleviation: poverty_alleviation||0, donation_enabled: donation_enabled||0,
    donation_percent: donation_percent||0, donation_org: donation_org||'',
    origin: origin||'', tags: tags||[],
    participants: 0, created_at: now, updated_at: now
  };
  getDB().group_buys.push(gb);
  res.status(201).json(gb);
});

// POST /buys/:id/join — 参团
router.post('/buys/:id/join', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const gb = (db.group_buys || []).find(r => r.id === id);
  if (!gb) return res.status(404).json({ error: '团购不存在' });
  if (gb.status !== 'open') return res.status(400).json({ error: '团购已结束' });
  
  const { buyer_name, buyer_phone, buyer_org, quantity, remark } = req.body;
  const qty = quantity || 1;
  if (!buyer_name || !buyer_phone) return res.status(400).json({ error: '缺少姓名或电话' });
  
  // 检查库存
  if (gb.max_qty > 0 && gb.current_qty + qty > gb.max_qty) {
    return res.status(400).json({ error: '超过团购上限' });
  }
  
  const totalPrice = Math.round(gb.group_price * qty * 100) / 100;
  const orderId = nextId('group_buy_orders');
  const now = new Date().toISOString();
  
  // 慈善证书
  let certNo = '';
  if (gb.donation_enabled === 1 && gb.donation_percent > 0) {
    certNo = 'CERT' + Date.now() + Math.floor(Math.random() * 10000);
  }
  
  const order = {
    id: orderId, group_buy_id: id,
    buyer_name, buyer_phone, buyer_org: buyer_org||'',
    quantity: qty, unit_price: gb.group_price, total_price: totalPrice,
    status: 'joined', remark: remark||'', cert_no: certNo,
    created_at: now
  };
  db.group_buy_orders.push(order);
  
  // 更新团购数量
  gb.current_qty = (gb.current_qty || 0) + qty;
  gb.participants = (gb.participants || 0) + 1;
  gb.updated_at = now;
  syncRow('group_buys', gb);
  
  // 如果有慈善捐赠，签发证书
  let certificate = null;
  if (certNo) {
    const certId = nextId('charity_certificates');
    const donationAmount = Math.round(totalPrice * (gb.donation_percent || 0) / 100 * 100) / 100;
    const messages = [
      '感谢您的善心义举，您的慷慨捐赠正在帮助需要帮助的人。',
      '一份爱心，一份温暖。感谢您对公益事业的支持！',
      '扶贫助农，大爱无疆。感谢您为乡村振兴贡献力量！',
      '爱心传递，温暖同行。感谢您的慈善之举！'
    ];
    certificate = {
      id: certId, cert_no: certNo,
      order_id: orderId, order_no: 'GROUP' + orderId,
      buyer_name, buyer_phone,
      product_title: gb.product_title,
      product_origin: gb.origin || '',
      donation_amount: donationAmount,
      donation_percent: gb.donation_percent || 0,
      donation_org: gb.donation_org || '',
      poverty_alleviation: gb.poverty_alleviation || 0,
      message: messages[certId % messages.length],
      issued_at: now, created_at: now
    };
    db.charity_certificates.push(certificate);
    
    // 更新慈善机构总额
    if (donationAmount > 0 && gb.donation_org) {
      const org = (db.charity_orgs || []).find(o => o.name === gb.donation_org);
      if (org) {
        org.total_raised = (org.total_raised || 0) + donationAmount;
        syncRow('charity_orgs', org);
      }
    }
  }
  
  res.status(201).json({
    order,
    group_buy: { current_qty: gb.current_qty, participants: gb.participants, progress: gb.min_qty > 0 ? Math.min(100, Math.round(gb.current_qty / gb.min_qty * 100)) : 0 },
    certificate
  });
});

// GET /stats — 团购统计
router.get('/stats', (req, res) => {
  const db = getDB();
  const buys = (db.group_buys || []).filter(r => r.status === 'open');
  const orders = db.group_buy_orders || [];
  const buyers = (db.group_buyers || []).filter(r => r.status === 'active');
  
  const byType = {};
  buys.forEach(b => {
    byType[b.buyer_type] = (byType[b.buyer_type] || 0) + 1;
  });
  
  res.json({
    activeBuys: buys.length,
    totalParticipants: orders.length,
    totalQty: orders.reduce((s, o) => s + (o.quantity || 0), 0),
    totalAmount: orders.reduce((s, o) => s + (o.total_price || 0), 0),
    activeBuyers: buyers.length,
    byType: Object.entries(byType).map(([k, v]) => ({ type: k, label: TYPE_MAP[k]||k, count: v }))
  });
});

module.exports = router;
