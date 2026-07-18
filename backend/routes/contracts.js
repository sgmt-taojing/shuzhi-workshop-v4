/**
 * 电子合同管理系统路由
 * 
 * 功能：
 * - 合同模板管理（CRUD）
 * - 合同创建（从模板/从订单生成）
 * - 合同签署流程（甲方签署 → 乙方签署 → 生效）
 * - 合同状态管理（草稿→待签→已签→生效→到期/终止）
 * - 合同查询、下载
 */

const { getDB, nextId, save, syncRow } = require('../models/db');
const { createNotification } = require('./notifications');
const { log: auditLog } = require('../middleware/audit');
const router = require('express').Router();

// ==================== 合同状态流转 ====================
const STATUS_TRANSITIONS = {
  draft: ['pending_sign', 'cancelled'],         // 草稿 → 待签署 / 已取消
  pending_sign: ['signed', 'cancelled'],         // 待签署 → 已签署 / 已取消
  signed: ['effective', 'cancelled'],            // 已签署 → 生效 / 已取消
  effective: ['expired', 'terminated'],           // 生效 → 到期 / 终止
  expired: [],                                     // 到期 → 终态
  terminated: [],                                  // 终止 → 终态
  cancelled: []                                    // 已取消 → 终态
};

function isValidStatusTransition(from, to) {
  const allowed = STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

const STATUS_LABELS = {
  draft: '草稿',
  pending_sign: '待签署',
  signed: '已签署',
  effective: '生效中',
  expired: '已到期',
  terminated: '已终止',
  cancelled: '已取消'
};

const TYPE_LABELS = {
  service: '服务合同',
  purchase: '采购合同',
  customization: '定制开发合同',
  nda: '保密协议',
  agency: '代理合同',
  other: '其他合同'
};

// ==================== 合同模板管理（管理端）====================

// 模板列表
router.get('/templates', (req, res) => {
  const db = getDB();
  let items = db.contract_templates || [];
  const { category, status, keyword } = req.query;
  if (category) items = items.filter(t => t.category === category);
  if (status !== undefined) items = items.filter(t => t.status === Number(status));
  if (keyword) {
    const kw = keyword.toLowerCase();
    items = items.filter(t => t.name.toLowerCase().includes(kw) || (t.code || '').toLowerCase().includes(kw));
  }
  res.json({
    code: 0,
    data: {
      items: items.map(t => ({
        ...t,
        status_label: t.status === 1 ? '启用' : '停用',
        category_label: TYPE_LABELS[t.category] || t.category
      })),
      total: items.length
    }
  });
});

// 模板详情
router.get('/templates/:id', (req, res) => {
  const db = getDB();
  const item = (db.contract_templates || []).find(t => t.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '模板不存在' });
  res.json({ code: 0, data: { ...item, category_label: TYPE_LABELS[item.category] || item.category } });
});

// 创建模板
router.post('/templates', (req, res) => {
  const { name, code, category, content, clauses, variables, status, version, creator } = req.body;
  if (!name) return res.status(400).json({ error: '模板名称不能为空' });

  const db = getDB();
  const id = nextId('contract_templates');
  const template = {
    id,
    name,
    code: code || `TPL${Date.now()}`,
    category: category || 'service',
    content: content || '',
    clauses: clauses || [],
    variables: variables || [],
    status: status !== undefined ? status : 1,
    version: version || '1.0',
    creator: creator || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.contract_templates) db.contract_templates = [];
  db.contract_templates.push(template);
  syncRow('contract_templates', template);

  auditLog('contract_template_create', `创建合同模板: ${name}`, req);
  res.json({ code: 0, data: template, message: '模板创建成功' });
});

// 更新模板
router.put('/templates/:id', (req, res) => {
  const db = getDB();
  const item = (db.contract_templates || []).find(t => t.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '模板不存在' });

  const { name, code, category, content, clauses, variables, status, version } = req.body;
  if (name) item.name = name;
  if (code) item.code = code;
  if (category) item.category = category;
  if (content !== undefined) item.content = content;
  if (clauses !== undefined) item.clauses = clauses;
  if (variables !== undefined) item.variables = variables;
  if (status !== undefined) item.status = status;
  if (version) item.version = version;
  item.updated_at = new Date().toISOString();
  syncRow('contract_templates', item);

  auditLog('contract_template_update', `更新合同模板: ${item.name}`, req);
  res.json({ code: 0, data: item, message: '模板更新成功' });
});

// 删除模板
router.delete('/templates/:id', (req, res) => {
  const db = getDB();
  const idx = (db.contract_templates || []).findIndex(t => t.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: '模板不存在' });

  const item = db.contract_templates[idx];
  // 检查是否有合同在使用
  const inUse = (db.contracts || []).some(c => c.template_id === item.id);
  if (inUse) return res.status(400).json({ error: '该模板已被合同使用，无法删除，请停用' });

  db.contract_templates.splice(idx, 1);
  const d = require('../models/sqlite-db').getDB();
  d.prepare('DELETE FROM contract_templates WHERE id = ?').run(item.id);

  auditLog('contract_template_delete', `删除合同模板: ${item.name}`, req);
  res.json({ code: 0, message: '模板已删除' });
});

// ==================== 合同管理（用户端）====================

// 用户合同列表
router.get('/', (req, res) => {
  const { phone, openid, status, page = 1, page_size = 20 } = req.query;
  if (!phone && !openid) return res.status(400).json({ error: '需要 phone 或 openid 参数' });

  let items = getDB().contracts || [];
  if (phone) items = items.filter(c => c.buyer_phone === phone);
  if (openid) items = items.filter(c => c.buyer_openid === openid);
  if (status) items = items.filter(c => c.status === status);

  items = items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const total = items.length;
  const start = (page - 1) * page_size;
  const paged = items.slice(start, start + Number(page_size));

  res.json({
    code: 0,
    data: {
      items: paged.map(c => ({
        ...c,
        status_label: STATUS_LABELS[c.status] || c.status,
        type_label: TYPE_LABELS[c.type] || c.type
      })),
      total,
      page: Number(page),
      page_size: Number(page_size)
    }
  });
});

// 合同详情
router.get('/:id', (req, res) => {
  const item = (getDB().contracts || []).find(c => c.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '合同不存在' });

  res.json({
    code: 0,
    data: {
      ...item,
      status_label: STATUS_LABELS[item.status] || item.status,
      type_label: TYPE_LABELS[item.type] || item.type
    }
  });
});

// 通过合同编号查询
router.get('/no/:contractNo', (req, res) => {
  const item = (getDB().contracts || []).find(c => c.contract_no === req.params.contractNo);
  if (!item) return res.status(404).json({ error: '合同不存在' });

  res.json({
    code: 0,
    data: {
      ...item,
      status_label: STATUS_LABELS[item.status] || item.status,
      type_label: TYPE_LABELS[item.type] || item.type
    }
  });
});

// 甲方签署合同
router.post('/:id/sign', (req, res) => {
  const db = getDB();
  const item = (db.contracts || []).find(c => c.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '合同不存在' });
  if (item.status !== 'pending_sign') return res.status(400).json({ error: `当前状态(${STATUS_LABELS[item.status]})不可签署` });
  if (item.party_a_signed) return res.status(400).json({ error: '甲方已签署' });

  const { sign_ip, buyer_openid } = req.body;
  item.party_a_signed = 1;
  item.party_a_signed_at = new Date().toISOString();
  item.party_a_sign_ip = sign_ip || '';
  if (buyer_openid) item.buyer_openid = buyer_openid;

  // 如果乙方也已签署，自动转为已签署
  if (item.party_b_signed) {
    item.status = 'signed';
    // 自动生效
    item.effective_at = new Date().toISOString();
    if (item.service_period) {
      const months = parseInt(item.service_period) || 12;
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + months);
      item.expired_at = endDate.toISOString();
    }
  }

  item.updated_at = new Date().toISOString();
  syncRow('contracts', item);

  // 通知
  createNotification({
    type: 'contract',
    title: '合同已签署',
    content: `合同 ${item.contract_no}（${item.title}）甲方已签署${item.status === 'signed' ? '，合同已生效' : '，等待乙方签署'}`,
    target_phones: [item.buyer_phone],
    link_type: 'contract',
    link_id: String(item.id),
    icon: '✍️'
  });

  auditLog('contract_sign_a', `甲方签署合同: ${item.contract_no}`, req);
  res.json({ code: 0, data: item, message: '签署成功' });
});

// ==================== 合同管理（管理端）====================

// 管理端合同列表
router.get('/admin/list', (req, res) => {
  const { status, type, keyword, page = 1, page_size = 20 } = req.query;
  let items = getDB().contracts || [];

  if (status) items = items.filter(c => c.status === status);
  if (type) items = items.filter(c => c.type === type);
  if (keyword) {
    const kw = keyword.toLowerCase();
    items = items.filter(c =>
      c.contract_no.toLowerCase().includes(kw) ||
      c.title.toLowerCase().includes(kw) ||
      (c.party_a_name || '').toLowerCase().includes(kw) ||
      (c.buyer_phone || '').includes(kw)
    );
  }

  items = items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const total = items.length;
  const start = (page - 1) * page_size;
  const paged = items.slice(start, start + Number(page_size));

  // 统计概览
  const allContracts = getDB().contracts || [];
  const stats = {
    total: allContracts.length,
    draft: allContracts.filter(c => c.status === 'draft').length,
    pending_sign: allContracts.filter(c => c.status === 'pending_sign').length,
    signed: allContracts.filter(c => c.status === 'signed').length,
    effective: allContracts.filter(c => c.status === 'effective').length,
    expired: allContracts.filter(c => c.status === 'expired').length,
    terminated: allContracts.filter(c => c.status === 'terminated').length,
    total_amount: allContracts.filter(c => c.status === 'effective' || c.status === 'signed').reduce((s, c) => s + (c.amount || 0), 0)
  };

  res.json({
    code: 0,
    data: {
      items: paged.map(c => ({
        ...c,
        status_label: STATUS_LABELS[c.status] || c.status,
        type_label: TYPE_LABELS[c.type] || c.type
      })),
      total,
      page: Number(page),
      page_size: Number(page_size),
      stats
    }
  });
});

// 管理端合同详情
router.get('/admin/:id', (req, res) => {
  const item = (getDB().contracts || []).find(c => c.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '合同不存在' });
  res.json({
    code: 0,
    data: {
      ...item,
      status_label: STATUS_LABELS[item.status] || item.status,
      type_label: TYPE_LABELS[item.type] || item.type
    }
  });
});

// 创建合同（手动或从订单生成）
router.post('/admin/create', (req, res) => {
  const {
    title, template_id, type,
    party_a_name, party_a_contact, party_a_phone, party_a_address,
    product_title, product_id, order_id, order_no,
    amount, service_period, service_start_date,
    content, clauses, custom_terms, attachments,
    buyer_openid, buyer_phone, remark
  } = req.body;

  if (!title) return res.status(400).json({ error: '合同标题不能为空' });
  if (!party_a_name) return res.status(400).json({ error: '甲方名称不能为空' });
  if (!party_a_phone) return res.status(400).json({ error: '甲方联系电话不能为空' });

  const db = getDB();
  const contractNo = 'HT' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();

  // 如果指定了模板，加载模板内容
  let templateName = '';
  let finalContent = content || '';
  let finalClauses = clauses || [];
  if (template_id) {
    const tpl = (db.contract_templates || []).find(t => t.id === Number(template_id));
    if (tpl) {
      templateName = tpl.name;
      if (!finalContent) finalContent = tpl.content;
      if (!finalClauses.length) finalClauses = tpl.clauses || [];
    }
  }

  const id = nextId('contracts');
  const contract = {
    id,
    contract_no: contractNo,
    title,
    template_id: Number(template_id) || 0,
    template_name: templateName,
    type: type || 'service',
    party_a_name,
    party_a_contact: party_a_contact || '',
    party_a_phone,
    party_a_address: party_a_address || '',
    party_b_name: '数造工坊（济南）科技有限公司',
    party_b_contact: '',
    party_b_phone: '',
    party_b_address: '山东省济南市高新区',
    product_title: product_title || '',
    product_id: Number(product_id) || 0,
    order_id: Number(order_id) || 0,
    order_no: order_no || '',
    amount: Number(amount) || 0,
    service_period: service_period || '12',
    service_start_date: service_start_date || '',
    service_end_date: '',
    content: finalContent,
    clauses: finalClauses,
    custom_terms: custom_terms || '',
    attachments: attachments || [],
    status: 'draft',
    party_a_signed: 0,
    party_a_signed_at: '',
    party_a_sign_ip: '',
    party_b_signed: 0,
    party_b_signed_at: '',
    party_b_sign_ip: '',
    effective_at: '',
    expired_at: '',
    terminated_at: '',
    terminate_reason: '',
    buyer_openid: buyer_openid || '',
    buyer_phone: buyer_phone || party_a_phone,
    remark: remark || '',
    admin_remark: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (!db.contracts) db.contracts = [];
  db.contracts.push(contract);
  syncRow('contracts', contract);

  auditLog('contract_create', `创建合同: ${contractNo} (${title})`, req);
  res.json({ code: 0, data: contract, message: '合同创建成功' });
});

// 从订单生成合同
router.post('/admin/from-order/:orderId', (req, res) => {
  const db = getDB();
  const order = (db.orders || []).find(o => o.id === Number(req.params.orderId));
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.status !== 'paid' && order.status !== 'shipped' && order.status !== 'completed') {
    return res.status(400).json({ error: '订单状态不支持生成合同（需已支付）' });
  }

  // 检查是否已有合同
  const existing = (db.contracts || []).find(c => c.order_id === order.id && c.status !== 'cancelled');
  if (existing) return res.status(400).json({ error: `该订单已有合同: ${existing.contract_no}` });

  const { service_period, content, custom_terms, template_id } = req.body;

  // 获取默认模板
  let templateName = '';
  let finalContent = content || '';
  let finalClauses = [];
  const tid = Number(template_id);
  if (tid) {
    const tpl = (db.contract_templates || []).find(t => t.id === tid);
    if (tpl) {
      templateName = tpl.name;
      if (!finalContent) finalContent = tpl.content;
      finalClauses = tpl.clauses || [];
    }
  }

  const contractNo = 'HT' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const id = nextId('contracts');
  const contract = {
    id,
    contract_no: contractNo,
    title: `${order.product_title} - 服务合同`,
    template_id: tid || 0,
    template_name: templateName,
    type: 'service',
    party_a_name: order.buyer_name,
    party_a_contact: order.buyer_name,
    party_a_phone: order.buyer_phone,
    party_a_address: '',
    party_b_name: '数造工坊（济南）科技有限公司',
    party_b_contact: '',
    party_b_phone: '',
    party_b_address: '山东省济南市高新区',
    product_title: order.product_title,
    product_id: order.product_id,
    order_id: order.id,
    order_no: order.order_no,
    amount: order.amount,
    service_period: service_period || '12',
    service_start_date: new Date().toISOString().slice(0, 10),
    service_end_date: '',
    content: finalContent || getDefaultContractContent(order),
    clauses: finalClauses,
    custom_terms: custom_terms || '',
    attachments: [],
    status: 'draft',
    party_a_signed: 0,
    party_a_signed_at: '',
    party_a_sign_ip: '',
    party_b_signed: 0,
    party_b_signed_at: '',
    party_b_sign_ip: '',
    effective_at: '',
    expired_at: '',
    terminated_at: '',
    terminate_reason: '',
    buyer_openid: order.buyer_openid || '',
    buyer_phone: order.buyer_phone,
    remark: `由订单 ${order.order_no} 自动生成`,
    admin_remark: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (!db.contracts) db.contracts = [];
  db.contracts.push(contract);
  syncRow('contracts', contract);

  // 通知用户
  createNotification({
    type: 'contract',
    title: '合同已生成',
    content: `您的订单 ${order.order_no} 已生成服务合同 ${contractNo}，请查看并签署`,
    target_phones: [order.buyer_phone],
    link_type: 'contract',
    link_id: String(id),
    icon: '📄'
  });

  auditLog('contract_from_order', `从订单生成合同: ${contractNo} (订单: ${order.order_no})`, req);
  res.json({ code: 0, data: contract, message: '合同已从订单生成' });
});

// 更新合同
router.put('/admin/:id', (req, res) => {
  const db = getDB();
  const item = (db.contracts || []).find(c => c.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '合同不存在' });
  if (item.party_a_signed || item.party_b_signed) {
    return res.status(400).json({ error: '合同已签署，不可修改内容' });
  }

  const fields = [
    'title', 'type', 'party_a_name', 'party_a_contact', 'party_a_phone', 'party_a_address',
    'party_b_name', 'party_b_contact', 'party_b_phone', 'party_b_address',
    'product_title', 'amount', 'service_period', 'service_start_date',
    'content', 'clauses', 'custom_terms', 'attachments', 'remark', 'admin_remark'
  ];

  fields.forEach(f => {
    if (req.body[f] !== undefined) item[f] = req.body[f];
  });
  item.updated_at = new Date().toISOString();
  syncRow('contracts', item);

  auditLog('contract_update', `更新合同: ${item.contract_no}`, req);
  res.json({ code: 0, data: item, message: '合同更新成功' });
});

// 合同状态流转
router.put('/admin/:id/status', (req, res) => {
  const db = getDB();
  const item = (db.contracts || []).find(c => c.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '合同不存在' });

  const { status, terminate_reason } = req.body;
  if (!isValidStatusTransition(item.status, status)) {
    return res.status(400).json({ error: `状态不能从 ${STATUS_LABELS[item.status]} 变更为 ${STATUS_LABELS[status]}` });
  }

  item.status = status;
  item.updated_at = new Date().toISOString();

  if (status === 'pending_sign') {
    // 发起签署流程，通知甲方
    createNotification({
      type: 'contract',
      title: '合同待签署',
      content: `合同 ${item.contract_no}（${item.title}）已发起签署，请尽快完成签署`,
      target_phones: [item.buyer_phone],
      link_type: 'contract',
      link_id: String(item.id),
      icon: '✍️'
    });
  } else if (status === 'effective') {
    item.effective_at = new Date().toISOString();
    if (item.service_period && !item.expired_at) {
      const months = parseInt(item.service_period) || 12;
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + months);
      item.expired_at = endDate.toISOString();
    }
  } else if (status === 'terminated') {
    item.terminated_at = new Date().toISOString();
    item.terminate_reason = terminate_reason || '';
    createNotification({
      type: 'contract',
      title: '合同已终止',
      content: `合同 ${item.contract_no}（${item.title}）已终止${terminate_reason ? '，原因：' + terminate_reason : ''}`,
      target_phones: [item.buyer_phone],
      link_type: 'contract',
      link_id: String(item.id),
      icon: '⚠️'
    });
  } else if (status === 'cancelled') {
    createNotification({
      type: 'contract',
      title: '合同已取消',
      content: `合同 ${item.contract_no}（${item.title}）已取消`,
      target_phones: [item.buyer_phone],
      link_type: 'contract',
      link_id: String(item.id),
      icon: '❌'
    });
  }

  syncRow('contracts', item);
  auditLog('contract_status_change', `合同状态变更: ${item.contract_no} ${item.status} → ${status}`, req);
  res.json({ code: 0, data: item, message: '状态更新成功' });
});

// 乙方签署
router.post('/admin/:id/sign-b', (req, res) => {
  const db = getDB();
  const item = (db.contracts || []).find(c => c.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '合同不存在' });
  if (item.status !== 'pending_sign' && item.status !== 'signed') {
    return res.status(400).json({ error: `当前状态(${STATUS_LABELS[item.status]})不可签署` });
  }
  if (item.party_b_signed) return res.status(400).json({ error: '乙方已签署' });

  const { sign_ip } = req.body;
  item.party_b_signed = 1;
  item.party_b_signed_at = new Date().toISOString();
  item.party_b_sign_ip = sign_ip || '';

  // 如果甲方也已签署，自动转为已签署并生效
  if (item.party_a_signed) {
    item.status = 'signed';
    item.effective_at = new Date().toISOString();
    if (item.service_period) {
      const months = parseInt(item.service_period) || 12;
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + months);
      item.expired_at = endDate.toISOString();
    }
    createNotification({
      type: 'contract',
      title: '合同已生效',
      content: `合同 ${item.contract_no}（${item.title}）双方已签署，合同正式生效`,
      target_phones: [item.buyer_phone],
      link_type: 'contract',
      link_id: String(item.id),
      icon: '✅'
    });
  }

  item.updated_at = new Date().toISOString();
  syncRow('contracts', item);

  auditLog('contract_sign_b', `乙方签署合同: ${item.contract_no}`, req);
  res.json({ code: 0, data: item, message: '乙方签署成功' });
});

// 合同统计
router.get('/admin/stats/overview', (req, res) => {
  const all = getDB().contracts || [];
  const now = new Date();

  // 按类型统计
  const byType = {};
  Object.keys(TYPE_LABELS).forEach(t => { byType[t] = 0; });
  all.forEach(c => { if (byType[c.type] !== undefined) byType[c.type]++; });

  // 按状态统计
  const byStatus = {};
  Object.keys(STATUS_LABELS).forEach(s => { byStatus[s] = 0; });
  all.forEach(c => { if (byStatus[c.status] !== undefined) byStatus[c.status]++; });

  // 金额统计
  const effectiveContracts = all.filter(c => c.status === 'effective');
  const totalAmount = effectiveContracts.reduce((s, c) => s + (c.amount || 0), 0);

  // 即将到期（30天内）
  const expiringSoon = all.filter(c => {
    if (c.status !== 'effective' || !c.expired_at) return false;
    const days = (new Date(c.expired_at) - now) / (1000 * 60 * 60 * 24);
    return days > 0 && days <= 30;
  }).length;

  // 30天趋势
  const trend = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayContracts = all.filter(c => c.created_at.slice(0, 10) === dateStr);
    trend.push({
      date: dateStr,
      count: dayContracts.length,
      amount: dayContracts.reduce((s, c) => s + (c.amount || 0), 0)
    });
  }

  res.json({
    code: 0,
    data: {
      total: all.length,
      by_type: byType,
      by_status: byStatus,
      total_amount: totalAmount,
      expiring_soon: expiringSoon,
      type_labels: TYPE_LABELS,
      status_labels: STATUS_LABELS,
      trend
    }
  });
});

// ==================== 辅助函数 ====================

function getDefaultContractContent(order) {
  return `
# 服务合同

## 合同编号：${order.order_no}

甲方（委托方）：${order.buyer_name}
联系方式：${order.buyer_phone}

乙方（服务方）：数造工坊（济南）科技有限公司
地址：山东省济南市高新区

---

## 第一条 服务内容

乙方向甲方提供以下产品/服务：
- 产品名称：${order.product_title}
- 服务金额：¥${Number(order.amount).toFixed(2)}

## 第二条 服务期限

本合同服务期限为 12 个月，自合同生效之日起计算。

## 第三条 付款方式

甲方应在签署本合同后按约定支付服务费用。

## 第四条 双方权利义务

1. 乙方应按约定提供产品/服务，保证服务质量；
2. 甲方应按约定支付费用，配合乙方开展工作；
3. 双方应对合作中知悉的对方商业信息保密。

## 第五条 违约责任

任何一方违反本合同约定，应承担违约责任，赔偿对方因此造成的损失。

## 第六条 争议解决

本合同履行过程中发生争议，双方应友好协商解决；协商不成的，可向乙方所在地人民法院提起诉讼。

## 第七条 其他

1. 本合同自双方签署之日起生效；
2. 本合同一式两份，双方各执一份，具有同等法律效力。

---

甲方（签章）：________________
日期：________________

乙方（签章）：________________
日期：________________
`;
}

module.exports = router;
