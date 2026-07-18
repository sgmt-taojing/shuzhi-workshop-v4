/**
 * 发票管理 API
 *
 * B2B 发票管理系统，支持：
 * - 用户端：申请发票、查看发票列表、查看详情、下载/预览发票
 * - 管理端：发票列表、审核开票、拒绝、作废、统计
 *
 * 发票类型：
 *   - normal:   增值税普通电子发票
 *   - special:  增值税专用发票
 *   - paper:    纸质发票
 *
 * 状态流转：
 *   pending → issued（已开票）/ rejected（已拒绝）
 *   issued  → voided（已作废）
 */

const { getDB, nextId, save, syncRow } = require('../models/db');
const { createNotification } = require('./notifications');
const { log: auditLog } = require('../middleware/audit');
const router = require('express').Router();

// ==================== 工具函数 ====================

function isValidPhone(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone));
}

function isValidEmail(email) {
  return /^[\w.-]+@[\w.-]+\.\w+$/.test(String(email || ''));
}

function isValidTaxNo(taxNo) {
  // 税号：15位、18位或20位社会信用代码
  const t = String(taxNo || '').replace(/\s/g, '');
  return /^[A-Z0-9]{15}$|^[A-Z0-9]{18}$|^[A-Z0-9]{20}$/.test(t);
}

function generateInvoiceNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `INV${ymd}${rand}`;
}

// ==================== 用户端接口 ====================

/**
 * GET /api/invoices
 * 用户查看自己的发票列表（按手机号查询）
 */
router.get('/', (req, res) => {
  const db = getDB();
  const { phone, status, page = 1, pageSize = 20 } = req.query;

  if (!phone) {
    return res.status(400).json({ error: '缺少手机号参数' });
  }

  let invoices = (db.invoices || []).filter(inv => inv.applicant_phone === phone);

  if (status) {
    invoices = invoices.filter(inv => inv.status === status);
  }

  invoices = invoices.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // 分页
  const total = invoices.length;
  const start = (Number(page) - 1) * Number(pageSize);
  const list = invoices.slice(start, start + Number(pageSize));

  res.json({
    code: 0,
    data: list,
    total,
    page: Number(page),
    pageSize: Number(pageSize)
  });
});

/**
 * GET /api/invoices/:id
 * 获取发票详情
 */
router.get('/:id', (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const invoice = (db.invoices || []).find(inv => inv.id === id);

  if (!invoice) {
    return res.status(404).json({ error: '发票不存在' });
  }

  res.json({ code: 0, data: invoice });
});

/**
 * POST /api/invoices
 * 用户提交开票申请
 */
router.post('/', (req, res) => {
  const db = getDB();
  const {
    order_id, order_no, applicant_name, applicant_phone, applicant_openid,
    invoice_type, title_type, title_name, tax_no,
    bank_name, bank_account, company_address, company_phone,
    email, receiving_address, receiving_name, receiving_phone,
    amount, content, remark
  } = req.body;

  // 基础校验
  if (!order_id || !order_no) {
    return res.status(400).json({ error: '缺少订单信息' });
  }
  if (!applicant_name || !applicant_phone) {
    return res.status(400).json({ error: '缺少申请人信息' });
  }
  if (!isValidPhone(applicant_phone)) {
    return res.status(400).json({ error: '手机号格式不正确' });
  }
  if (!title_name) {
    return res.status(400).json({ error: '请填写发票抬头' });
  }

  // 验证订单存在
  const order = (db.orders || []).find(o => o.id === Number(order_id));
  if (!order) {
    return res.status(400).json({ error: '关联订单不存在' });
  }

  // 只有已支付/已发货/已完成的订单可以开票
  if (!['paid', 'shipped', 'completed'].includes(order.status)) {
    return res.status(400).json({ error: '当前订单状态不支持开票' });
  }

  // 检查是否已开过发票（同一订单只能开一次，除非之前的被拒绝/作废）
  const existing = (db.invoices || []).find(
    inv => inv.order_id === Number(order_id) && ['pending', 'issued'].includes(inv.status)
  );
  if (existing) {
    return res.status(400).json({ error: '该订单已有发票申请在处理中或已开票' });
  }

  // 专票必填校验
  if (invoice_type === 'special') {
    if (!tax_no) return res.status(400).json({ error: '专用发票需提供税号' });
    if (!isValidTaxNo(tax_no)) return res.status(400).json({ error: '税号格式不正确' });
    if (!bank_name || !bank_account) return res.status(400).json({ error: '专用发票需提供开户行及账号' });
    if (!company_address || !company_phone) return res.status(400).json({ error: '专用发票需提供公司地址及电话' });
  }

  // 企业抬头需税号
  if (title_type === 'enterprise' && !tax_no) {
    return res.status(400).json({ error: '企业抬头需提供税号' });
  }
  if (title_type === 'enterprise' && tax_no && !isValidTaxNo(tax_no)) {
    return res.status(400).json({ error: '税号格式不正确' });
  }

  // 邮箱校验（电子发票必填）
  if (invoice_type === 'normal' && !email) {
    return res.status(400).json({ error: '电子发票需提供接收邮箱' });
  }
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }

  // 纸质发票需收件信息
  if (invoice_type === 'paper') {
    if (!receiving_name || !receiving_phone || !receiving_address) {
      return res.status(400).json({ error: '纸质发票需提供收件信息' });
    }
  }

  const invoice = {
    id: nextId('invoices'),
    invoice_no: generateInvoiceNo(),
    order_id: Number(order_id),
    order_no,
    applicant_name,
    applicant_phone,
    applicant_openid: applicant_openid || '',
    invoice_type: invoice_type || 'normal',
    title_type: title_type || 'enterprise',
    title_name,
    tax_no: tax_no || '',
    bank_name: bank_name || '',
    bank_account: bank_account || '',
    company_address: company_address || '',
    company_phone: company_phone || '',
    email: email || '',
    receiving_address: receiving_address || '',
    receiving_name: receiving_name || '',
    receiving_phone: receiving_phone || '',
    amount: Number(amount) || order.amount || 0,
    content: content || order.product_title || '',
    remark: remark || '',
    status: 'pending',
    invoice_file_url: '',
    invoice_number: '',
    issued_at: '',
    issued_by: '',
    reject_reason: '',
    rejected_at: '',
    rejected_by: '',
    voided_at: '',
    voided_reason: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (!db.invoices) db.invoices = [];
  db.invoices.push(invoice);

  // 通知管理端
  createNotification({
    title: `新发票申请：${invoice.title_name}`,
    content: `订单 ${order_no} 的发票申请（¥${invoice.amount}），类型：${invoice.invoice_type === 'special' ? '专票' : invoice.invoice_type === 'paper' ? '纸质' : '普票'}，请及时处理`,
    type: 'invoice',
    target_phones: []
  });

  auditLog(req, 'invoice_create', { invoice_no: invoice.invoice_no, order_no });

  res.json({ code: 0, data: invoice, message: '发票申请已提交，预计1-3个工作日处理' });
});

/**
 * GET /api/invoices/order/:orderId
 * 按订单查询发票
 */
router.get('/order/:orderId', (req, res) => {
  const db = getDB();
  const orderId = Number(req.params.orderId);
  const invoices = (db.invoices || []).filter(inv => inv.order_id === orderId);
  res.json({ code: 0, data: invoices });
});

// ==================== 管理端接口 ====================

/**
 * GET /api/invoices/admin/list
 * 管理端发票列表
 */
router.get('/admin/list', (req, res) => {
  const db = getDB();
  const { status, invoice_type, keyword, page = 1, pageSize = 20 } = req.query;

  let invoices = db.invoices || [];

  if (status) invoices = invoices.filter(inv => inv.status === status);
  if (invoice_type) invoices = invoices.filter(inv => inv.invoice_type === invoice_type);
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    invoices = invoices.filter(inv =>
      inv.title_name.toLowerCase().includes(kw) ||
      inv.invoice_no.toLowerCase().includes(kw) ||
      inv.order_no.toLowerCase().includes(kw) ||
      inv.applicant_name.toLowerCase().includes(kw) ||
      inv.applicant_phone.includes(kw)
    );
  }

  invoices = invoices.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // 统计概览
  const all = db.invoices || [];
  const stats = {
    total: all.length,
    pending: all.filter(i => i.status === 'pending').length,
    issued: all.filter(i => i.status === 'issued').length,
    rejected: all.filter(i => i.status === 'rejected').length,
    voided: all.filter(i => i.status === 'voided').length,
    totalAmount: all.filter(i => i.status === 'issued').reduce((s, i) => s + (i.amount || 0), 0),
    pendingAmount: all.filter(i => i.status === 'pending').reduce((s, i) => s + (i.amount || 0), 0),
    byType: {
      normal: all.filter(i => i.invoice_type === 'normal').length,
      special: all.filter(i => i.invoice_type === 'special').length,
      paper: all.filter(i => i.invoice_type === 'paper').length
    }
  };

  const total = invoices.length;
  const start = (Number(page) - 1) * Number(pageSize);
  const list = invoices.slice(start, start + Number(pageSize));

  res.json({
    code: 0,
    data: list,
    stats,
    total,
    page: Number(page),
    pageSize: Number(pageSize)
  });
});

/**
 * POST /api/invoices/admin/:id/issue
 * 管理端开票（审核通过并发票号码）
 */
router.post('/admin/:id/issue', (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const { invoice_number, invoice_file_url } = req.body;

  const invoice = (db.invoices || []).find(inv => inv.id === id);
  if (!invoice) {
    return res.status(404).json({ error: '发票不存在' });
  }
  if (invoice.status !== 'pending') {
    return res.status(400).json({ error: '仅待开票状态可操作' });
  }

  invoice.status = 'issued';
  invoice.invoice_number = invoice_number || ('F' + Date.now());
  invoice.invoice_file_url = invoice_file_url || '';
  invoice.issued_at = new Date().toISOString();
  invoice.issued_by = req.admin?.username || 'admin';
  invoice.updated_at = new Date().toISOString();
  syncRow('invoices', invoice);

  // 通知用户
  createNotification({
    title: `发票已开出：${invoice.invoice_no}`,
    content: `您的${invoice.invoice_type === 'special' ? '增值税专用发票' : invoice.invoice_type === 'paper' ? '纸质发票' : '电子发票'}已开出，发票号码：${invoice.invoice_number}${invoice.invoice_file_url ? '，可点击查看下载' : ''}`,
    type: 'invoice',
    target_phones: [invoice.applicant_phone]
  });

  auditLog(req, 'invoice_issue', { id, invoice_no: invoice.invoice_no, invoice_number: invoice.invoice_number });

  res.json({ code: 0, data: invoice, message: '发票已开出' });
});

/**
 * POST /api/invoices/admin/:id/reject
 * 管理端拒绝开票
 */
router.post('/admin/:id/reject', (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: '请提供拒绝原因' });
  }

  const invoice = (db.invoices || []).find(inv => inv.id === id);
  if (!invoice) {
    return res.status(404).json({ error: '发票不存在' });
  }
  if (invoice.status !== 'pending') {
    return res.status(400).json({ error: '仅待开票状态可操作' });
  }

  invoice.status = 'rejected';
  invoice.reject_reason = reason;
  invoice.rejected_at = new Date().toISOString();
  invoice.rejected_by = req.admin?.username || 'admin';
  invoice.updated_at = new Date().toISOString();
  syncRow('invoices', invoice);

  // 通知用户
  createNotification({
    title: `发票申请未通过：${invoice.invoice_no}`,
    content: `您的发票申请被退回，原因：${reason}。请修改后重新提交。`,
    type: 'invoice',
    target_phones: [invoice.applicant_phone]
  });

  auditLog(req, 'invoice_reject', { id, invoice_no: invoice.invoice_no, reason });

  res.json({ code: 0, data: invoice, message: '已拒绝开票申请' });
});

/**
 * POST /api/invoices/admin/:id/void
 * 管理端作废已开发票
 */
router.post('/admin/:id/void', (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: '请提供作废原因' });
  }

  const invoice = (db.invoices || []).find(inv => inv.id === id);
  if (!invoice) {
    return res.status(404).json({ error: '发票不存在' });
  }
  if (invoice.status !== 'issued') {
    return res.status(400).json({ error: '仅已开票状态可作废' });
  }

  invoice.status = 'voided';
  invoice.voided_reason = reason;
  invoice.voided_at = new Date().toISOString();
  invoice.updated_at = new Date().toISOString();
  syncRow('invoices', invoice);

  // 通知用户
  createNotification({
    title: `发票已作废：${invoice.invoice_no}`,
    content: `您的发票（号码：${invoice.invoice_number}）已被作废，原因：${reason}。如有疑问请联系客服。`,
    type: 'invoice',
    target_phones: [invoice.applicant_phone]
  });

  auditLog(req, 'invoice_void', { id, invoice_no: invoice.invoice_no, reason });

  res.json({ code: 0, data: invoice, message: '发票已作废' });
});

/**
 * GET /api/invoices/admin/stats
 * 管理端发票统计
 */
router.get('/admin/stats', (req, res) => {
  const db = getDB();
  const all = db.invoices || [];

  // 近30天趋势
  const now = Date.now();
  const days30 = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const ymd = d.toISOString().slice(0, 10);
    const dayInvoices = all.filter(inv => inv.created_at && inv.created_at.slice(0, 10) === ymd);
    days30.push({
      date: ymd,
      count: dayInvoices.length,
      amount: dayInvoices.reduce((s, i) => s + (i.amount || 0), 0)
    });
  }

  // 按发票类型统计
  const byType = {
    normal: all.filter(i => i.invoice_type === 'normal').length,
    special: all.filter(i => i.invoice_type === 'special').length,
    paper: all.filter(i => i.invoice_type === 'paper').length
  };

  // 按抬头类型统计
  const byTitleType = {
    enterprise: all.filter(i => i.title_type === 'enterprise').length,
    personal: all.filter(i => i.title_type === 'personal').length
  };

  res.json({
    code: 0,
    data: {
      total: all.length,
      pending: all.filter(i => i.status === 'pending').length,
      issued: all.filter(i => i.status === 'issued').length,
      rejected: all.filter(i => i.status === 'rejected').length,
      voided: all.filter(i => i.status === 'voided').length,
      totalAmount: all.filter(i => i.status === 'issued').reduce((s, i) => s + (i.amount || 0), 0),
      pendingAmount: all.filter(i => i.status === 'pending').reduce((s, i) => s + (i.amount || 0), 0),
      trend30: days30,
      byType,
      byTitleType
    }
  });
});

module.exports = router;
