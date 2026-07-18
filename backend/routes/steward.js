const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

const SERVICE_TYPES = {
  maintenance: '运维订阅',
  consulting: '咨询服务',
  certification: '资质申报',
  finance: '财税法务',
  training: '人力资源',
  supply: '供应链',
  brand: '品牌宣传',
  it: 'IT云基建'
};

// GET / — 企业管家服务列表
router.get('/', (req, res) => {
  const db = getDB();
  let rows = (db.enterprise_services || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const clientId = req.query.clientId;
  if (clientId) rows = rows.filter(r => r.client_id === Number(clientId));
  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);
  res.json({ 
    list: rows.map(r => ({...r, type_label: SERVICE_TYPES[r.service_type]||r.service_type})), 
    total: rows.length 
  });
});

// GET /:id
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const svc = (db.enterprise_services || []).find(r => r.id === id);
  if (!svc) return res.status(404).json({ error: '服务不存在' });
  res.json({ ...svc, type_label: SERVICE_TYPES[svc.service_type]||svc.service_type });
});

// POST /
router.post('/', (req, res) => {
  const { client_id, client_name, service_type, service_title, start_date, expire_date, amount, description } = req.body;
  if (!client_id || !service_title) return res.status(400).json({ error: '缺少客户ID或服务标题' });
  const id = nextId('enterprise_services');
  const now = new Date().toISOString();
  const svc = {
    id, client_id, client_name: client_name||'', service_type: service_type||'maintenance',
    service_title, status: 'active', start_date: start_date||'', expire_date: expire_date||'',
    amount: amount||0, description: description||'', created_at: now, updated_at: now
  };
  getDB().enterprise_services.push(svc);
  res.status(201).json(svc);
});

// PUT /:id
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const svc = (db.enterprise_services || []).find(r => r.id === id);
  if (!svc) return res.status(404).json({ error: '服务不存在' });
  ['service_type','service_title','status','start_date','expire_date','amount','description'].forEach(f => {
    if (req.body[f] !== undefined) svc[f] = req.body[f];
  });
  svc.updated_at = new Date().toISOString();
  syncRow('enterprise_services', svc);
  res.json(svc);
});

// DELETE /:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.enterprise_services || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '服务不存在' });
  db.enterprise_services.splice(idx, 1);
  deleteRows('enterprise_services', { id });
  res.json({ success: true });
});

// GET /tickets — 运维工单列表
router.get('/tickets/all', (req, res) => {
  const db = getDB();
  let rows = (db.maintenance_tickets || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const clientId = req.query.clientId;
  if (clientId) rows = rows.filter(r => r.client_id === Number(clientId));
  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);
  res.json({ list: rows, total: rows.length });
});

// POST /tickets — 创建工单
router.post('/tickets', (req, res) => {
  const { client_id, client_name, type, priority, title, description, assignee } = req.body;
  if (!title) return res.status(400).json({ error: '缺少工单标题' });
  const id = nextId('maintenance_tickets');
  const now = new Date().toISOString();
  const ticket = {
    id, client_id: client_id||0, client_name: client_name||'',
    type: type||'bug', priority: priority||'normal',
    title, description: description||'', status: 'open',
    assignee: assignee||'', resolved_at: '', satisfaction: 0,
    created_at: now, updated_at: now
  };
  getDB().maintenance_tickets.push(ticket);
  res.status(201).json(ticket);
});

// PUT /tickets/:id — 更新工单
router.put('/tickets/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const ticket = (db.maintenance_tickets || []).find(r => r.id === id);
  if (!ticket) return res.status(404).json({ error: '工单不存在' });
  ['type','priority','title','description','status','assignee','resolved_at','satisfaction'].forEach(f => {
    if (req.body[f] !== undefined) ticket[f] = req.body[f];
  });
  ticket.updated_at = new Date().toISOString();
  syncRow('maintenance_tickets', ticket);
  res.json(ticket);
});

// GET /stats/overview — 管家服务统计
router.get('/stats/overview', (req, res) => {
  const db = getDB();
  const services = db.enterprise_services || [];
  const tickets = db.maintenance_tickets || [];
  const byType = {};
  services.forEach(s => {
    byType[s.service_type] = (byType[s.service_type] || 0) + 1;
  });
  res.json({
    totalServices: services.length,
    activeServices: services.filter(r => r.status === 'active').length,
    totalRevenue: services.reduce((s,r) => s + (r.amount||0), 0),
    openTickets: tickets.filter(r => r.status === 'open').length,
    totalTickets: tickets.length,
    byType: Object.entries(byType).map(([k,v]) => ({ type: k, label: SERVICE_TYPES[k]||k, count: v }))
  });
});

module.exports = router;
