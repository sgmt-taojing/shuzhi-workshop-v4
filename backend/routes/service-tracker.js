const { getDB, nextId, save, syncRow } = require('../models/db');
const { createNotification } = require('./notifications');
const { log: auditLog } = require('../middleware/audit');
const router = require('express').Router();

/**
 * 服务交付里程碑系统
 *
 * 业务逻辑：
 * - 当订单状态变为 paid（已支付）时，可自动生成默认里程碑模板
 * - 管理员可手动添加/编辑/删除里程碑
 * - 客户通过手机号查看自己的服务进度
 * - 里程碑状态流转：pending → in_progress → done / skipped
 * - 里程碑完成时自动通知客户
 */

// 默认里程碑模板（按产品类型分类）
const DEFAULT_TEMPLATES = {
  // 我方数字化产品（服务型）
  product: [
    { title: '需求调研与确认', description: '深入了解业务需求，确认功能范围与优先级', expected_days: 3 },
    { title: '方案设计', description: '输出技术方案、原型设计、实施计划', expected_days: 5 },
    { title: '开发与配置', description: '系统开发、功能配置、数据迁移', expected_days: 15 },
    { title: '测试与验收', description: 'UAT测试、Bug修复、客户验收', expected_days: 5 },
    { title: '上线与培训', description: '正式上线部署、操作培训、文档交付', expected_days: 3 }
  ],
  // 甲方严选产品（商品型）
  client_product: [
    { title: '订单确认', description: '确认订单详情与交付要求', expected_days: 1 },
    { title: '备货/准备', description: '产品备货或服务准备工作', expected_days: 3 },
    { title: '交付/实施', description: '产品交付或服务实施', expected_days: 5 },
    { title: '验收确认', description: '客户验收并确认', expected_days: 2 }
  ]
};

/**
 * 为订单初始化默认里程碑（可被 pay.js 等外部模块调用）
 */
async function initMilestonesForOrder(orderId) {
  const { getDB, nextId } = require('../models/db');
  const db = getDB();

  const order = db.orders.find(o => o.id === orderId);
  if (!order) return { message: '订单不存在', count: 0 };

  // 检查是否已有里程碑
  const existing = db.service_milestones.filter(m => m.order_id === orderId);
  if (existing.length > 0) return { message: '里程碑已存在', count: existing.length };

  // 根据产品类型选择模板
  const template = DEFAULT_TEMPLATES[order.product_type] || DEFAULT_TEMPLATES.product;

  const startDate = order.paid_at ? new Date(order.paid_at) : new Date();
  let currentDate = new Date(startDate);

  const created = [];
  for (let i = 0; i < template.length; i++) {
    const t = template[i];
    const expectedDate = new Date(currentDate);
    expectedDate.setDate(expectedDate.getDate() + t.expected_days);

    const milestone = {
      id: nextId('service_milestones'),
      order_id: orderId,
      order_no: order.order_no,
      buyer_phone: order.buyer_phone,
      buyer_openid: order.buyer_openid || '',
      product_title: order.product_title,
      title: t.title,
      description: t.description,
      sort_order: i + 1,
      status: i === 0 ? 'in_progress' : 'pending',
      progress: i === 0 ? 10 : 0,
      start_date: i === 0 ? startDate.toISOString().slice(0, 10) : '',
      expected_date: expectedDate.toISOString().slice(0, 10),
      completed_date: '',
      deliverables: [],
      notes: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    db.service_milestones.push(milestone);
    created.push(milestone);
    currentDate = expectedDate;
  }

  // 发送通知
  try {
    const { createNotification } = require('./notifications');
    await createNotification({
      type: 'service',
      title: '服务已启动',
      content: `您的订单「${order.product_title}」服务已启动，共${created.length}个交付阶段。`,
      target_phones: [order.buyer_phone],
      link_type: 'service_tracker',
      link_id: String(orderId),
      icon: '🚀'
    });
  } catch (e) {
    console.warn('[service-tracker] 通知发送失败:', e.message);
  }

  console.log(`[service-tracker] 订单 ${order.order_no} 里程碑已初始化，共 ${created.length} 个阶段`);
  return { message: '里程碑已初始化', count: created.length, milestones: created };
}

// ==================== 路由 ====================

/**
 * GET /api/service-tracker/:orderId
 * 获取指定订单的里程碑列表（客户端）
 */
router.get('/order/:orderId', (req, res) => {
  const db = getDB();
  const orderId = parseInt(req.params.orderId);

  // 查找订单
  const order = db.orders.find(o => o.id === orderId);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  const milestones = db.service_milestones
    .filter(m => m.order_id === orderId)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  // 计算总进度
  const totalMilestones = milestones.length;
  const completedMilestones = milestones.filter(m => m.status === 'done').length;
  const skippedMilestones = milestones.filter(m => m.status === 'skipped').length;
  const effectiveTotal = totalMilestones - skippedMilestones;
  const overallProgress = effectiveTotal > 0
    ? Math.round((completedMilestones / effectiveTotal) * 100)
    : 0;

  // 当前阶段（第一个非 done/skipped 的里程碑）
  const currentMilestone = milestones.find(m => m.status === 'pending' || m.status === 'in_progress');

  res.json({
    order: {
      id: order.id,
      order_no: order.order_no,
      product_title: order.product_title,
      status: order.status,
      amount: order.amount,
      created_at: order.created_at,
      paid_at: order.paid_at
    },
    milestones,
    stats: {
      total: totalMilestones,
      completed: completedMilestones,
      skipped: skippedMilestones,
      in_progress: milestones.filter(m => m.status === 'in_progress').length,
      pending: milestones.filter(m => m.status === 'pending').length,
      overall_progress: overallProgress,
      current_step: currentMilestone ? currentMilestone.sort_order : totalMilestones
    }
  });
});

/**
 * GET /api/service-tracker/phone/:phone
 * 按手机号查所有订单的服务进度（客户端「我的服务」列表）
 */
router.get('/phone/:phone', (req, res) => {
  const db = getDB();
  const phone = req.params.phone;

  const orders = db.orders.filter(o => o.buyer_phone === phone && o.status !== 'cancelled' && o.status !== 'refunded');

  const result = orders.map(order => {
    const milestones = db.service_milestones
      .filter(m => m.order_id === order.id)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    const completed = milestones.filter(m => m.status === 'done').length;
    const skipped = milestones.filter(m => m.status === 'skipped').length;
    const effectiveTotal = milestones.length - skipped;
    const progress = effectiveTotal > 0 ? Math.round((completed / effectiveTotal) * 100) : 0;
    const current = milestones.find(m => m.status === 'pending' || m.status === 'in_progress');

    return {
      order_id: order.id,
      order_no: order.order_no,
      product_title: order.product_title,
      order_status: order.status,
      amount: order.amount,
      created_at: order.created_at,
      paid_at: order.paid_at,
      milestone_count: milestones.length,
      completed_count: completed,
      overall_progress: progress,
      current_title: current ? current.title : (completed === milestones.length && milestones.length > 0 ? '全部完成' : '待启动'),
      current_status: current ? current.status : 'done'
    };
  });

  res.json(result);
});

/**
 * POST /api/service-tracker/init/:orderId
 * 为订单初始化默认里程碑（订单支付后自动调用，或管理员手动触发）
 */
router.post('/init/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId);
  const result = await initMilestonesForOrder(orderId);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

/**
 * GET /api/service-tracker/list
 * 管理端：获取所有有里程碑的订单列表
 */
router.get('/list', (req, res) => {
  const db = getDB();
  const { status, keyword, page = 1, limit = 20 } = req.query;

  // 获取所有有里程碑的订单ID
  const orderIds = [...new Set(db.service_milestones.map(m => m.order_id))];

  let orders = orderIds.map(oid => {
    const order = db.orders.find(o => o.id === oid);
    if (!order) return null;

    const milestones = db.service_milestones
      .filter(m => m.order_id === oid)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    const completed = milestones.filter(m => m.status === 'done').length;
    const skipped = milestones.filter(m => m.status === 'skipped').length;
    const effectiveTotal = milestones.length - skipped;
    const progress = effectiveTotal > 0 ? Math.round((completed / effectiveTotal) * 100) : 0;
    const current = milestones.find(m => m.status === 'pending' || m.status === 'in_progress');

    return {
      order_id: oid,
      order_no: order.order_no,
      product_title: order.product_title,
      buyer_name: order.buyer_name,
      buyer_phone: order.buyer_phone,
      order_status: order.status,
      amount: order.amount,
      paid_at: order.paid_at,
      milestone_count: milestones.length,
      completed_count: completed,
      overall_progress: progress,
      current_title: current ? current.title : (completed === milestones.length ? '全部完成' : '待启动'),
      current_status: current ? current.status : 'done',
      milestones
    };
  }).filter(Boolean);

  // 按进度筛选
  if (status === 'active') {
    orders = orders.filter(o => o.overall_progress < 100);
  } else if (status === 'completed') {
    orders = orders.filter(o => o.overall_progress === 100);
  } else if (status === 'pending') {
    orders = orders.filter(o => o.completed_count === 0);
  }

  // 关键词搜索
  if (keyword) {
    const kw = keyword.toLowerCase();
    orders = orders.filter(o =>
      o.order_no.toLowerCase().includes(kw) ||
      o.product_title.toLowerCase().includes(kw) ||
      o.buyer_name.toLowerCase().includes(kw) ||
      o.buyer_phone.includes(kw)
    );
  }

  // 分页
  const total = orders.length;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.max(1, parseInt(limit));
  const start = (pageNum - 1) * limitNum;
  const paged = orders.slice(start, start + limitNum);

  res.json({
    list: paged,
    total,
    page: pageNum,
    limit: limitNum,
    summary: {
      total_orders: total,
      active: orders.filter(o => o.overall_progress < 100).length,
      completed: orders.filter(o => o.overall_progress === 100).length,
      avg_progress: total > 0 ? Math.round(orders.reduce((s, o) => s + o.overall_progress, 0) / total) : 0
    }
  });
});

/**
 * POST /api/service-tracker/milestone
 * 管理端：添加自定义里程碑
 */
router.post('/milestone', (req, res) => {
  const db = getDB();
  const { order_id, title, description, expected_date, notes } = req.body;

  if (!order_id || !title) {
    return res.status(400).json({ error: '缺少必填参数 order_id 或 title' });
  }

  const order = db.orders.find(o => o.id === parseInt(order_id));
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  // 计算排序
  const existing = db.service_milestones.filter(m => m.order_id === parseInt(order_id));
  const sortOrder = existing.length + 1;

  const milestone = {
    id: nextId('service_milestones'),
    order_id: parseInt(order_id),
    order_no: order.order_no,
    buyer_phone: order.buyer_phone,
    buyer_openid: order.buyer_openid || '',
    product_title: order.product_title,
    title,
    description: description || '',
    sort_order: sortOrder,
    status: 'pending',
    progress: 0,
    start_date: '',
    expected_date: expected_date || '',
    completed_date: '',
    deliverables: [],
    notes: notes || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.service_milestones.push(milestone);

  auditLog(req, 'service_milestone_create', { order_id, title });

  res.json({ message: '里程碑已添加', milestone });
});

/**
 * PUT /api/service-tracker/milestone/:id
 * 管理端：更新里程碑（状态、进度、日期、交付物、备注）
 */
router.put('/milestone/:id', async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const { status, progress, start_date, expected_date, completed_date, deliverables, notes, title, description } = req.body;

  const milestone = db.service_milestones.find(m => m.id === id);
  if (!milestone) {
    return res.status(404).json({ error: '里程碑不存在' });
  }

  const oldStatus = milestone.status;
  const updates = {};
  if (status !== undefined) updates.status = status;
  if (progress !== undefined) updates.progress = Math.max(0, Math.min(100, parseInt(progress)));
  if (start_date !== undefined) updates.start_date = start_date;
  if (expected_date !== undefined) updates.expected_date = expected_date;
  if (completed_date !== undefined) updates.completed_date = completed_date;
  if (deliverables !== undefined) updates.deliverables = deliverables;
  if (notes !== undefined) updates.notes = notes;
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;

  // 状态联动
  if (status === 'in_progress' && !milestone.start_date) {
    updates.start_date = new Date().toISOString().slice(0, 10);
  }
  if (status === 'done') {
    updates.progress = 100;
    updates.completed_date = new Date().toISOString().slice(0, 10);
  }
  if (status === 'pending' && oldStatus === 'done') {
    // 回退：重新打开
    updates.completed_date = '';
    updates.progress = 0;
  }

  Object.assign(milestone, updates);
  syncRow('service_milestones', milestone);

  // 状态变更通知
  if (status && status !== oldStatus) {
    const statusLabels = {
      pending: '待开始',
      in_progress: '进行中',
      done: '已完成',
      skipped: '已跳过'
    };

    try {
      if (status === 'in_progress') {
        await createNotification({
          type: 'service',
          title: '服务进度更新',
          content: `您的订单「${milestone.product_title}」进入「${milestone.title}」阶段。`,
          target_phones: [milestone.buyer_phone],
          link_type: 'service_tracker',
          link_id: String(milestone.order_id),
          icon: '🔨'
        });
      } else if (status === 'done') {
        await createNotification({
          type: 'service',
          title: '里程碑完成',
          content: `您的订单「${milestone.product_title}」里程碑「${milestone.title}」已完成。`,
          target_phones: [milestone.buyer_phone],
          link_type: 'service_tracker',
          link_id: String(milestone.order_id),
          icon: '✅'
        });
      }
    } catch (e) {
      console.warn('[service-tracker] 通知发送失败:', e.message);
    }
  }

  // 检查是否所有里程碑都完成，如果是则通知客户
  if (status === 'done') {
    const allMilestones = db.service_milestones.filter(m => m.order_id === milestone.order_id);
    const allDone = allMilestones.every(m => m.status === 'done' || m.status === 'skipped');
    if (allDone && allMilestones.length > 0) {
      try {
        const order = db.orders.find(o => o.id === milestone.order_id);
        await createNotification({
          type: 'service',
          title: '服务全部完成 🎉',
          content: `您的订单「${milestone.product_title}」所有交付阶段已完成！感谢您的信任。`,
          target_phones: [milestone.buyer_phone],
          link_type: 'service_tracker',
          link_id: String(milestone.order_id),
          icon: '🎉'
        });
      } catch (e) {
        console.warn('[service-tracker] 完成通知发送失败:', e.message);
      }
    }
  }

  auditLog(req, 'service_milestone_update', { id, old_status: oldStatus, new_status: status });

  res.json({ message: '里程碑已更新', milestone });
});

/**
 * DELETE /api/service-tracker/milestone/:id
 * 管理端：删除里程碑
 */
router.delete('/milestone/:id', (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);

  const idx = db.service_milestones.findIndex(m => m.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: '里程碑不存在' });
  }

  const milestone = db.service_milestones[idx];
  db.service_milestones.splice(idx, 1);

  // 重新排序
  const remaining = db.service_milestones
    .filter(m => m.order_id === milestone.order_id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  remaining.forEach((m, i) => {
    m.sort_order = i + 1;
    syncRow('service_milestones', m);
  });

  auditLog(req, 'service_milestone_delete', { id, order_id: milestone.order_id });

  res.json({ message: '里程碑已删除' });
});

/**
 * GET /api/service-tracker/templates
 * 获取默认里程碑模板列表（管理端参考用）
 */
router.get('/templates', (req, res) => {
  res.json(DEFAULT_TEMPLATES);
});

/**
 * GET /api/service-tracker/stats
 * 管理端：统计数据
 */
router.get('/stats', (req, res) => {
  const db = getDB();
  const all = db.service_milestones;

  const orderIds = [...new Set(all.map(m => m.order_id))];
  let activeOrders = 0;
  let completedOrders = 0;
  let totalProgress = 0;

  orderIds.forEach(oid => {
    const ms = all.filter(m => m.order_id === oid);
    const done = ms.filter(m => m.status === 'done').length;
    const skipped = ms.filter(m => m.status === 'skipped').length;
    const effective = ms.length - skipped;
    const progress = effective > 0 ? Math.round((done / effective) * 100) : 0;
    totalProgress += progress;
    if (progress >= 100) completedOrders++;
    else activeOrders++;
  });

  // 按阶段统计
  const stageStats = {};
  all.forEach(m => {
    if (!stageStats[m.title]) {
      stageStats[m.title] = { total: 0, pending: 0, in_progress: 0, done: 0, skipped: 0 };
    }
    stageStats[m.title].total++;
    stageStats[m.title][m.status]++;
  });

  res.json({
    total_orders: orderIds.length,
    active_orders: activeOrders,
    completed_orders: completedOrders,
    total_milestones: all.length,
    avg_progress: orderIds.length > 0 ? Math.round(totalProgress / orderIds.length) : 0,
    stage_stats: Object.entries(stageStats).map(([title, s]) => ({
      title,
      ...s,
      completion_rate: s.total > 0 ? Math.round((s.done / s.total) * 100) : 0
    }))
  });
});

module.exports = router;
module.exports.initMilestonesForOrder = initMilestonesForOrder;
module.exports.DEFAULT_TEMPLATES = DEFAULT_TEMPLATES;
