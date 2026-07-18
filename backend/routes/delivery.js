const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

const PHASES = [
  {key:'requirement', label:'需求调研'},
  {key:'design', label:'方案设计'},
  {key:'contract', label:'合同签订'},
  {key:'development', label:'开发实施'},
  {key:'deployment', label:'部署集成'},
  {key:'testing', label:'测试联调'},
  {key:'training', label:'培训上线'},
  {key:'acceptance', label:'验收交付'}
];

// GET / — 交付跟踪列表
router.get('/', (req, res) => {
  const db = getDB();
  let rows = (db.delivery_tracking || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const status = req.query.status;
  if (status && status !== 'all') rows = rows.filter(r => r.acceptance_status === status);
  const type = req.query.type;
  if (type && type !== 'all') rows = rows.filter(r => r.delivery_type === type);
  res.json({ list: rows, total: rows.length });
});

// GET /:id — 交付跟踪详情（含阶段）
router.get('/checkins', (req, res) => {
  const db = getDB();
  let rows = (db.acceptance_checkins || []).slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const deliveryId = req.query.deliveryId;
  if (deliveryId) rows = rows.filter(r => r.delivery_id === Number(deliveryId));
  res.json({ list: rows, total: rows.length });
});

// POST /checkin — 新增打卡
router.post('/checkin', (req, res) => {
  const { delivery_id, project_name, checker_name, checker_role, location, latitude, longitude, phase, remark } = req.body;
  if (!delivery_id || !checker_name) return res.status(400).json({ error: '缺少交付ID或打卡人' });
  const id = nextId('acceptance_checkins');
  const record = {
    id, delivery_id, project_name: project_name||'',
    checker_name, checker_role: checker_role||'交付工程师',
    location: location||'', latitude: latitude||0, longitude: longitude||0,
    photo_url: '', phase: phase||'acceptance', status: 'checked',
    remark: remark||'', created_at: new Date().toISOString()
  };
  getDB().acceptance_checkins.push(record);
  res.status(201).json(record);
});

module.exports = router;

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const track = (db.delivery_tracking || []).find(r => r.id === id);
  if (!track) return res.status(404).json({ error: '交付记录不存在' });
  const phases = (db.delivery_phases || []).filter(r => r.delivery_id === id).sort((a,b) => (a.id||0) - (b.id||0));
  res.json({ ...track, phases });
});

// POST / — 创建交付跟踪
router.post('/', (req, res) => {
  const { project_id, project_name, client_name, delivery_type, agent_id, agent_name, assignee, assignee_role, start_date, planned_end_date, payment_amount } = req.body;
  if (!project_id || !project_name) return res.status(400).json({ error: '缺少项目信息' });
  
  const id = nextId('delivery_tracking');
  const now = new Date().toISOString();
  const track = {
    id, project_id, project_name, client_name: client_name||'',
    delivery_type: delivery_type||'direct', agent_id: agent_id||0, agent_name: agent_name||'',
    current_phase: 'requirement', phases_data: {}, progress: 0,
    assignee: assignee||'', assignee_role: assignee_role||'delivery',
    start_date: start_date||now.slice(0,10), planned_end_date: planned_end_date||'',
    actual_end_date: '', acceptance_status: 'pending',
    payment_status: 'unpaid', payment_amount: payment_amount||0, payment_received: 0,
    notes: '', created_at: now, updated_at: now
  };
  getDB().delivery_tracking.push(track);
  
  // 自动创建8个阶段
  const db = getDB();
  PHASES.forEach(p => {
    const pid = nextId('delivery_phases');
    db.delivery_phases.push({
      id: pid, delivery_id: id, phase: p.key, phase_label: p.label,
      status: 'pending', assignee: assignee||'', start_date: '', end_date: '',
      deliverables: [], notes: '', created_at: now, updated_at: now
    });
  });
  
  res.status(201).json({ ...track, message: '交付跟踪已创建，8个阶段已自动初始化' });
});

// PUT /:id — 更新交付跟踪
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const track = (db.delivery_tracking || []).find(r => r.id === id);
  if (!track) return res.status(404).json({ error: '交付记录不存在' });
  ['current_phase','progress','assignee','assignee_role','planned_end_date','actual_end_date','acceptance_status','payment_status','payment_amount','payment_received','notes'].forEach(f => {
    if (req.body[f] !== undefined) track[f] = req.body[f];
  });
  track.updated_at = new Date().toISOString();
  syncRow('delivery_tracking', track);
  res.json(track);
});

// PUT /:id/phase/:phaseKey — 更新阶段状态
router.put('/:id/phase/:phaseKey', (req, res) => {
  const id = Number(req.params.id);
  const phaseKey = req.params.phaseKey;
  const db = getDB();
  const phase = (db.delivery_phases || []).find(r => r.delivery_id === id && r.phase === phaseKey);
  if (!phase) return res.status(404).json({ error: '阶段不存在' });
  ['status','assignee','start_date','end_date','deliverables','notes'].forEach(f => {
    if (req.body[f] !== undefined) phase[f] = req.body[f];
  });
  phase.updated_at = new Date().toISOString();
  syncRow('delivery_phases', phase);
  
  // 自动更新总体进度
  const allPhases = (db.delivery_phases || []).filter(r => r.delivery_id === id);
  const doneCount = allPhases.filter(r => r.status === 'done').length;
  const track = (db.delivery_tracking || []).find(r => r.id === id);
  if (track) {
    track.progress = Math.round(doneCount / PHASES.length * 100);
    // 自动切换当前阶段
    const currentIdx = PHASES.findIndex(p => p.key === phaseKey);
    if (phase.status === 'done' && currentIdx < PHASES.length - 1) {
      track.current_phase = PHASES[currentIdx + 1].key;
    }
    track.updated_at = new Date().toISOString();
    syncRow('delivery_tracking', track);
  }
  
  res.json({ phase, progress: track ? track.progress : 0, current_phase: track ? track.current_phase : '' });
});

// GET /stats/overview — 交付统计
router.get('/stats/overview', (req, res) => {
  const db = getDB();
  const all = db.delivery_tracking || [];
  res.json({
    total: all.length,
    inProgress: all.filter(r => r.acceptance_status === 'pending').length,
    accepted: all.filter(r => r.acceptance_status === 'accepted').length,
    directDelivery: all.filter(r => r.delivery_type === 'direct').length,
    agentDelivery: all.filter(r => r.delivery_type === 'agent').length,
    totalContractAmount: all.reduce((s,r) => s + (r.payment_amount||0), 0),
    totalReceived: all.reduce((s,r) => s + (r.payment_received||0), 0),
    byPhase: PHASES.map(p => ({
      phase: p.key,
      label: p.label,
      count: all.filter(r => r.current_phase === p.key).length
    }))
  });
});

// GET /checkins — 打卡记录列表
