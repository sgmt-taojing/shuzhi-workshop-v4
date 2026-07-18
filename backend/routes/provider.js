const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

const PROVIDER_TYPES = {digital:'数字化配套',brand:'品牌宣传',certification:'政策资质',finance:'财税法务',hr:'人力资源',it:'IT云基建',supply:'供应链',consulting:'产业咨询'};

// GET / — 服务商列表
router.get('/', (req, res) => {
  const db = getDB();
  let rows = (db.service_providers || []).slice().sort((a,b) => (b.rating||0) - (a.rating||0));
  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);
  res.json({ list: rows.map(r => ({...r, type_label: PROVIDER_TYPES[r.type]||r.type, capabilities: typeof r.capabilities === 'string' ? JSON.parse(r.capabilities||'[]') : (r.capabilities||[])})), total: rows.length });
});

// GET /:id — 详情含产品
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const provider = (db.service_providers || []).find(r => r.id === id);
  if (!provider) return res.status(404).json({ error: '服务商不存在' });
  const products = (db.provider_products || []).filter(r => r.provider_id === id);
  // 计算履约指标
  const completionRate = provider.total_orders > 0 ? Math.round(provider.completed_orders / provider.total_orders * 100) : 100;
  const complaintRate = provider.total_orders > 0 ? Math.round(provider.complaint_count / provider.total_orders * 100) : 0;
  res.json({ 
    ...provider, 
    type_label: PROVIDER_TYPES[provider.type]||provider.type,
    capabilities: typeof provider.capabilities === 'string' ? JSON.parse(provider.capabilities||'[]') : (provider.capabilities||[]),
    products, 
    completionRate, 
    complaintRate 
  });
});

// POST / — 创建服务商
router.post('/', (req, res) => {
  const { name, type, contact_name, contact_phone, description, capabilities } = req.body;
  if (!name) return res.status(400).json({ error: '缺少服务商名称' });
  const id = nextId('service_providers');
  const now = new Date().toISOString();
  const provider = {
    id, name, type: type||'digital', contact_name: contact_name||'', contact_phone: contact_phone||'',
    description: description||'', capabilities: capabilities||[], rating: 5.0,
    total_orders: 0, completed_orders: 0, complaint_count: 0,
    status: 'pending', joined_at: now, created_at: now, updated_at: now
  };
  getDB().service_providers.push(provider);
  res.status(201).json(provider);
});

// PUT /:id
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const provider = (db.service_providers || []).find(r => r.id === id);
  if (!provider) return res.status(404).json({ error: '服务商不存在' });
  ['name','type','contact_name','contact_phone','description','capabilities','rating','total_orders','completed_orders','complaint_count','status'].forEach(f => {
    if (req.body[f] !== undefined) provider[f] = req.body[f];
  });
  provider.updated_at = new Date().toISOString();
  syncRow('service_providers', provider);
  res.json(provider);
});

// DELETE /:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.service_providers || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '服务商不存在' });
  db.service_providers.splice(idx, 1);
  deleteRows('service_providers', { id });
  res.json({ success: true });
});

// GET /:id/products — 服务商产品
router.get('/:id/products', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const rows = (db.provider_products || []).filter(r => r.provider_id === id);
  res.json({ list: rows });
});

// POST /:id/products — 添加产品
router.post('/:id/products', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const provider = (db.service_providers || []).find(r => r.id === id);
  if (!provider) return res.status(404).json({ error: '服务商不存在' });
  const { title, category, price, price_unit, description } = req.body;
  if (!title) return res.status(400).json({ error: '缺少产品名称' });
  const pid = nextId('provider_products');
  const product = {
    id: pid, provider_id: id, provider_name: provider.name,
    title, category: category||'', price: price||0, price_unit: price_unit||'次',
    description: description||'', status: 'active', sales: 0, rating: 5.0,
    created_at: new Date().toISOString()
  };
  db.provider_products.push(product);
  res.status(201).json(product);
});

// 自动净化：低分限流
router.post('/purge', (req, res) => {
  const db = getDB();
  const threshold = 3.5;
  const purged = [];
  (db.service_providers || []).forEach(p => {
    if (p.rating < threshold && p.status === 'active') {
      p.status = 'restricted';
      p.updated_at = new Date().toISOString();
      syncRow('service_providers', p);
      purged.push({ id: p.id, name: p.name, rating: p.rating });
    }
  });
  res.json({ purged, count: purged.length, message: `已自动限流 ${purged.length} 个低分服务商` });
});

// GET /stats/overview
router.get('/stats/overview', (req, res) => {
  const db = getDB();
  const all = db.service_providers || [];
  res.json({
    total: all.length,
    active: all.filter(r => r.status === 'active').length,
    pending: all.filter(r => r.status === 'pending').length,
    restricted: all.filter(r => r.status === 'restricted').length,
    avgRating: all.length ? (all.reduce((s,r) => s + (r.rating||0), 0) / all.length).toFixed(1) : 0,
    totalOrders: all.reduce((s,r) => s + (r.total_orders||0), 0),
    totalProducts: (db.provider_products || []).length
  });
});

module.exports = router;
