const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

const PHASE_MAP = {initiation:'启动',planning:'规划',execution:'执行',monitoring:'监控',closing:'收尾'};
const DELIVERY_PHASES = [
  {key:'requirement', label:'需求调研'},
  {key:'design', label:'方案设计'},
  {key:'contract', label:'合同签订'},
  {key:'development', label:'开发实施'},
  {key:'deployment', label:'部署集成'},
  {key:'testing', label:'测试联调'},
  {key:'training', label:'培训上线'},
  {key:'acceptance', label:'验收交付'}
];

// ==================== 代理商管理 ====================

// GET / — 代理商列表
router.get('/', (req, res) => {
  const db = getDB();
  let rows = (db.agents || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.status === status);
  res.json({ list: rows, total: rows.length });
});

// GET /:id — 代理商详情
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const agent = (db.agents || []).find(r => r.id === id);
  if (!agent) return res.status(404).json({ error: '代理商不存在' });
  
  // 获取关联数据
  const leads = (db.agent_leads || []).filter(r => r.agent_id === id);
  const commissions = (db.agent_commissions || []).filter(r => r.agent_id === id);
  const pushes = (db.agent_product_push || []).filter(r => r.agent_id === id || r.agent_id === 0);
  
  const totalCommission = commissions.filter(c => c.status === 'paid').reduce((s,c) => s + (c.commission_amount||0), 0);
  const frozenCommission = commissions.filter(c => c.status === 'frozen').reduce((s,c) => s + (c.commission_amount||0), 0);
  
  res.json({ ...agent, leads, commissions, pushes, totalCommission, frozenCommission, leadCount: leads.length });
});

// POST / — 创建代理商
router.post('/', (req, res) => {
  const { name, company, phone, wechat, region, description } = req.body;
  if (!name) return res.status(400).json({ error: '缺少代理商姓名' });
  const id = nextId('agents');
  const now = new Date().toISOString();
  const agent = {
    id, name, company: company||'', phone: phone||'', wechat: wechat||'',
    region: region||'', level: 'gold', status: 'pending', annual_fee_status: 'unpaid',
    joined_at: '', expire_at: '', total_projects: 0, total_commission: 0,
    description: description||'', created_at: now, updated_at: now
  };
  getDB().agents.push(agent);
  res.status(201).json(agent);
});

// PUT /:id — 更新代理商
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const agent = (db.agents || []).find(r => r.id === id);
  if (!agent) return res.status(404).json({ error: '代理商不存在' });
  ['name','company','phone','wechat','region','level','status','annual_fee_status','joined_at','expire_at','description'].forEach(f => {
    if (req.body[f] !== undefined) agent[f] = req.body[f];
  });
  agent.updated_at = new Date().toISOString();
  syncRow('agents', agent);
  res.json(agent);
});

// DELETE /:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.agents || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '代理商不存在' });
  db.agents.splice(idx, 1);
  deleteRows('agents', { id });
  res.json({ success: true });
});

// ==================== 客户报备（90天锁客） ====================

// GET /leads — 报备列表
router.get('/leads/all', (req, res) => {
  const db = getDB();
  let rows = (db.agent_leads || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const agentId = req.query.agentId;
  if (agentId) rows = rows.filter(r => r.agent_id === Number(agentId));
  res.json({ list: rows, total: rows.length });
});

// POST /leads — 报备客户（AI查重+90天保护）
router.post('/leads', (req, res) => {
  const { agent_id, agent_name, company_name, contact_name, contact_phone, industry, region, demand_desc } = req.body;
  if (!agent_id || !company_name) return res.status(400).json({ error: '缺少代理商ID或企业名称' });
  
  const db = getDB();
  // 查重：企业名称全局唯一
  const exist = (db.agent_leads || []).find(r => 
    r.company_name === company_name && r.status === 'locked' &&
    new Date(r.lock_expire || '') > new Date()
  );
  if (exist) {
    return res.status(409).json({ error: '该企业已被报备锁定，处于保护期内', existing_agent: exist.agent_name });
  }
  
  const id = nextId('agent_leads');
  const now = new Date().toISOString();
  const lockExpire = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  
  const lead = {
    id, agent_id, agent_name: agent_name||'', company_name,
    contact_name: contact_name||'', contact_phone: contact_phone||'',
    industry: industry||'', region: region||'', demand_desc: demand_desc||'',
    status: 'locked', lock_expire: lockExpire,
    project_id: 0, created_at: now, updated_at: now
  };
  db.agent_leads.push(lead);
  res.status(201).json({ ...lead, message: '报备成功，90天专属保护期至 ' + lockExpire });
});

// PUT /leads/:id — 更新报备状态
router.put('/leads/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const lead = (db.agent_leads || []).find(r => r.id === id);
  if (!lead) return res.status(404).json({ error: '报备记录不存在' });
  ['status','project_id','lock_expire','demand_desc'].forEach(f => {
    if (req.body[f] !== undefined) lead[f] = req.body[f];
  });
  lead.updated_at = new Date().toISOString();
  syncRow('agent_leads', lead);
  res.json(lead);
});

// ==================== 分润管理 ====================

// GET /commissions — 分润列表
router.get('/commissions/all', (req, res) => {
  const db = getDB();
  let rows = (db.agent_commissions || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const agentId = req.query.agentId;
  if (agentId) rows = rows.filter(r => r.agent_id === Number(agentId));
  
  // 计算阶梯分润
  rows = rows.map(r => {
    const amt = r.contract_amount || 0;
    let commission = 0;
    if (amt > 100000) {
      const tier1 = Math.min(amt - 100000, 100000);
      commission += tier1 * 0.30;
      if (amt > 200000) {
        commission += (amt - 200000) * 0.35;
      }
    }
    return { ...r, commission_rate: amt > 200000 ? '35%' : '30%', commission_amount: Math.round(commission) };
  });
  
  const totalPaid = rows.filter(r => r.status === 'paid').reduce((s,r) => s + r.commission_amount, 0);
  const totalFrozen = rows.filter(r => r.status === 'frozen').reduce((s,r) => s + r.commission_amount, 0);
  
  res.json({ list: rows, total: rows.length, totalPaid: Math.round(totalPaid), totalFrozen: Math.round(totalFrozen) });
});

// POST /commissions — 创建分润记录（全额回款触发）
router.post('/commissions', (req, res) => {
  const { agent_id, agent_name, project_id, project_name, contract_amount } = req.body;
  if (!agent_id || !contract_amount) return res.status(400).json({ error: '缺少代理商ID或合同金额' });
  
  const amt = contract_amount;
  let commission = 0;
  if (amt > 100000) {
    const tier1 = Math.min(amt - 100000, 100000);
    commission += tier1 * 0.30;
    if (amt > 200000) commission += (amt - 200000) * 0.35;
  }
  
  const id = nextId('agent_commissions');
  const now = new Date().toISOString();
  const record = {
    id, agent_id, agent_name: agent_name||'',
    project_id: project_id||0, project_name: project_name||'',
    contract_amount: amt,
    commission_rate: amt > 200000 ? 0.35 : 0.30,
    commission_amount: Math.round(commission),
    status: 'frozen', paid_at: '', created_at: now
  };
  getDB().agent_commissions.push(record);
  res.status(201).json(record);
});

// PUT /commissions/:id/settle — 结算分润（全额回款后）
router.put('/commissions/:id/settle', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const record = (db.agent_commissions || []).find(r => r.id === id);
  if (!record) return res.status(404).json({ error: '分润记录不存在' });
  if (record.status === 'paid') return res.status(400).json({ error: '该分润已结算' });
  
  record.status = 'paid';
  record.paid_at = new Date().toISOString();
  syncRow('agent_commissions', record);
  res.json({ ...record, message: '分润已结算' });
});

// ==================== 新品推送 ====================

// GET /push — 推送列表
router.get('/push/all', (req, res) => {
  const db = getDB();
  let rows = (db.agent_product_push || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const agentId = req.query.agentId;
  if (agentId) rows = rows.filter(r => r.agent_id === 0 || r.agent_id === Number(agentId));
  res.json({ list: rows, total: rows.length });
});

// POST /push — 推送新品给代理商
router.post('/push', (req, res) => {
  const { agent_id, agent_name, product_id, product_title, title, content, materials } = req.body;
  if (!title) return res.status(400).json({ error: '缺少推送标题' });
  const id = nextId('agent_product_push');
  const push = {
    id, agent_id: agent_id||0, agent_name: agent_name||'全体代理商',
    product_id: product_id||0, product_title: product_title||'',
    push_type: 'new_product', title, content: content||'',
    materials: materials||[], read_status: 0,
    created_at: new Date().toISOString()
  };
  getDB().agent_product_push.push(push);
  res.status(201).json(push);
});

// PUT /push/:id/read — 标记已读
router.put('/push/:id/read', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const push = (db.agent_product_push || []).find(r => r.id === id);
  if (!push) return res.status(404).json({ error: '推送不存在' });
  push.read_status = 1;
  syncRow('agent_product_push', push);
  res.json({ success: true });
});

// ==================== 代理商统计 ====================
router.get('/stats/overview', (req, res) => {
  const db = getDB();
  const agents = (db.agents || []).filter(r => r.status === 'active');
  const leads = db.agent_leads || [];
  const commissions = db.agent_commissions || [];
  const pushes = db.agent_product_push || [];
  
  res.json({
    totalAgents: (db.agents || []).length,
    activeAgents: agents.length,
    pendingAgents: (db.agents || []).filter(r => r.status === 'pending').length,
    totalLeads: leads.length,
    lockedLeads: leads.filter(r => r.status === 'locked').length,
    totalCommissions: commissions.length,
    paidCommissions: commissions.filter(r => r.status === 'paid').length,
    frozenCommissions: commissions.filter(r => r.status === 'frozen').length,
    totalCommissionAmount: commissions.filter(r => r.status === 'paid').reduce((s,c) => s + (c.commission_amount||0), 0),
    unreadPushes: pushes.filter(r => r.read_status === 0).length
  });
});

module.exports = router;
