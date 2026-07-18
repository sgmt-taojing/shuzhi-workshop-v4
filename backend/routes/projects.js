const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

// ==================== 常量映射 ====================

const STATUS_MAP = {
  planning: '立项中',
  active: '执行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消'
};

const PRIORITY_MAP = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急'
};

const PHASE_MAP = {
  initiation: '启动',
  planning: '规划',
  execution: '执行',
  monitoring: '监控',
  closing: '收尾'
};

const ROLE_MAP = {
  manager: '项目经理',
  developer: '开发',
  designer: '设计',
  tester: '测试',
  other: '其他'
};

const APPROVAL_TYPE_MAP = {
  budget: '预算审批',
  timeline: '周期审批',
  scope: '范围审批',
  change: '变更审批',
  other: '其他审批'
};

// ==================== 统计概览 ====================
// 注意：此路由必须在 /:id 之前注册

router.get('/stats/overview', (req, res) => {
  const db = getDB();
  const all = (db.projects || []).filter(p => p.status !== 'cancelled');

  // 按状态分布
  const byStatus = {};
  all.forEach(p => {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  });

  // 按阶段分布
  const byPhase = {};
  all.forEach(p => {
    byPhase[p.phase] = (byPhase[p.phase] || 0) + 1;
  });

  // 按优先级分布
  const byPriority = {};
  all.forEach(p => {
    byPriority[p.priority] = (byPriority[p.priority] || 0) + 1;
  });

  // 本周新增
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekStartStr = weekStart.toISOString();
  const thisWeekNew = all.filter(p => p.created_at && p.created_at >= weekStartStr).length;

  // 进度分布
  const progressBuckets = { '0-25%': 0, '26-50%': 0, '51-75%': 0, '76-100%': 0 };
  all.forEach(p => {
    const pg = p.progress || 0;
    if (pg <= 25) progressBuckets['0-25%']++;
    else if (pg <= 50) progressBuckets['26-50%']++;
    else if (pg <= 75) progressBuckets['51-75%']++;
    else progressBuckets['76-100%']++;
  });

  res.json({
    total: all.length,
    byStatus,
    byPhase,
    byPriority,
    thisWeekNew,
    progressBuckets
  });
});

// ==================== 项目 CRUD ====================

// GET / — 项目列表
router.get('/', (req, res) => {
  const db = getDB();
  let rows = (db.projects || []).filter(p => p.status !== 'cancelled');

  // 按状态筛选
  const status = req.query.status;
  if (status && status !== 'all') {
    rows = rows.filter(r => r.status === status);
  }

  // 按优先级筛选
  const priority = req.query.priority;
  if (priority && priority !== 'all') {
    rows = rows.filter(r => r.priority === priority);
  }

  // 按客户筛选
  const client = req.query.client;
  if (client) {
    rows = rows.filter(r => r.client_name && r.client_name.includes(client));
  }

  // 按阶段筛选
  const phase = req.query.phase;
  if (phase && phase !== 'all') {
    rows = rows.filter(r => r.phase === phase);
  }

  // 搜索
  const search = req.query.search;
  if (search) {
    const kw = search.toLowerCase();
    rows = rows.filter(r =>
      (r.name && r.name.toLowerCase().includes(kw)) ||
      (r.code && r.code.toLowerCase().includes(kw)) ||
      (r.client_name && r.client_name.toLowerCase().includes(kw)) ||
      (r.manager && r.manager.toLowerCase().includes(kw)) ||
      (r.description && r.description.toLowerCase().includes(kw))
    );
  }

  // 排序
  const sort = req.query.sort || 'created';
  if (sort === 'progress') {
    rows.sort((a, b) => (b.progress || 0) - (a.progress || 0));
  } else if (sort === 'priority') {
    const order = { urgent: 4, high: 3, medium: 2, low: 1 };
    rows.sort((a, b) => (order[b.priority] || 0) - (order[a.priority] || 0));
  } else {
    rows.sort((a, b) => {
      const da = a.created_at || '';
      const db_ = b.created_at || '';
      return db_.localeCompare(da);
    });
  }

  // 分页
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const start = (page - 1) * limit;
  const list = rows.slice(start, start + limit).map(r => ({
    ...r,
    status_label: STATUS_MAP[r.status] || '',
    priority_label: PRIORITY_MAP[r.priority] || '',
    phase_label: PHASE_MAP[r.phase] || ''
  }));

  res.json({ list, total, page, limit, totalPages: Math.ceil(total / limit) });
});

// GET /:id — 项目详情
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const project = (db.projects || []).find(r => r.id === id);
  if (!project) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  // 里程碑
  const milestones = (db.project_milestones || [])
    .filter(m => m.project_id === id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  // 成员
  const members = (db.project_members || [])
    .filter(m => m.project_id === id && m.status === 'active');

  // 最近日报（最近7条）
  const reports = (db.project_daily_reports || [])
    .filter(r => r.project_id === id)
    .sort((a, b) => {
      const da = a.report_date || a.created_at || '';
      const db_ = b.report_date || b.created_at || '';
      return db_.localeCompare(da);
    })
    .slice(0, 7);

  res.json({
    ...project,
    status_label: STATUS_MAP[project.status] || '',
    priority_label: PRIORITY_MAP[project.priority] || '',
    phase_label: PHASE_MAP[project.phase] || '',
    milestones,
    members,
    recentReports: reports
  });
});

// POST / — 创建项目
router.post('/', (req, res) => {
  const {
    name, code, client_name, client_contact, client_phone,
    description, status, priority, phase, progress,
    start_date, end_date, budget, manager, manager_phone,
    team_size, tags, attachments, remark
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: '项目名称不能为空', code: 'NAME_REQUIRED' });
  }

  const id = nextId('projects');
  const db = getDB();
  const now = new Date().toISOString();

  const newProject = {
    id,
    name,
    code: code || `PRJ-${String(id).padStart(4, '0')}`,
    client_name: client_name || '',
    client_contact: client_contact || '',
    client_phone: client_phone || '',
    description: description || '',
    status: status || 'planning',
    priority: priority || 'medium',
    phase: phase || 'initiation',
    progress: progress || 0,
    start_date: start_date || '',
    end_date: end_date || '',
    actual_end_date: '',
    budget: budget || 0,
    spent: 0,
    manager: manager || '',
    manager_phone: manager_phone || '',
    team_size: team_size || 0,
    tags: tags || [],
    attachments: attachments || [],
    remark: remark || '',
    created_at: now,
    updated_at: now
  };

  db.projects.push(newProject);

  res.status(201).json({
    ...newProject,
    status_label: STATUS_MAP[newProject.status] || '',
    priority_label: PRIORITY_MAP[newProject.priority] || '',
    phase_label: PHASE_MAP[newProject.phase] || ''
  });
});

// PUT /:id — 更新项目
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const row = (db.projects || []).find(r => r.id === id);
  if (!row) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  const allowedFields = [
    'name', 'code', 'client_name', 'client_contact', 'client_phone',
    'description', 'status', 'priority', 'phase', 'progress',
    'start_date', 'end_date', 'actual_end_date', 'budget', 'spent',
    'manager', 'manager_phone', 'team_size', 'tags', 'attachments', 'remark'
  ];

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      row[field] = req.body[field];
    }
  }

  // 状态联动
  if (req.body.status === 'completed' && !row.actual_end_date) {
    row.actual_end_date = new Date().toISOString().slice(0, 10);
  }

  row.updated_at = new Date().toISOString();
  syncRow('projects', row);

  res.json({
    ...row,
    status_label: STATUS_MAP[row.status] || '',
    priority_label: PRIORITY_MAP[row.priority] || '',
    phase_label: PHASE_MAP[row.phase] || ''
  });
});

// DELETE /:id — 删除项目（软删除）
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const row = (db.projects || []).find(r => r.id === id);
  if (!row) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  row.status = 'cancelled';
  row.updated_at = new Date().toISOString();
  syncRow('projects', row);

  res.json({ success: true, id, message: '项目已取消' });
});

// PUT /:id/progress — 更新进度
router.put('/:id/progress', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const progress = req.body.progress;
  if (progress === undefined || progress < 0 || progress > 100) {
    return res.status(400).json({ error: '进度必须在0-100之间', code: 'INVALID_PROGRESS' });
  }

  const db = getDB();
  const row = (db.projects || []).find(r => r.id === id);
  if (!row) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  row.progress = Math.round(progress);
  row.updated_at = new Date().toISOString();

  // 自动调整阶段
  if (progress >= 100) {
    row.phase = 'closing';
  } else if (progress > 0 && row.phase === 'initiation') {
    row.phase = 'execution';
  }

  syncRow('projects', row);

  res.json({
    success: true,
    id,
    progress: row.progress,
    phase: row.phase,
    phase_label: PHASE_MAP[row.phase] || '',
    status_label: STATUS_MAP[row.status] || ''
  });
});

// ==================== 里程碑 ====================

// GET /:id/milestones — 里程碑列表
router.get('/:id/milestones', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const project = (db.projects || []).find(r => r.id === id);
  if (!project) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  const milestones = (db.project_milestones || [])
    .filter(m => m.project_id === id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  res.json({ list: milestones, total: milestones.length });
});

// POST /:id/milestones — 创建里程碑
router.post('/:id/milestones', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const project = (db.projects || []).find(r => r.id === id);
  if (!project) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  const { title, description, planned_date, sort_order, deliverables, remark } = req.body;
  if (!title) {
    return res.status(400).json({ error: '里程碑标题不能为空', code: 'TITLE_REQUIRED' });
  }

  const mid = nextId('project_milestones');
  const now = new Date().toISOString();
  const milestone = {
    id: mid,
    project_id: id,
    title,
    description: description || '',
    status: 'pending',
    sort_order: sort_order || 0,
    planned_date: planned_date || '',
    actual_date: '',
    deliverables: deliverables || [],
    remark: remark || '',
    created_at: now,
    updated_at: now
  };

  db.project_milestones.push(milestone);

  res.status(201).json(milestone);
});

// PUT /:id/milestones/:mid — 更新里程碑状态
router.put('/:id/milestones/:mid', (req, res) => {
  const id = Number(req.params.id);
  const mid = Number(req.params.mid);
  if (!id || !mid) {
    return res.status(400).json({ error: '无效的ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const milestone = (db.project_milestones || []).find(m => m.id === mid && m.project_id === id);
  if (!milestone) {
    return res.status(404).json({ error: '里程碑不存在', code: 'MILESTONE_NOT_FOUND' });
  }

  const allowedFields = ['title', 'description', 'status', 'sort_order', 'planned_date', 'actual_date', 'deliverables', 'remark'];
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      milestone[field] = req.body[field];
    }
  }

  // 状态联动：已完成时自动记录实际日期
  if (req.body.status === 'done' && !milestone.actual_date) {
    milestone.actual_date = new Date().toISOString().slice(0, 10);
  }

  milestone.updated_at = new Date().toISOString();
  syncRow('project_milestones', milestone);

  res.json(milestone);
});

// ==================== 成员 ====================

// GET /:id/members — 成员列表
// DELETE /:id/milestones/:mid — 删除里程碑
router.delete('/:id/milestones/:mid', (req, res) => {
  const id = Number(req.params.id);
  const mid = Number(req.params.mid);
  if (!id || !mid) return res.status(400).json({ error: '无效的ID', code: 'INVALID_ID' });

  const db = getDB();
  const idx = (db.project_milestones || []).findIndex(m => m.id === mid && m.project_id === id);
  if (idx === -1) return res.status(404).json({ error: '里程碑不存在', code: 'NOT_FOUND' });

  db.project_milestones.splice(idx, 1);
  deleteRows('project_milestones', { id: mid });
  res.json({ success: true });
});

router.get('/:id/members', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const project = (db.projects || []).find(r => r.id === id);
  if (!project) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  const members = (db.project_members || [])
    .filter(m => m.project_id === id);

  const list = members.map(m => ({
    ...m,
    role_label: ROLE_MAP[m.role] || m.role
  }));

  res.json({ list, total: list.length });
});

// POST /:id/members — 添加成员
router.post('/:id/members', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const project = (db.projects || []).find(r => r.id === id);
  if (!project) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  const { name, role, phone, email, responsibility, join_date } = req.body;
  if (!name) {
    return res.status(400).json({ error: '成员姓名不能为空', code: 'NAME_REQUIRED' });
  }

  const mid = nextId('project_members');
  const now = new Date().toISOString();
  const member = {
    id: mid,
    project_id: id,
    name,
    role: role || 'developer',
    phone: phone || '',
    email: email || '',
    responsibility: responsibility || '',
    join_date: join_date || now.slice(0, 10),
    leave_date: '',
    status: 'active',
    created_at: now,
    updated_at: now
  };

  db.project_members.push(member);

  // 更新项目团队人数
  const activeCount = (db.project_members || []).filter(m => m.project_id === id && m.status === 'active').length;
  project.team_size = activeCount;
  project.updated_at = now;
  syncRow('projects', project);

  res.status(201).json({
    ...member,
    role_label: ROLE_MAP[member.role] || member.role
  });
});

// DELETE /:id/members/:mid — 移除成员
// PUT /:id/members/:mid — 更新成员
router.put('/:id/members/:mid', (req, res) => {
  const id = Number(req.params.id);
  const mid = Number(req.params.mid);
  if (!id || !mid) return res.status(400).json({ error: '无效的ID', code: 'INVALID_ID' });

  const db = getDB();
  const member = (db.project_members || []).find(m => m.id === mid && m.project_id === id);
  if (!member) return res.status(404).json({ error: '成员不存在', code: 'NOT_FOUND' });

  const { name, role, phone, email, responsibility, join_date, leave_date, status } = req.body;
  if (name !== undefined) member.name = name;
  if (role !== undefined) member.role = role;
  if (phone !== undefined) member.phone = phone;
  if (email !== undefined) member.email = email;
  if (responsibility !== undefined) member.responsibility = responsibility;
  if (join_date !== undefined) member.join_date = join_date;
  if (leave_date !== undefined) member.leave_date = leave_date;
  if (status !== undefined) member.status = status;
  member.updated_at = new Date().toISOString();
  syncRow('project_members', member);

  res.json({ ...member, role_label: ROLE_MAP[member.role] || member.role });
});

router.delete('/:id/members/:mid', (req, res) => {
  const id = Number(req.params.id);
  const mid = Number(req.params.mid);
  if (!id || !mid) {
    return res.status(400).json({ error: '无效的ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const member = (db.project_members || []).find(m => m.id === mid && m.project_id === id);
  if (!member) {
    return res.status(404).json({ error: '成员不存在', code: 'MEMBER_NOT_FOUND' });
  }

  member.status = 'left';
  member.leave_date = new Date().toISOString().slice(0, 10);
  member.updated_at = new Date().toISOString();
  syncRow('project_members', member);

  // 更新项目团队人数
  const project = (db.projects || []).find(r => r.id === id);
  if (project) {
    project.team_size = (db.project_members || []).filter(m => m.project_id === id && m.status === 'active').length;
    project.updated_at = new Date().toISOString();
    syncRow('projects', project);
  }

  res.json({ success: true, id: mid, message: '成员已移除' });
});

// ==================== 日报 ====================

// GET /:id/reports — 日报列表
router.get('/:id/reports', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const project = (db.projects || []).find(r => r.id === id);
  if (!project) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  let rows = (db.project_daily_reports || []).filter(r => r.project_id === id);

  // 日期范围筛选
  const startDate = req.query.startDate;
  const endDate = req.query.endDate;
  if (startDate) {
    rows = rows.filter(r => r.report_date && r.report_date >= startDate);
  }
  if (endDate) {
    rows = rows.filter(r => r.report_date && r.report_date <= endDate);
  }

  // 状态筛选
  const status = req.query.status;
  if (status && status !== 'all') {
    rows = rows.filter(r => r.status === status);
  }

  // 排序：按日期倒序
  rows.sort((a, b) => {
    const da = a.report_date || a.created_at || '';
    const db_ = b.report_date || b.created_at || '';
    return db_.localeCompare(da);
  });

  // 分页
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const start = (page - 1) * limit;
  const list = rows.slice(start, start + limit);

  res.json({ list, total, page, limit, totalPages: Math.ceil(total / limit) });
});

// POST /:id/reports — 提交日报
router.post('/:id/reports', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const project = (db.projects || []).find(r => r.id === id);
  if (!project) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  const { member_id, member_name, report_date, content, progress, issues, plan } = req.body;
  if (!report_date) {
    return res.status(400).json({ error: '日报日期不能为空', code: 'DATE_REQUIRED' });
  }
  if (!content) {
    return res.status(400).json({ error: '日报内容不能为空', code: 'CONTENT_REQUIRED' });
  }

  const rid = nextId('project_daily_reports');
  const now = new Date().toISOString();
  const report = {
    id: rid,
    project_id: id,
    member_id: member_id || 0,
    member_name: member_name || '',
    report_date,
    content,
    progress: progress || 0,
    issues: issues || '',
    plan: plan || '',
    status: 'pending',
    review_comment: '',
    reviewed_by: '',
    reviewed_at: '',
    created_at: now,
    updated_at: now
  };

  db.project_daily_reports.push(report);

  res.status(201).json(report);
});

// PUT /:id/reports/:rid/review — 审核日报
router.put('/:id/reports/:rid/review', (req, res) => {
  const id = Number(req.params.id);
  const rid = Number(req.params.rid);
  if (!id || !rid) {
    return res.status(400).json({ error: '无效的ID', code: 'INVALID_ID' });
  }

  const { status, review_comment, reviewed_by } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: '审核状态必须是 approved 或 rejected', code: 'INVALID_STATUS' });
  }

  const db = getDB();
  const report = (db.project_daily_reports || []).find(r => r.id === rid && r.project_id === id);
  if (!report) {
    return res.status(404).json({ error: '日报不存在', code: 'REPORT_NOT_FOUND' });
  }

  report.status = status;
  report.review_comment = review_comment || '';
  report.reviewed_by = reviewed_by || '';
  report.reviewed_at = new Date().toISOString();
  report.updated_at = new Date().toISOString();
  syncRow('project_daily_reports', report);

  res.json(report);
});

// ==================== 审批 ====================

// GET /:id/approvals — 审批列表
// DELETE /:id/reports/:rid — 删除日报
router.delete('/:id/reports/:rid', (req, res) => {
  const id = Number(req.params.id);
  const rid = Number(req.params.rid);
  if (!id || !rid) return res.status(400).json({ error: '无效的ID', code: 'INVALID_ID' });

  const db = getDB();
  const idx = (db.project_daily_reports || []).findIndex(r => r.id === rid && r.project_id === id);
  if (idx === -1) return res.status(404).json({ error: '日报不存在', code: 'NOT_FOUND' });

  db.project_daily_reports.splice(idx, 1);
  deleteRows('project_daily_reports', { id: rid });
  res.json({ success: true });
});

router.get('/:id/approvals', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const project = (db.projects || []).find(r => r.id === id);
  if (!project) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  let rows = (db.project_approvals || []).filter(a => a.project_id === id);

  // 状态筛选
  const status = req.query.status;
  if (status && status !== 'all') {
    rows = rows.filter(r => r.status === status);
  }

  // 类型筛选
  const type = req.query.type;
  if (type && type !== 'all') {
    rows = rows.filter(r => r.type === type);
  }

  // 排序：按创建时间倒序
  rows.sort((a, b) => {
    const da = a.created_at || '';
    const db_ = b.created_at || '';
    return db_.localeCompare(da);
  });

  const list = rows.map(r => ({
    ...r,
    type_label: APPROVAL_TYPE_MAP[r.type] || r.type
  }));

  res.json({ list, total: list.length });
});

// POST /:id/approvals — 提交审批
router.post('/:id/approvals', (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: '无效的项目ID', code: 'INVALID_ID' });
  }

  const db = getDB();
  const project = (db.projects || []).find(r => r.id === id);
  if (!project) {
    return res.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
  }

  const { type, title, content, requester, requester_id } = req.body;
  if (!title) {
    return res.status(400).json({ error: '审批标题不能为空', code: 'TITLE_REQUIRED' });
  }

  const aid = nextId('project_approvals');
  const now = new Date().toISOString();
  const approval = {
    id: aid,
    project_id: id,
    type: type || 'other',
    title,
    content: content || '',
    requester: requester || '',
    requester_id: requester_id || 0,
    status: 'pending',
    approver: '',
    approver_comment: '',
    approved_at: '',
    created_at: now,
    updated_at: now
  };

  db.project_approvals.push(approval);

  res.status(201).json({
    ...approval,
    type_label: APPROVAL_TYPE_MAP[approval.type] || approval.type
  });
});

// PUT /:id/approvals/:aid — 审批操作
router.put('/:id/approvals/:aid', (req, res) => {
  const id = Number(req.params.id);
  const aid = Number(req.params.aid);
  if (!id || !aid) {
    return res.status(400).json({ error: '无效的ID', code: 'INVALID_ID' });
  }

  const { status, approver, approver_comment } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: '审批状态必须是 approved 或 rejected', code: 'INVALID_STATUS' });
  }

  const db = getDB();
  const approval = (db.project_approvals || []).find(a => a.id === aid && a.project_id === id);
  if (!approval) {
    return res.status(404).json({ error: '审批不存在', code: 'APPROVAL_NOT_FOUND' });
  }

  if (approval.status !== 'pending') {
    return res.status(400).json({ error: '该审批已处理', code: 'ALREADY_PROCESSED' });
  }

  approval.status = status;
  approval.approver = approver || '';
  approval.approver_comment = approver_comment || '';
  approval.approved_at = new Date().toISOString();
  approval.updated_at = new Date().toISOString();
  syncRow('project_approvals', approval);

  res.json({
    ...approval,
    type_label: APPROVAL_TYPE_MAP[approval.type] || approval.type
  });
});

// DELETE /:id/approvals/:aid — 删除审批
router.delete('/:id/approvals/:aid', (req, res) => {
  const id = Number(req.params.id);
  const aid = Number(req.params.aid);
  if (!id || !aid) return res.status(400).json({ error: '无效的ID', code: 'INVALID_ID' });

  const db = getDB();
  const idx = (db.project_approvals || []).findIndex(a => a.id === aid && a.project_id === id);
  if (idx === -1) return res.status(404).json({ error: '审批不存在', code: 'NOT_FOUND' });

  db.project_approvals.splice(idx, 1);
  deleteRows('project_approvals', { id: aid });
  res.json({ success: true });
});

module.exports = router;
