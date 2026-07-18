const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

// ==================== 资金池 ====================

// GET /pools — 资金池列表（代理商端自动屏蔽B池）
router.get('/pools', (req, res) => {
  const db = getDB();
  let rows = (db.fund_pools || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  
  // 代理商视角：屏蔽资金池B
  const agentView = req.query.agentView === 'true';
  if (agentView) rows = rows.filter(r => r.pool_type === 'A' && r.agent_visible === 1);
  
  const pool = req.query.pool;
  if (pool) rows = rows.filter(r => r.pool_type === pool);
  
  const poolA = rows.filter(r => r.pool_type === 'A');
  const poolB = rows.filter(r => r.pool_type === 'B');
  
  res.json({
    list: rows,
    total: rows.length,
    poolA: {
      count: poolA.length,
      totalAmount: poolA.reduce((s,r) => s + (r.amount||0), 0),
      label: '数字化项目资金池（代理商可分润）'
    },
    poolB: agentView ? null : {
      count: poolB.length,
      totalAmount: poolB.reduce((s,r) => s + (r.amount||0), 0),
      label: '生态增值资金池（代理商无权限）'
    }
  });
});

// POST /pools — 创建资金池记录
router.post('/pools', (req, res) => {
  const { pool_type, order_id, order_no, amount, description, agent_visible } = req.body;
  if (!pool_type || !amount) return res.status(400).json({ error: '缺少资金池类型或金额' });
  const id = nextId('fund_pools');
  const record = {
    id, pool_type, order_id: order_id||0, order_no: order_no||'',
    amount, description: description||'',
    agent_visible: pool_type === 'A' ? 1 : 0,
    status: 'active', created_at: new Date().toISOString()
  };
  getDB().fund_pools.push(record);
  res.status(201).json(record);
});

// GET /pools/dashboard — 资金池看板
router.get('/pools/dashboard', (req, res) => {
  const db = getDB();
  const all = db.fund_pools || [];
  const poolA = all.filter(r => r.pool_type === 'A');
  const poolB = all.filter(r => r.pool_type === 'B');
  
  // 按月统计
  const byMonth = {};
  all.forEach(r => {
    const month = (r.created_at || '').slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { poolA: 0, poolB: 0 };
    if (r.pool_type === 'A') byMonth[month].poolA += r.amount || 0;
    else byMonth[month].poolB += r.amount || 0;
  });
  
  res.json({
    poolA: { count: poolA.length, total: poolA.reduce((s,r) => s + (r.amount||0), 0) },
    poolB: { count: poolB.length, total: poolB.reduce((s,r) => s + (r.amount||0), 0) },
    total: all.reduce((s,r) => s + (r.amount||0), 0),
    byMonth: Object.entries(byMonth).map(([k,v]) => ({ month: k, ...v })).sort((a,b) => b.month.localeCompare(a.month))
  });
});

// ==================== AI诊断 ====================

// GET /diagnoses — 诊断列表
router.get('/diagnoses', (req, res) => {
  const db = getDB();
  let rows = (db.ai_diagnoses || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);
  res.json({ list: rows.map(r => ({
    ...r,
    diagnosis_result: typeof r.diagnosis_result === 'string' ? JSON.parse(r.diagnosis_result || '{}') : (r.diagnosis_result || {}),
    recommended_products: typeof r.recommended_products === 'string' ? JSON.parse(r.recommended_products || '[]') : (r.recommended_products || [])
  })), total: rows.length });
});

// POST /diagnoses — 创建诊断
router.post('/diagnoses', (req, res) => {
  const { client_name, industry, contact_name, contact_phone, demand_desc } = req.body;
  if (!client_name || !demand_desc) return res.status(400).json({ error: '缺少企业名称或需求描述' });
  
  const db = getDB();
  const id = nextId('ai_diagnoses');
  const now = new Date().toISOString();
  
  // AI模拟诊断：根据需求关键词匹配产品
  const allProducts = db.products || [];
  const keywords = {
    'MES': '生产MES系统', '生产': '生产MES系统', '制造': '生产MES系统',
    'ERP': 'ERP数字化全家桶', '财务': '财务管理系统', '进销存': '进销存管理系统',
    'CRM': 'CRM客户管理系统', '客户': 'CRM客户管理系统',
    'OA': 'OA协同办公系统', '办公': 'OA协同办公系统',
    '仓储': 'WMS仓储管理系统', 'WMS': 'WMS仓储管理系统',
    '物流': 'TMS运输管理系统', '运输': 'TMS运输管理系统',
    '数据': 'BI经营驾驶舱', '驾驶舱': 'BI经营驾驶舱',
    '设备': 'IoT设备管理平台', 'IoT': 'IoT设备管理平台',
    '质量': 'QMS质量管理系统',
    '供应商': '供应商协同平台',
    'RPA': 'RPA流程自动化机器人', '自动化': 'RPA流程自动化机器人'
  };
  
  const recommended = [];
  Object.entries(keywords).forEach(([kw, prodName]) => {
    if (demand_desc.includes(kw) && !recommended.find(r => r.title === prodName)) {
      const prod = allProducts.find(p => p.title === prodName);
      if (prod) recommended.push({ id: prod.id, title: prod.title, price: prod.price });
    }
  });
  if (recommended.length === 0) {
    recommended.push({ id: 2, title: 'ERP数字化全家桶', price: 49800 });
  }
  
  const estimatedBudget = recommended.reduce((s, r) => s + (r.price || 0), 0);
  const result = {
    level: demand_desc.length > 50 ? 'urgent' : 'high',
    pain_points: ['企业管理效率低', '数据不透明', '流程不规范'],
    suggestions: recommended.map(r => '部署' + r.title),
    recommended_count: recommended.length
  };
  
  const diagnosis = {
    id, client_name, industry: industry||'', contact_name: contact_name||'', contact_phone: contact_phone||'',
    demand_desc, diagnosis_result: result, recommended_products: recommended,
    estimated_budget: estimatedBudget, status: 'diagnosed', created_at: now
  };
  db.ai_diagnoses.push(diagnosis);
  
  res.status(201).json({
    ...diagnosis,
    message: `AI诊断完成！识别到 ${recommended.length} 个推荐产品，预估预算 ¥${estimatedBudget.toLocaleString()}`
  });
});

module.exports = router;
