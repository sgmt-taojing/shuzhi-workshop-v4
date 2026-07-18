const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

// ==================== 全链条运营看板 ====================

router.get('/dashboard', (req, res) => {
  const db = getDB();
  
  // 项目交付
  const deliveries = db.delivery_tracking || [];
  const projects = db.projects || [];
  
  // 代理商
  const agents = (db.agents || []).filter(a => a.status === 'active');
  const leads = db.agent_leads || [];
  const commissions = db.agent_commissions || [];
  
  // 客户
  const clients = db.clients || [];
  const services = db.enterprise_services || [];
  const tickets = db.maintenance_tickets || [];
  
  // 资金池
  const fundA = (db.fund_pools || []).filter(f => f.pool_type === 'A');
  const fundB = (db.fund_pools || []).filter(f => f.pool_type === 'B');
  
  // 销售漏斗
  const funnel = db.sales_funnel || [];
  
  // 服务商
  const providers = db.service_providers || [];
  
  res.json({
    project: {
      total: projects.length,
      active: projects.filter(p => p.status === 'active').length,
      deliveries: deliveries.length,
      inProgress: deliveries.filter(d => d.acceptance_status === 'pending').length,
      accepted: deliveries.filter(d => d.acceptance_status === 'accepted').length,
      totalContract: deliveries.reduce((s,d) => s + (d.payment_amount||0), 0),
      totalReceived: deliveries.reduce((s,d) => s + (d.payment_received||0), 0),
      avgProgress: deliveries.length ? Math.round(deliveries.reduce((s,d) => s + (d.progress||0), 0) / deliveries.length) : 0
    },
    agent: {
      total: agents.length,
      leads: leads.length,
      lockedLeads: leads.filter(l => l.status === 'locked').length,
      convertedLeads: leads.filter(l => l.status === 'converted').length,
      conversionRate: leads.length ? Math.round(leads.filter(l => l.status === 'converted').length / leads.length * 100) : 0,
      totalCommission: commissions.filter(c => c.status === 'paid').reduce((s,c) => s + (c.commission_amount||0), 0),
      frozenCommission: commissions.filter(c => c.status === 'frozen').reduce((s,c) => s + (c.commission_amount||0), 0),
      topAgents: agents.map(a => ({
        name: a.name, region: a.region,
        leads: leads.filter(l => l.agent_id === a.id).length,
        commission: commissions.filter(c => c.agent_id === a.id && c.status === 'paid').reduce((s,c) => s + (c.commission_amount||0), 0)
      })).sort((a,b) => b.leads - a.leads).slice(0, 5)
    },
    client: {
      total: clients.length,
      withServices: services.length,
      activeServices: services.filter(s => s.status === 'active').length,
      openTickets: tickets.filter(t => t.status === 'open').length,
      serviceRevenue: services.reduce((s,sv) => s + (sv.amount||0), 0),
      satisfactionAvg: clients.length ? '4.6' : '0'
    },
    finance: {
      poolA: { count: fundA.length, total: fundA.reduce((s,f) => s + (f.amount||0), 0) },
      poolB: { count: fundB.length, total: fundB.reduce((s,f) => s + (f.amount||0), 0) },
      receivedRate: deliveries.length ? Math.round(deliveries.reduce((s,d) => s + (d.payment_received||0), 0) / Math.max(deliveries.reduce((s,d) => s + (d.payment_amount||0), 0), 1) * 100) : 0
    },
    funnel: {
      browse: funnel.filter(f => f.stage === 'browse').length,
      contacted: funnel.filter(f => f.stage === 'contacted').length,
      proposal: funnel.filter(f => f.stage === 'proposal').length,
      negotiating: funnel.filter(f => f.stage === 'negotiating').length,
      completed: funnel.filter(f => f.stage === 'completed').length,
      totalAmount: funnel.filter(f => f.stage === 'completed').reduce((s,f) => s + (f.amount||0), 0)
    },
    provider: {
      total: providers.length,
      active: providers.filter(p => p.status === 'active').length,
      avgRating: providers.length ? (providers.reduce((s,p) => s + (p.rating||0), 0) / providers.length).toFixed(1) : '0',
      totalOrders: providers.reduce((s,p) => s + (p.total_orders||0), 0)
    }
  });
});

// ==================== 客户入驻流程 ====================

router.get('/onboarding', (req, res) => {
  const db = getDB();
  let rows = (db.client_onboarding || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  res.json({ list: rows, total: rows.length });
});

router.post('/onboarding', (req, res) => {
  const { client_id, client_name, assigned_consultant, notes } = req.body;
  const id = nextId('client_onboarding');
  const now = new Date().toISOString();
  const record = {
    id, client_id: client_id||0, client_name: client_name||'',
    status: 'step1', step1_basic_info: 0, step2_profile: 0, step3_products: 0,
    step4_gallery: 0, step5_matching: 0,
    assigned_consultant: assigned_consultant||'', notes: notes||'',
    created_at: now, updated_at: now
  };
  getDB().client_onboarding.push(record);
  res.status(201).json(record);
});

router.put('/onboarding/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const rec = (db.client_onboarding || []).find(r => r.id === id);
  if (!rec) return res.status(404).json({ error: '不存在' });
  ['status','step1_basic_info','step2_profile','step3_products','step4_gallery','step5_matching','assigned_consultant','notes'].forEach(f => {
    if (req.body[f] !== undefined) rec[f] = req.body[f];
  });
  rec.updated_at = new Date().toISOString();
  syncRow('client_onboarding', rec);
  res.json(rec);
});

// ==================== 营销素材中心 ====================

router.get('/materials', (req, res) => {
  const db = getDB();
  let rows = (db.marketing_materials || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const type = req.query.type;
  if (type) rows = rows.filter(r => r.type === type);
  res.json({ list: rows, total: rows.length });
});

router.post('/materials', (req, res) => {
  const { title, type, category, content, file_url, product_id, product_title } = req.body;
  if (!title) return res.status(400).json({ error: '缺少标题' });
  const id = nextId('marketing_materials');
  const mat = {
    id, title, type: type||'article', category: category||'',
    content: content||'', file_url: file_url||'',
    product_id: product_id||0, product_title: product_title||'',
    views: 0, downloads: 0, status: 'active',
    created_at: new Date().toISOString()
  };
  getDB().marketing_materials.push(mat);
  res.status(201).json(mat);
});

router.put('/materials/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const mat = (db.marketing_materials || []).find(r => r.id === id);
  if (!mat) return res.status(404).json({ error: '不存在' });
  ['title','type','category','content','file_url','product_id','product_title','status'].forEach(f => {
    if (req.body[f] !== undefined) mat[f] = req.body[f];
  });
  syncRow('marketing_materials', mat);
  res.json(mat);
});

router.delete('/materials/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.marketing_materials || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '不存在' });
  db.marketing_materials.splice(idx, 1);
  deleteRows('marketing_materials', { id });
  res.json({ success: true });
});

// ==================== 销售漏斗 ====================

router.get('/funnel', (req, res) => {
  const db = getDB();
  let rows = (db.sales_funnel || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const stage = req.query.stage;
  if (stage) rows = rows.filter(r => r.stage === stage);
  res.json({ list: rows, total: rows.length });
});

router.post('/funnel', (req, res) => {
  const { client_id, client_name, product_id, product_title, stage, stage_label, amount, source, notes } = req.body;
  const id = nextId('sales_funnel');
  const now = new Date().toISOString();
  const record = {
    id, client_id: client_id||0, client_name: client_name||'',
    product_id: product_id||0, product_title: product_title||'',
    stage: stage||'browse', stage_label: stage_label||'浏览关注',
    amount: amount||0, source: source||'', notes: notes||'',
    created_at: now, updated_at: now
  };
  getDB().sales_funnel.push(record);
  res.status(201).json(record);
});

router.put('/funnel/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const rec = (db.sales_funnel || []).find(r => r.id === id);
  if (!rec) return res.status(404).json({ error: '不存在' });
  ['stage','stage_label','amount','source','notes'].forEach(f => {
    if (req.body[f] !== undefined) rec[f] = req.body[f];
  });
  rec.updated_at = new Date().toISOString();
  syncRow('sales_funnel', rec);
  res.json(rec);
});

router.delete('/funnel/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.sales_funnel || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '不存在' });
  db.sales_funnel.splice(idx, 1);
  deleteRows('sales_funnel', { id });
  res.json({ success: true });
});

// ==================== 客户画像 ====================

router.get('/client-portrait/:clientId', (req, res) => {
  const id = Number(req.params.clientId);
  const db = getDB();
  const client = (db.clients || []).find(c => c.id === id);
  if (!client) return res.status(404).json({ error: '客户不存在' });
  
  const profile = (db.enterprise_profiles || []).find(p => p.client_id === id);
  const certs = (db.enterprise_certificates || []).filter(c => c.client_id === id);
  const services = (db.enterprise_services || []).filter(s => s.client_id === id);
  const tickets = (db.maintenance_tickets || []).filter(t => t.client_id === id);
  const products = (db.client_products || []).filter(p => p.client_id == id || p.client_name === client.name);
  const orders = (db.orders || []).filter(o => o.buyer_name === client.name);
  const funnel = (db.sales_funnel || []).filter(f => f.client_id === id);
  const onboarding = (db.client_onboarding || []).find(o => o.client_id === id);
  const gallery = (db.brand_galleries || []).find(g => g.client_id === id);
  
  // 计算画像分数
  const transactionScore = Math.min(100, orders.length * 20 + products.length * 5);
  const activityScore = Math.min(100, services.length * 15 + tickets.length * 5);
  const satisfactionScore = tickets.length ? Math.round(100 - tickets.filter(t => t.status === 'open').length / tickets.length * 30) : 80;
  const loyaltyScore = profile ? Math.min(100, (profile.contract_fulfillment_rate || 0)) : 50;
  const referralScore = Math.min(100, funnel.filter(f => f.source === '老客户推荐').length * 20);
  
  res.json({
    client, profile, certs, services, tickets, products, orders, funnel, onboarding, gallery,
    portrait: {
      transaction: transactionScore,
      activity: activityScore,
      satisfaction: satisfactionScore,
      loyalty: loyaltyScore,
      referral: referralScore,
      overall: Math.round((transactionScore + activityScore + satisfactionScore + loyaltyScore + referralScore) / 5)
    }
  });
});

module.exports = router;
