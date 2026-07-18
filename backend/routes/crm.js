/**
 * CRM API 路由
 * 客户关系管理 - 客户/项目/商机/财务/团队/工时/绩效/日报/报价/知识库
 */

const { getRawDB } = require('../models/db');
const router = require('express').Router();

// 鉴权中间件（与 admin.js 一致）
function authCheck(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "未授权" });
  const token = auth.slice(7);
  try {
    const { getRawDB } = require("../models/db");
    const db = getRawDB();
    if (!db) return res.status(401).json({ error: "数据库未初始化" });
    const session = db.prepare("SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
    if (!session) return res.status(401).json({ error: "登录已过期，请重新登录" });
    req.adminUser = { id: session.admin_id, username: session.username, role_id: session.role_id, role_name: session.role_name };
    next();
  } catch(e) {
    return res.status(401).json({ error: "认证失败" });
  }
}

// 获取 SQLite 实例
function db() {
  return getRawDB();
}

// 通用分页
function paginate(rows, req) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const total = rows.length;
  const start = (page - 1) * limit;
  return {
    data: rows.slice(start, start + limit),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

// ==================== 客户管理 ====================

router.get('/customers', authCheck, (req, res) => {
  const d = db();
  let rows = d.prepare('SELECT * FROM crm_customers ORDER BY id DESC').all();
  
  const { search, status } = req.query;
  if (status && status !== 'all') {
    rows = rows.filter(r => r.status === status);
  }
  if (search && search.trim()) {
    const kw = search.trim().toLowerCase();
    rows = rows.filter(r =>
      (r.company_name && r.company_name.toLowerCase().includes(kw)) ||
      (r.contact_name && r.contact_name.toLowerCase().includes(kw)) ||
      (r.contact_phone && r.contact_phone.includes(kw)) ||
      (r.project_manager && r.project_manager.toLowerCase().includes(kw))
    );
  }
  
  // 支持分页
  if (req.query.page || req.query.limit) {
    return res.json(paginate(rows, req));
  }
  res.json(rows);
});

router.get('/customers/:id', authCheck, (req, res) => {
  const d = db();
  const row = d.prepare('SELECT * FROM crm_customers WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '客户不存在' });
  // 附带项目
  const projects = d.prepare('SELECT * FROM crm_projects WHERE customer_id = ?').all(Number(req.params.id));
  row.projects = projects;
  res.json(row);
});

router.post('/customers', authCheck, (req, res) => {
  const d = db();
  const { company_name, industry, scale, contact_name, contact_phone, status, contract_date, project_phase, project_manager, region } = req.body;
  if (!company_name) return res.status(400).json({ error: '公司名称必填' });
  const result = d.prepare(`INSERT INTO crm_customers (company_name, industry, scale, contact_name, contact_phone, status, contract_date, project_phase, project_manager, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    company_name, industry || '', scale || '', contact_name || '', contact_phone || '', status || '跟进中', contract_date || '', project_phase || '', project_manager || '', region || ''
  );
  res.json({ id: result.lastInsertRowid, message: '客户创建成功' });
});

router.put('/customers/:id', authCheck, (req, res) => {
  const d = db();
  const item = d.prepare('SELECT * FROM crm_customers WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: '客户不存在' });
  const { company_name, industry, scale, contact_name, contact_phone, status, contract_date, project_phase, project_manager, region } = req.body;
  d.prepare(`UPDATE crm_customers SET company_name=?, industry=?, scale=?, contact_name=?, contact_phone=?, status=?, contract_date=?, project_phase=?, project_manager=?, region=? WHERE id=?`).run(
    company_name ?? item.company_name, industry ?? item.industry, scale ?? item.scale,
    contact_name ?? item.contact_name, contact_phone ?? item.contact_phone, status ?? item.status,
    contract_date ?? item.contract_date, project_phase ?? item.project_phase,
    project_manager ?? item.project_manager, region ?? item.region, Number(req.params.id)
  );
  res.json({ message: '更新成功' });
});

router.delete('/customers/:id', authCheck, (req, res) => {
  const d = db();
  d.prepare('DELETE FROM crm_customers WHERE id = ?').run(Number(req.params.id));
  res.json({ message: '删除成功' });
});

// ==================== 项目管理 ====================

router.get('/projects', authCheck, (req, res) => {
  const d = db();
  let sql = 'SELECT p.*, c.company_name as customer_name FROM crm_projects p LEFT JOIN crm_customers c ON p.customer_id = c.id WHERE 1=1';
  const params = [];
  if (req.query.customer_id) {
    sql += ' AND p.customer_id = ?';
    params.push(Number(req.query.customer_id));
  }
  if (req.query.status && req.query.status !== 'all') {
    sql += ' AND p.status = ?';
    params.push(req.query.status);
  }
  sql += ' ORDER BY p.id DESC';
  let rows = d.prepare(sql).all(...params);
  
  if (req.query.search && req.query.search.trim()) {
    const kw = req.query.search.trim().toLowerCase();
    rows = rows.filter(r =>
      (r.project_name && r.project_name.toLowerCase().includes(kw)) ||
      (r.requirement && r.requirement.toLowerCase().includes(kw)) ||
      (r.customer_name && r.customer_name.toLowerCase().includes(kw))
    );
  }
  
  if (req.query.page || req.query.limit) {
    return res.json(paginate(rows, req));
  }
  res.json(rows);
});

router.get('/projects/:id', authCheck, (req, res) => {
  const d = db();
  const row = d.prepare('SELECT p.*, c.company_name as customer_name FROM crm_projects p LEFT JOIN crm_customers c ON p.customer_id = c.id WHERE p.id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '项目不存在' });
  res.json(row);
});

router.post('/projects', authCheck, (req, res) => {
  const d = db();
  const { customer_id, project_name, requirement, modules, priority, status, estimated_hours, start_date, end_date } = req.body;
  if (!project_name && !requirement) return res.status(400).json({ error: '项目名称或需求必填' });
  const result = d.prepare(`INSERT INTO crm_projects (customer_id, project_name, requirement, modules, priority, status, estimated_hours, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    customer_id || 0, project_name || '', requirement || '', modules || '', priority || '中', status || '需求确认', estimated_hours || 0, start_date || '', end_date || ''
  );
  res.json({ id: result.lastInsertRowid, message: '项目创建成功' });
});

router.put('/projects/:id', authCheck, (req, res) => {
  const d = db();
  const item = d.prepare('SELECT * FROM crm_projects WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: '项目不存在' });
  const { customer_id, project_name, requirement, modules, priority, status, estimated_hours, start_date, end_date } = req.body;
  d.prepare(`UPDATE crm_projects SET customer_id=?, project_name=?, requirement=?, modules=?, priority=?, status=?, estimated_hours=?, start_date=?, end_date=? WHERE id=?`).run(
    customer_id ?? item.customer_id, project_name ?? item.project_name, requirement ?? item.requirement,
    modules ?? item.modules, priority ?? item.priority, status ?? item.status,
    estimated_hours ?? item.estimated_hours, start_date ?? item.start_date, end_date ?? item.end_date,
    Number(req.params.id)
  );
  res.json({ message: '更新成功' });
});

router.delete('/projects/:id', authCheck, (req, res) => {
  const d = db();
  d.prepare('DELETE FROM crm_projects WHERE id = ?').run(Number(req.params.id));
  res.json({ message: '删除成功' });
});

// ==================== 商机管理 ====================

router.get('/leads', authCheck, (req, res) => {
  const d = db();
  let rows = d.prepare('SELECT * FROM crm_leads ORDER BY id DESC').all();
  const { status, search } = req.query;
  if (status && status !== 'all') {
    rows = rows.filter(r => r.status === status);
  }
  if (search && search.trim()) {
    const kw = search.trim().toLowerCase();
    rows = rows.filter(r =>
      (r.company_name && r.company_name.toLowerCase().includes(kw)) ||
      (r.contact_name && r.contact_name.toLowerCase().includes(kw)) ||
      (r.owner && r.owner.toLowerCase().includes(kw))
    );
  }
  if (req.query.page || req.query.limit) {
    return res.json(paginate(rows, req));
  }
  res.json(rows);
});

router.post('/leads', authCheck, (req, res) => {
  const d = db();
  const { company_name, source, contact_name, contact_phone, intention_level, estimated_amount, status, next_followup, owner } = req.body;
  if (!company_name) return res.status(400).json({ error: '公司名称必填' });
  const result = d.prepare(`INSERT INTO crm_leads (company_name, source, contact_name, contact_phone, intention_level, estimated_amount, status, next_followup, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    company_name, source || '', contact_name || '', contact_phone || '', intention_level || 'B', estimated_amount || 0, status || '线索', next_followup || '', owner || ''
  );
  res.json({ id: result.lastInsertRowid, message: '商机创建成功' });
});

router.put('/leads/:id', authCheck, (req, res) => {
  const d = db();
  const item = d.prepare('SELECT * FROM crm_leads WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: '商机不存在' });
  const { company_name, source, contact_name, contact_phone, intention_level, estimated_amount, status, next_followup, owner } = req.body;
  d.prepare(`UPDATE crm_leads SET company_name=?, source=?, contact_name=?, contact_phone=?, intention_level=?, estimated_amount=?, status=?, next_followup=?, owner=? WHERE id=?`).run(
    company_name ?? item.company_name, source ?? item.source, contact_name ?? item.contact_name,
    contact_phone ?? item.contact_phone, intention_level ?? item.intention_level,
    estimated_amount ?? item.estimated_amount, status ?? item.status,
    next_followup ?? item.next_followup, owner ?? item.owner, Number(req.params.id)
  );
  res.json({ message: '更新成功' });
});

router.delete('/leads/:id', authCheck, (req, res) => {
  const d = db();
  d.prepare('DELETE FROM crm_leads WHERE id = ?').run(Number(req.params.id));
  res.json({ message: '删除成功' });
});

// ==================== 财务管理 ====================

router.get('/finance', authCheck, (req, res) => {
  const d = db();
  let sql = `SELECT f.*, c.company_name as customer_name, p.project_name as project_name FROM crm_finance f LEFT JOIN crm_customers c ON f.customer_id = c.id LEFT JOIN crm_projects p ON f.project_id = p.id WHERE 1=1`;
  const params = [];
  if (req.query.customer_id) {
    sql += ' AND f.customer_id = ?';
    params.push(Number(req.query.customer_id));
  }
  if (req.query.status && req.query.status !== 'all') {
    sql += ' AND f.status = ?';
    params.push(req.query.status);
  }
  sql += ' ORDER BY f.id DESC';
  const rows = d.prepare(sql).all(...params);
  if (req.query.page || req.query.limit) {
    return res.json(paginate(rows, req));
  }
  res.json(rows);
});

router.post('/finance', authCheck, (req, res) => {
  const d = db();
  const { customer_id, project_id, invoice_no, amount, type, status, due_date, actual_date } = req.body;
  const result = d.prepare(`INSERT INTO crm_finance (customer_id, project_id, invoice_no, amount, type, status, due_date, actual_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    customer_id || 0, project_id || 0, invoice_no || '', amount || 0, type || '', status || '待收款', due_date || '', actual_date || ''
  );
  res.json({ id: result.lastInsertRowid, message: '财务记录创建成功' });
});

router.put('/finance/:id', authCheck, (req, res) => {
  const d = db();
  const item = d.prepare('SELECT * FROM crm_finance WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: '记录不存在' });
  const { customer_id, project_id, invoice_no, amount, type, status, due_date, actual_date } = req.body;
  d.prepare(`UPDATE crm_finance SET customer_id=?, project_id=?, invoice_no=?, amount=?, type=?, status=?, due_date=?, actual_date=? WHERE id=?`).run(
    customer_id ?? item.customer_id, project_id ?? item.project_id, invoice_no ?? item.invoice_no,
    amount ?? item.amount, type ?? item.type, status ?? item.status,
    due_date ?? item.due_date, actual_date ?? item.actual_date, Number(req.params.id)
  );
  res.json({ message: '更新成功' });
});

// ==================== 团队管理 ====================

router.get('/employees', authCheck, (req, res) => {
  const d = db();
  const rows = d.prepare('SELECT * FROM crm_employees ORDER BY id DESC').all();
  res.json(rows);
});

router.post('/employees', authCheck, (req, res) => {
  const d = db();
  const { name, role, department, hourly_rate } = req.body;
  if (!name) return res.status(400).json({ error: '姓名必填' });
  const result = d.prepare(`INSERT INTO crm_employees (name, role, department, hourly_rate) VALUES (?, ?, ?, ?)`).run(
    name, role || '', department || '', hourly_rate || 0
  );
  res.json({ id: result.lastInsertRowid, message: '员工创建成功' });
});

router.put('/employees/:id', authCheck, (req, res) => {
  const d = db();
  const item = d.prepare('SELECT * FROM crm_employees WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: '员工不存在' });
  const { name, role, department, hourly_rate } = req.body;
  d.prepare(`UPDATE crm_employees SET name=?, role=?, department=?, hourly_rate=? WHERE id=?`).run(
    name ?? item.name, role ?? item.role, department ?? item.department, hourly_rate ?? item.hourly_rate, Number(req.params.id)
  );
  res.json({ message: '更新成功' });
});

// ==================== 工时记录 ====================

router.get('/time-logs', authCheck, (req, res) => {
  const d = db();
  let sql = `SELECT t.*, e.name as employee_name, p.project_name FROM crm_time_logs t LEFT JOIN crm_employees e ON t.employee_id = e.id LEFT JOIN crm_projects p ON t.project_id = p.id WHERE 1=1`;
  const params = [];
  if (req.query.employee_id) {
    sql += ' AND t.employee_id = ?';
    params.push(Number(req.query.employee_id));
  }
  if (req.query.project_id) {
    sql += ' AND t.project_id = ?';
    params.push(Number(req.query.project_id));
  }
  sql += ' ORDER BY t.id DESC';
  const rows = d.prepare(sql).all(...params);
  if (req.query.page || req.query.limit) {
    return res.json(paginate(rows, req));
  }
  res.json(rows);
});

router.post('/time-logs', authCheck, (req, res) => {
  const d = db();
  const { employee_id, project_id, work_date, hours, description } = req.body;
  const result = d.prepare(`INSERT INTO crm_time_logs (employee_id, project_id, work_date, hours, description) VALUES (?, ?, ?, ?, ?)`).run(
    employee_id || 0, project_id || 0, work_date || '', hours || 0, description || ''
  );
  res.json({ id: result.lastInsertRowid, message: '工时记录创建成功' });
});

// ==================== 绩效评分 ====================

router.get('/performance', authCheck, (req, res) => {
  const d = db();
  let sql = `SELECT pe.*, e.name as employee_name FROM crm_performance pe LEFT JOIN crm_employees e ON pe.employee_id = e.id WHERE 1=1`;
  const params = [];
  if (req.query.employee_id) {
    sql += ' AND pe.employee_id = ?';
    params.push(Number(req.query.employee_id));
  }
  sql += ' ORDER BY pe.id DESC';
  const rows = d.prepare(sql).all(...params);
  if (req.query.page || req.query.limit) {
    return res.json(paginate(rows, req));
  }
  res.json(rows);
});

router.post('/performance', authCheck, (req, res) => {
  const d = db();
  const { employee_id, evaluation_date, work_hours_score, quality_score, progress_score, improvement_score, total_score, feedback } = req.body;
  const result = d.prepare(`INSERT INTO crm_performance (employee_id, evaluation_date, work_hours_score, quality_score, progress_score, improvement_score, total_score, feedback) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    employee_id || 0, evaluation_date || '', work_hours_score || 0, quality_score || 0, progress_score || 0, improvement_score || 0, total_score || 0, feedback || ''
  );
  res.json({ id: result.lastInsertRowid, message: '绩效记录创建成功' });
});

// ==================== 日报 ====================

router.get('/progress-reports', authCheck, (req, res) => {
  const d = db();
  let sql = `SELECT r.*, e.name as employee_name, p.project_name FROM crm_progress_reports r LEFT JOIN crm_employees e ON r.employee_id = e.id LEFT JOIN crm_projects p ON r.project_id = p.id WHERE 1=1`;
  const params = [];
  if (req.query.employee_id) {
    sql += ' AND r.employee_id = ?';
    params.push(Number(req.query.employee_id));
  }
  if (req.query.status && req.query.status !== 'all') {
    sql += ' AND r.status = ?';
    params.push(req.query.status);
  }
  sql += ' ORDER BY r.id DESC';
  const rows = d.prepare(sql).all(...params);
  if (req.query.page || req.query.limit) {
    return res.json(paginate(rows, req));
  }
  res.json(rows);
});

router.post('/progress-reports', authCheck, (req, res) => {
  const d = db();
  const { employee_id, project_id, report_date, progress_percent, issues, solutions, next_plan, status } = req.body;
  const result = d.prepare(`INSERT INTO crm_progress_reports (employee_id, project_id, report_date, progress_percent, issues, solutions, next_plan, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    employee_id || 0, project_id || 0, report_date || '', progress_percent || 0, issues || '', solutions || '', next_plan || '', status || '待审核'
  );
  res.json({ id: result.lastInsertRowid, message: '日报创建成功' });
});

router.put('/progress-reports/:id', authCheck, (req, res) => {
  const d = db();
  const item = d.prepare('SELECT * FROM crm_progress_reports WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: '日报不存在' });
  const { employee_id, project_id, report_date, progress_percent, issues, solutions, next_plan, status } = req.body;
  d.prepare(`UPDATE crm_progress_reports SET employee_id=?, project_id=?, report_date=?, progress_percent=?, issues=?, solutions=?, next_plan=?, status=? WHERE id=?`).run(
    employee_id ?? item.employee_id, project_id ?? item.project_id, report_date ?? item.report_date,
    progress_percent ?? item.progress_percent, issues ?? item.issues, solutions ?? item.solutions,
    next_plan ?? item.next_plan, status ?? item.status, Number(req.params.id)
  );
  res.json({ message: '更新成功' });
});

// ==================== 报价模块库 ====================

router.get('/price-modules', authCheck, (req, res) => {
  const d = db();
  let sql = 'SELECT * FROM crm_price_modules WHERE 1=1';
  const params = [];
  if (req.query.category && req.query.category !== 'all') {
    sql += ' AND category = ?';
    params.push(req.query.category);
  }
  sql += ' ORDER BY id';
  const rows = d.prepare(sql).all(...params);
  res.json(rows);
});

// ==================== 报价套餐 ====================

router.get('/price-packages', authCheck, (req, res) => {
  const d = db();
  const rows = d.prepare('SELECT * FROM crm_price_packages ORDER BY id').all();
  res.json(rows);
});

// ==================== 知识库 ====================

router.get('/knowledge-base', authCheck, (req, res) => {
  const d = db();
  let sql = 'SELECT * FROM crm_knowledge_base WHERE 1=1';
  const params = [];
  if (req.query.category && req.query.category !== 'all') {
    sql += ' AND category = ?';
    params.push(req.query.category);
  }
  if (req.query.search && req.query.search.trim()) {
    const kw = '%' + req.query.search.trim() + '%';
    sql += ' AND (title LIKE ? OR summary LIKE ? OR tags LIKE ?)';
    params.push(kw, kw, kw);
  }
  sql += ' ORDER BY id DESC';
  const rows = d.prepare(sql).all(...params);
  res.json(rows);
});

module.exports = router;
