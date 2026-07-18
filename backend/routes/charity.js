const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

// GET /orgs — 慈善机构列表
router.get('/orgs', (req, res) => {
  const db = getDB();
  const rows = (db.charity_orgs || []).filter(r => r.status === 'active');
  res.json({ list: rows, total: rows.length });
});

// GET /products — 慈善捐赠产品列表
router.get('/products', (req, res) => {
  const db = getDB();
  const all = (db.client_products || []).filter(r => r.published && r.donation_enabled === 1);
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = all.length;
  const list = all.slice((page - 1) * limit, page * limit);
  const totalDonation = all.reduce((s, p) => s + (p.sales || 0) * (p.price || 0) * (p.donation_percent || 0) / 100, 0);
  res.json({ list, total, page, limit, totalDonation: Math.round(totalDonation) });
});

// GET /dashboard — 慈善捐赠概览
router.get('/dashboard', (req, res) => {
  const db = getDB();
  const allProducts = (db.client_products || []).filter(r => r.published);
  const donProducts = allProducts.filter(r => r.donation_enabled === 1);
  const povProducts = allProducts.filter(r => r.poverty_alleviation === 1);
  const totalDonation = donProducts.reduce((s, p) => s + (p.sales || 0) * (p.price || 0) * (p.donation_percent || 0) / 100, 0);
  const povSales = povProducts.reduce((s, p) => s + (p.sales || 0) * (p.price || 0), 0);
  const byOrg = {};
  donProducts.forEach(p => {
    const org = p.donation_org || '未指定';
    if (!byOrg[org]) byOrg[org] = { name: org, count: 0, raised: 0 };
    byOrg[org].count++;
    byOrg[org].raised += (p.sales || 0) * (p.price || 0) * (p.donation_percent || 0) / 100;
  });
  const byOrigin = {};
  povProducts.forEach(p => {
    const origin = p.origin || '未知';
    if (!byOrigin[origin]) byOrigin[origin] = { name: origin, count: 0, sales: 0 };
    byOrigin[origin].count++;
    byOrigin[origin].sales += (p.sales || 0) * (p.price || 0);
  });
  const certCount = (db.charity_certificates || []).length;
  res.json({
    donationProducts: donProducts.length,
    povertyProducts: povProducts.length,
    totalDonation: Math.round(totalDonation),
    povertySales: Math.round(povSales),
    certificateCount: certCount,
    orgs: Object.values(byOrg).map(o => ({ ...o, raised: Math.round(o.raised) })).sort((a,b) => b.raised - a.raised),
    origins: Object.values(byOrigin).map(o => ({ ...o, sales: Math.round(o.sales) })).sort((a,b) => b.sales - a.sales)
  });
});

// POST /purchase/:productId — 购买并自动计算捐赠+发放证书
router.post('/purchase/:productId', (req, res) => {
  const productId = Number(req.params.productId);
  const { quantity, buyer_name, buyer_phone } = req.body;
  const qty = quantity || 1;
  
  const db = getDB();
  const product = (db.client_products || []).find(r => r.id === productId && r.published);
  if (!product) return res.status(404).json({ error: '产品不存在' });
  
  const totalPrice = (product.price || 0) * qty;
  const donationAmount = product.donation_enabled === 1 
    ? Math.round(totalPrice * (product.donation_percent || 0) / 100 * 100) / 100
    : 0;
  
  // 更新销量
  product.sales = (product.sales || 0) + qty;
  if (product.stock >= 0) product.stock = Math.max(0, product.stock - qty);
  product.updated_at = new Date().toISOString();
  syncRow('client_products', product);
  
  // 更新慈善机构总额
  if (donationAmount > 0 && product.donation_org) {
    const org = (db.charity_orgs || []).find(o => o.name === product.donation_org);
    if (org) {
      org.total_raised = (org.total_raised || 0) + donationAmount;
      syncRow('charity_orgs', org);
    }
  }
  
  // 创建订单
  const orderId = nextId('orders');
  const now = new Date().toISOString();
  const order = {
    id: orderId,
    order_no: 'MALL' + Date.now() + Math.floor(Math.random() * 1000),
    product_type: 'client_product',
    product_id: productId,
    product_title: product.title,
    amount: totalPrice,
    original_amount: totalPrice,
    discount_amount: 0,
    quantity: qty,
    buyer_name: buyer_name || '',
    buyer_phone: buyer_phone || '',
    status: 'pending',
    refund_status: '',
    created_at: now,
    updated_at: now
  };
  db.orders.push(order);
  
  // 自动发放慈善证书
  let certificate = null;
  if (donationAmount > 0) {
    const certId = nextId('charity_certificates');
    const certNo = 'CERT' + Date.now() + Math.floor(Math.random() * 10000);
    const messages = [
      '感谢您的善心义举，您的慷慨捐赠正在帮助需要帮助的人。',
      '一份爱心，一份温暖。感谢您对公益事业的支持！',
      '您的善举让世界更美好，感谢您的爱心购买！',
      '扶贫助农，大爱无疆。感谢您为乡村振兴贡献力量！',
      '爱心传递，温暖同行。感谢您的慈善之举！'
    ];
    certificate = {
      id: certId, cert_no: certNo,
      order_id: orderId, order_no: order.order_no,
      buyer_name: buyer_name || '爱心人士',
      buyer_phone: buyer_phone || '',
      product_title: product.title,
      product_origin: product.origin || '',
      donation_amount: donationAmount,
      donation_percent: product.donation_percent || 0,
      donation_org: product.donation_org || '',
      poverty_alleviation: product.poverty_alleviation || 0,
      message: messages[certId % messages.length],
      issued_at: now, created_at: now
    };
    db.charity_certificates.push(certificate);
  }
  
  res.status(201).json({
    order,
    donation: {
      enabled: product.donation_enabled === 1,
      amount: donationAmount,
      percent: product.donation_percent || 0,
      org: product.donation_org || '',
      message: donationAmount > 0 
        ? `感谢您的购买！本次订单将向「${product.donation_org}」捐赠 ¥${donationAmount}（销售额的${product.donation_percent}%）`
        : ''
    },
    certificate
  });
});

// GET /certificates — 证书列表
router.get('/certificates', (req, res) => {
  const db = getDB();
  let rows = (db.charity_certificates || []).slice().sort((a,b) => (b.issued_at||'').localeCompare(a.issued_at||''));
  const phone = req.query.phone;
  if (phone) rows = rows.filter(r => r.buyer_phone === phone);
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const list = rows.slice((page-1)*limit, page*limit);
  res.json({ list, total, page, limit });
});

// GET /certificates/:certNo — 证书详情(JSON)
router.get('/certificates/:certNo', (req, res) => {
  const db = getDB();
  const cert = (db.charity_certificates || []).find(r => r.cert_no === req.params.certNo);
  if (!cert) return res.status(404).json({ error: '证书不存在' });
  res.json(cert);
});

// GET /certificates/:certNo/html — 证书HTML页面（可截图/打印）
router.get('/certificates/:certNo/html', (req, res) => {
  const db = getDB();
  const cert = (db.charity_certificates || []).find(r => r.cert_no === req.params.certNo);
  if (!cert) return res.status(404).send('证书不存在');
  
  const date = new Date(cert.issued_at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const isPov = cert.poverty_alleviation === 1;
  
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>慈善捐赠证书 — ${cert.cert_no}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Songti SC','STSong','SimSun',serif;background:#f5f0e6;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.cert{width:100%;max-width:560px;background:#fffdf5;border:6px double #c9a227;border-radius:4px;padding:40px 30px;position:relative;box-shadow:0 4px 20px rgba(201,162,39,.15)}
.cert::before{content:'';position:absolute;top:8px;left:8px;right:8px;bottom:8px;border:1px solid #e6cf8e;pointer-events:none}
.cert-header{text-align:center;margin-bottom:24px}
.cert-icon{font-size:40px;margin-bottom:8px}
.cert-title{font-size:24px;font-weight:700;color:#92400e;letter-spacing:4px}
.cert-subtitle{font-size:12px;color:#a16207;margin-top:6px;letter-spacing:2px}
.cert-body{text-align:center;padding:0 10px}
.cert-name{font-size:20px;font-weight:700;color:#1f2937;margin:16px 0}
.cert-text{font-size:14px;color:#4b5563;line-height:2;text-indent:2em;text-align:left;margin:16px 0}
.cert-highlight{color:#92400e;font-weight:700;font-size:16px}
.cert-amount{font-size:28px;font-weight:700;color:#dc2626;margin:12px 0}
.cert-product{font-size:13px;color:#6b7280;margin:8px 0}
.cert-org{display:inline-block;background:#fef3c7;color:#92400e;padding:4px 16px;border-radius:4px;font-size:13px;margin:8px 0}
.cert-message{font-size:13px;color:#6b7280;font-style:italic;margin:16px 0;padding:12px;background:#fffbeb;border-radius:8px;border-left:3px solid #f59e0b}
.cert-footer{margin-top:24px;text-align:center;border-top:1px solid #e6cf8e;padding-top:16px}
.cert-no{font-size:11px;color:#a16207;letter-spacing:1px}
.cert-date{font-size:12px;color:#6b7280;margin-top:6px}
.cert-seal{width:70px;height:70px;border:2px solid #dc2626;border-radius:50%;color:#dc2626;font-size:12px;line-height:1.2;display:flex;align-items:center;justify-content:center;text-align:center;margin:12px auto 0;transform:rotate(-10deg);opacity:0.8}
.cert-tags{display:flex;justify-content:center;gap:8px;margin:8px 0}
.cert-tag{font-size:11px;padding:2px 10px;border-radius:3px}
.tag-pov{background:#fee2e2;color:#dc2626}
</style></head><body>
<div class="cert">
  <div class="cert-header">
    <div class="cert-icon">${isPov ? '🌾' : '❤️'}</div>
    <div class="cert-title">慈 善 捐 赠 证 书</div>
    <div class="cert-subtitle">CHARITY DONATION CERTIFICATE</div>
  </div>
  <div class="cert-body">
    <div class="cert-name">${cert.buyer_name}</div>
    <div class="cert-text">
      感谢您购买${isPov ? '扶贫助农' : ''}产品「<span class="cert-highlight">${cert.product_title}</span>」${cert.product_origin ? '（产地：'+cert.product_origin+'）' : ''}，您的爱心之举产生了<span class="cert-highlight">${cert.donation_percent}%</span>的慈善捐赠。
    </div>
    <div class="cert-amount">¥ ${cert.donation_amount}</div>
    <div class="cert-product">捐赠已汇至</div>
    <div class="cert-org">${cert.donation_org}</div>
    ${isPov ? '<div class="cert-tags"><span class="cert-tag tag-pov">🚜 扶贫助农</span></div>' : ''}
    <div class="cert-message">${cert.message}</div>
  </div>
  <div class="cert-footer">
    <div class="cert-seal">数智工坊<br>慈善公益</div>
    <div class="cert-no">证书编号：${cert.cert_no}</div>
    <div class="cert-date">签发日期：${date}</div>
  </div>
</div>
</body></html>`);
});

module.exports = router;
