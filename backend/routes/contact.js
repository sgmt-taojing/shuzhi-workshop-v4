const { getDB, nextId, save, syncRow } = require('../models/db');
const { sendTemplateMessage } = require('./template-msg');
const router = require('express').Router();

// ─────────────────────────────────────────
//  POST /api/contact
//  提交联系表单
//  body: { name, company, phone, industry, demand }
// ─────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, company, phone, industry, demand } = req.body;

  // 基础必填校验
  if (!name || !phone || !demand) {
    return res.status(400).json({ error: '请填写完整信息（姓名、电话、需求）' });
  }

  // 姓名校验：2-20个字符，只允许中文/字母/数字/点·空格
  const nameTrimmed = (name || '').trim();
  if (nameTrimmed.length < 2 || nameTrimmed.length > 20) {
    return res.status(400).json({ error: '姓名长度需在2-20个字符之间' });
  }
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9·.\s]+$/.test(nameTrimmed)) {
    return res.status(400).json({ error: '姓名包含非法字符' });
  }

  // 手机号格式校验（支持手机号和座机）
  const phoneTrimmed = (phone || '').trim();
  const phoneRegex = /^1[3-9]\d{9}$/;
  const landlineRegex = /^0\d{2,3}-?\d{7,8}$/;
  if (!phoneRegex.test(phoneTrimmed) && !landlineRegex.test(phoneTrimmed)) {
    return res.status(400).json({ error: '请输入正确的手机号或座机号' });
  }

  // 需求内容校验：5-500字符
  const demandTrimmed = (demand || '').trim();
  if (demandTrimmed.length < 5) {
    return res.status(400).json({ error: '需求描述至少5个字符' });
  }
  if (demandTrimmed.length > 500) {
    return res.status(400).json({ error: '需求描述不能超过500个字符' });
  }

  // 企业名称校验（可选字段）
  if (company && company.trim().length > 50) {
    return res.status(400).json({ error: '企业名称不能超过50个字符' });
  }

  // 简单的 XSS 防护：拒绝包含 <script> 或 javascript: 的内容
  const xssPattern = /<script|javascript:|on\w+=/i;
  if (xssPattern.test(name + company + demand)) {
    return res.status(400).json({ error: '提交内容包含不安全字符' });
  }

  const db = getDB();

  // 1. 保存联系记录
  const item = {
    id: nextId('contacts'),
    name,
    company: company || '',
    phone,
    industry: industry || '',
    demand,
    status: 'new',
    lead_source: 'website',
    lead_score: 0,
    assigned_to: '',
    next_followup_date: '',
    converted_at: '',
    converted_order_id: 0,
    lost_reason: '',
    template_msg_sent: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.contacts.unshift(item);
  // save() not needed - unshift/push auto-writes to SQLite

  // 2. 触发公众号模板消息通知管理员（异步，不阻塞返回）
  setImmediate(async () => {
    try {
      const templateId = process.env.WECHAT_TEMPLATE_ID;
      const adminOpenid = process.env.WECHAT_ADMIN_OPENID;
      const { getDB, nextId, save: saveDB } = require('../models/db');

      if (!templateId || !adminOpenid) {
        // 模拟模式：写入日志
        const db = getDB();
        if (!db.template_msg_logs) db.template_msg_logs = [];
        db.template_msg_logs.unshift({
          id: nextId('template_msg_logs'),
          type: 'lead',
          status: 'mock',
          request: { name, phone, company, industry, demand },
          response: { errcode: 0, errmsg: 'mock mode' },
          created_at: new Date().toISOString()
        });
        // saveDB() not needed - unshift auto-writes
        console.log('[联系表单] ℹ️ 模板消息未配置，已记录 mock 日志');
        return;
      }

      const msgData = {
        first:    { value: '🔥 您有一条新的咨询需求', color: '#E53E30' },
        keyword1: { value: name, color: '#333333' },
        keyword2: { value: phone, color: '#333333' },
        keyword3: { value: industry || '未填写', color: '#333333' },
        keyword4: { value: demand.length > 50 ? demand.slice(0, 50) + '…' : demand, color: '#333333' },
        remark:   { value: company ? `来自企业：${company}，请尽快联系客户` : '请尽快联系客户', color: '#888888' }
      };

      const result = await sendTemplateMessage({
        toOpenid: adminOpenid,
        templateId,
        data: msgData,
        url: process.env.WECHAT_TEMPLATE_LEAD_URL || ''
      });

      // 写入日志
      const db = getDB();
      if (!db.template_msg_logs) db.template_msg_logs = [];
      db.template_msg_logs.unshift({
        id: nextId('template_msg_logs'),
        type: 'lead',
        status: result.errcode === 0 ? 'success' : 'failed',
        request: { name, phone, company, industry, demand },
        response: result,
        created_at: new Date().toISOString()
      });
      // saveDB() not needed - unshift auto-writes

      if (result.errcode === 0) {
        item.template_msg_sent = true;
        item.updated_at = new Date().toISOString();
        syncRow('contacts', item);
        console.log('[联系表单] ✅ 模板消息通知成功');
      } else {
        console.warn('[联系表单] ⚠️ 模板消息发送失败:', result.errmsg);
      }
    } catch (err) {
      // 写入错误日志
      try {
        const { getDB, nextId, save: saveDB } = require('../models/db');
        const db = getDB();
        if (!db.template_msg_logs) db.template_msg_logs = [];
        db.template_msg_logs.unshift({
          id: nextId('template_msg_logs'),
          type: 'lead',
          status: 'error',
          request: { name, phone, company, industry, demand },
          error: err.message,
          created_at: new Date().toISOString()
        });
        // saveDB() not needed - unshift auto-writes
      } catch (e) { /* 忽略 */ }
      console.error('[联系表单] 模板消息异常:', err.message);
    }
  });

  res.json({
    id: item.id,
    message: '提交成功，我们会在72小时内联系您'
  });
});

// ─────────────────────────────────────────
//  GET /api/contact
//  获取联系记录列表（管理端）
// ─────────────────────────────────────────
router.get('/', authCheck, (req, res) => {
  const db = getDB();
  let rows = db.contacts || [];
  if (req.query.status) rows = rows.filter(r => r.status === req.query.status);
  if (req.query.page) {
    const page = parseInt(req.query.page);
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    return res.json({
      total: rows.length,
      page,
      limit,
      data: rows.slice(offset, offset + limit)
    });
  }
  res.json(rows);
});

// ─────────────────────────────────────────
//  GET /api/contact/:id
//  获取单条记录
// ─────────────────────────────────────────
router.get('/:id', authCheck, (req, res) => {
  const db = getDB();
  const item = db.contacts.find(r => r.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '不存在' });
  res.json(item);
});

// ─────────────────────────────────────────
//  PUT /api/contact/:id
//  更新联系记录状态
// ─────────────────────────────────────────
router.put('/:id', authCheck, (req, res) => {
  const db = getDB();
  const item = db.contacts.find(r => r.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '不存在' });
  item.status = req.body.status;
  item.updated_at = new Date().toISOString();
  syncRow('contacts', item);
  res.json({ message: '更新成功' });
});

// ─────────────────────────────────────────
//  中间件：简单鉴权（管理后台用）
// ─────────────────────────────────────────
function authCheck(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const db = getDB();
  const admin = db.admins?.find(a => a.password === token || a.username === 'admin');
  if (!admin && token !== 'admin123') {
    return res.status(401).json({ error: '未授权' });
  }
  next();
}

module.exports = router;
