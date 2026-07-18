/**
 * 小程序订阅消息系统
 *
 * 功能：
 * 1. 管理订阅消息模板（CRUD）
 * 2. 记录用户订阅授权（wx.requestSubscribeMessage 后上报）
 * 3. 发送订阅消息（通过微信 API）
 * 4. 查看发送日志
 * 5. 管理后台：模板管理、授权统计、日志查看
 *
 * 业务场景：
 * - 线索提醒：用户提交咨询后，通知管理员跟进
 * - 订单状态：订单创建/支付/发货时通知用户
 * - 审核结果：入驻申请审核通过/拒绝通知用户
 * - 评价回复：管理员回复评价后通知用户
 * - 反馈回复：管理员回复反馈后通知用户
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const { getDB, nextId, save } = require('../models/db');

// ==================== 微信 Access Token（小程序） ====================

let _miniToken = null;
let _miniTokenExpire = 0;

async function getMiniAccessToken() {
  const now = Date.now();
  if (_miniToken && _miniTokenExpire > now + 60000) {
    return _miniToken;
  }

  const appid = process.env.WECHAT_APPID || process.env.WX_MINI_APPID || process.env.WX_APPID;
  const secret = process.env.WECHAT_SECRET || process.env.WX_MINI_SECRET || process.env.WX_SECRET;

  if (!appid || !secret) {
    return null;
  }

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            _miniToken = json.access_token;
            _miniTokenExpire = now + json.expires_in * 1000;
            resolve(_miniToken);
          } else {
            console.error('[subscribe-msg] 获取access_token失败:', json);
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', (e) => {
      console.error('[subscribe-msg] 获取access_token网络错误:', e.message);
      resolve(null);
    });
  });
}

// ==================== 发送订阅消息 ====================

async function sendSubscribeMessage(openid, templateId, data, page = '') {
  const token = await getMiniAccessToken();
  if (!token) {
    return { success: false, error: '无法获取access_token，请配置WECHAT_APPID和WECHAT_SECRET' };
  }

  const postData = JSON.stringify({
    touser: openid,
    template_id: templateId,
    page: page || 'pages/index/index',
    data: data,
    miniprogram_state: process.env.WX_MINI_STATE || 'formal', // formal/developer/trial
    lang: 'zh_CN'
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.weixin.qq.com',
      path: `/cgi-bin/message/subscribe/send?access_token=${token}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          resolve({ errcode: -1, errmsg: '解析响应失败' });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ errcode: -1, errmsg: e.message });
    });

    req.write(postData);
    req.end();
  });
}

// ==================== 内部方法：扣减授权次数 ====================

function consumeAuthorization(db, openid, code) {
  const db2 = require('../models/sqlite-db').getDB();
  // 查找该用户该类型的有效授权记录
  const auth = db2.prepare(
    `SELECT * FROM subscribe_authorizations 
     WHERE openid = ? AND code = ? AND status = 'active' AND remaining_count > 0
     ORDER BY authorized_at DESC LIMIT 1`
  ).get(openid, code);

  if (!auth) return false;

  // 扣减次数
  const newCount = auth.remaining_count - 1;
  const newStatus = newCount <= 0 ? 'consumed' : 'active';
  db2.prepare(
    `UPDATE subscribe_authorizations 
     SET remaining_count = ?, last_used_at = datetime('now'), status = ? 
     WHERE id = ?`
  ).run(newCount, newStatus, auth.id);

  return true;
}

// ==================== 用户接口 ====================

/**
 * POST /api/subscribe-msg/authorize
 * 用户通过 wx.requestSubscribeMessage 授权后，上报授权结果
 *
 * body: {
 *   openid:    用户openid,
 *   authorizations: [
 *     { template_id: 'xxx', code: 'lead_notify', accepted: true },
 *     ...
 *   ]
 * }
 */
router.post('/authorize', (req, res) => {
  const { openid, authorizations } = req.body;
  if (!openid || !Array.isArray(authorizations)) {
    return res.status(400).json({ error: '缺少openid或authorizations' });
  }

  const db = require('../models/sqlite-db').getDB();
  const results = [];

  for (const auth of authorizations) {
    if (!auth.accepted) {
      results.push({ template_id: auth.template_id, status: 'rejected' });
      continue;
    }

    // 检查是否有未用完的同类型授权
    const existing = db.prepare(
      `SELECT * FROM subscribe_authorizations 
       WHERE openid = ? AND code = ? AND status = 'active' AND remaining_count > 0
       ORDER BY authorized_at DESC LIMIT 1`
    ).get(openid, auth.code);

    if (existing) {
      // 累加次数
      db.prepare(
        `UPDATE subscribe_authorizations 
         SET remaining_count = remaining_count + 1, total_authorized = total_authorized + 1,
             authorized_at = datetime('now')
         WHERE id = ?`
      ).run(existing.id);
      results.push({ template_id: auth.template_id, status: 'accumulated', remaining: existing.remaining_count + 1 });
    } else {
      // 新增授权记录
      const info = db.prepare(
        `INSERT INTO subscribe_authorizations (openid, template_id, code, remaining_count, total_authorized, authorized_at, status)
         VALUES (?, ?, ?, 1, 1, datetime('now'), 'active')`
      ).run(openid, auth.template_id, auth.code);
      results.push({ template_id: auth.template_id, status: 'created', id: info.lastInsertRowid });
    }
  }

  res.json({ success: true, results });
});

/**
 * GET /api/subscribe-msg/templates
 * 获取所有启用的订阅消息模板
 */
router.get('/templates', (req, res) => {
  const db = require('../models/sqlite-db').getDB();
  const rows = db.prepare('SELECT * FROM subscribe_templates WHERE status = 1 ORDER BY id').all();
  // 解析 fields JSON
  rows.forEach(r => {
    try { r.fields = JSON.parse(r.fields || '[]'); } catch { r.fields = []; }
  });
  res.json(rows);
});

/**
 * GET /api/subscribe-msg/templates/all
 * 获取所有模板（含禁用），管理后台用
 */
router.get('/templates/all', (req, res) => {
  const db = require('../models/sqlite-db').getDB();
  const rows = db.prepare('SELECT * FROM subscribe_templates ORDER BY status DESC, id').all();
  rows.forEach(r => {
    try { r.fields = JSON.parse(r.fields || '[]'); } catch { r.fields = []; }
  });
  res.json(rows);
});

/**
 * GET /api/subscribe-msg/authorization-status
 * 查询用户某类型的授权状态
 * query: openid, code
 */
router.get('/authorization-status', (req, res) => {
  const { openid, code } = req.query;
  if (!openid || !code) {
    return res.status(400).json({ error: '缺少openid或code' });
  }
  const db = require('../models/sqlite-db').getDB();
  const auth = db.prepare(
    `SELECT * FROM subscribe_authorizations 
     WHERE openid = ? AND code = ? AND status = 'active' AND remaining_count > 0
     ORDER BY authorized_at DESC LIMIT 1`
  ).get(openid, code);

  res.json({
    has_authorization: !!auth,
    remaining_count: auth ? auth.remaining_count : 0,
    authorized_at: auth ? auth.authorized_at : null
  });
});

// ==================== 发送接口 ====================

/**
 * POST /api/subscribe-msg/send
 * 发送订阅消息（内部调用 + 管理后台手动发送）
 *
 * body: {
 *   openid:       接收用户openid,
 *   code:         模板代码（如 lead_notify, order_status 等）,
 *   data:         { key1: { value: 'xxx' }, key2: { value: 'yyy' } },
 *   page:         点击跳转页面（可选）,
 *   biz_type:     业务类型（如 order, onboarding, feedback）,
 *   biz_id:       业务ID
 * }
 *
 * 发送逻辑：
 * 1. 根据 code 查找模板
 * 2. 检查用户是否有该类型的有效授权
 * 3. 扣减授权次数
 * 4. 调用微信API发送
 * 5. 记录日志
 */
router.post('/send', async (req, res) => {
  const { openid, code, data, page, biz_type, biz_id } = req.body;
  if (!openid || !code) {
    return res.status(400).json({ error: '缺少openid或code' });
  }

  const db = require('../models/sqlite-db').getDB();

  // 1. 查找模板
  const template = db.prepare('SELECT * FROM subscribe_templates WHERE code = ? AND status = 1').get(code);
  if (!template) {
    return res.status(404).json({ error: `未找到code为${code}的启用模板` });
  }

  // 2. 检查授权
  const hasAuth = consumeAuthorization(db, openid, code);
  if (!hasAuth) {
    // 记录发送失败日志（无授权）
    db.prepare(
      `INSERT INTO subscribe_msg_logs (openid, template_id, code, title, data, page, status, error_msg, biz_type, biz_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'failed', '用户无有效授权', ?, ?, datetime('now'))`
    ).run(openid, template.template_id, code, template.title, JSON.stringify(data || {}), page || '', biz_type || '', String(biz_id || ''));

    return res.json({ success: false, error: '用户无有效授权，无法发送订阅消息', need_authorize: true });
  }

  // 3. 调用微信API发送
  const sendResult = await sendSubscribeMessage(openid, template.template_id, data || {}, page);

  // 4. 记录日志
  const status = (sendResult.errcode === 0) ? 'success' : 'failed';
  const errorMsg = sendResult.errcode === 0 ? '' : `${sendResult.errcode}: ${sendResult.errmsg}`;
  const sentAt = status === 'success' ? new Date().toISOString() : '';

  db.prepare(
    `INSERT INTO subscribe_msg_logs (openid, template_id, code, title, data, page, status, error_msg, biz_type, biz_id, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(openid, template.template_id, code, template.title, JSON.stringify(data || {}), page || '', status, errorMsg, biz_type || '', String(biz_id || ''), sentAt);

  if (status === 'success') {
    res.json({ success: true, msgid: sendResult.msgid });
  } else {
    res.json({ success: false, error: errorMsg, raw: sendResult });
  }
});

/**
 * POST /api/subscribe-msg/send-batch
 * 批量发送订阅消息（同一模板发给多个用户）
 *
 * body: {
 *   code:     模板代码,
 *   items: [
 *     { openid, data, page, biz_type, biz_id },
 *     ...
 *   ]
 * }
 */
router.post('/send-batch', async (req, res) => {
  const { code, items } = req.body;
  if (!code || !Array.isArray(items)) {
    return res.status(400).json({ error: '缺少code或items' });
  }

  const results = [];
  for (const item of items) {
    try {
      const resp = await fetch(`http://localhost:${process.env.PORT || 3004}/api/subscribe-msg/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...item, code })
      });
      const json = await resp.json();
      results.push({ openid: item.openid, success: json.success, error: json.error || '' });
    } catch (e) {
      results.push({ openid: item.openid, success: false, error: e.message });
    }
  }

  res.json({ success: true, total: items.length, results });
});

// ==================== 管理后台接口 ====================

/**
 * POST /api/subscribe-msg/admin/templates
 * 创建/更新订阅消息模板
 */
router.post('/admin/templates', (req, res) => {
  const { template_id, code, title, description, fields, status } = req.body;
  if (!template_id || !code || !title) {
    return res.status(400).json({ error: '缺少template_id/code/title' });
  }

  const db = require('../models/sqlite-db').getDB();
  const existing = db.prepare('SELECT id FROM subscribe_templates WHERE template_id = ?').get(template_id);

  if (existing) {
    db.prepare(
      `UPDATE subscribe_templates 
       SET code = ?, title = ?, description = ?, fields = ?, status = ?, updated_at = datetime('now')
       WHERE template_id = ?`
    ).run(code, title, description || '', JSON.stringify(fields || []), status !== undefined ? status : 1, template_id);
    res.json({ success: true, action: 'updated' });
  } else {
    db.prepare(
      `INSERT INTO subscribe_templates (template_id, code, title, description, fields, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).run(template_id, code, title, description || '', JSON.stringify(fields || []), status !== undefined ? status : 1);
    res.json({ success: true, action: 'created' });
  }
});

/**
 * PUT /api/subscribe-msg/admin/templates/:id
 * 更新模板状态
 */
router.put('/admin/templates/:id', (req, res) => {
  const { id } = req.params;
  const { status, title, description, fields } = req.body;
  const db = require('../models/sqlite-db').getDB();

  const updates = [];
  const params = [];
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (title !== undefined) { updates.push('title = ?'); params.push(title); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (fields !== undefined) { updates.push('fields = ?'); params.push(JSON.stringify(fields)); }
  updates.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE subscribe_templates SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

/**
 * GET /api/subscribe-msg/admin/stats
 * 订阅消息统计概览
 */
router.get('/admin/stats', (req, res) => {
  const db = require('../models/sqlite-db').getDB();

  const totalTemplates = db.prepare('SELECT COUNT(*) as c FROM subscribe_templates').get().c;
  const activeTemplates = db.prepare('SELECT COUNT(*) as c FROM subscribe_templates WHERE status = 1').get().c;

  const totalAuths = db.prepare('SELECT COUNT(*) as c FROM subscribe_authorizations').get().c;
  const activeAuths = db.prepare('SELECT COUNT(*) as c FROM subscribe_authorizations WHERE status = ?').get('active').c;
  const totalRemaining = db.prepare('SELECT COALESCE(SUM(remaining_count), 0) as s FROM subscribe_authorizations WHERE status = ?').get('active').s;

  const totalSent = db.prepare('SELECT COUNT(*) as c FROM subscribe_msg_logs').get().c;
  const successSent = db.prepare("SELECT COUNT(*) as c FROM subscribe_msg_logs WHERE status = 'success'").get().c;
  const failedSent = db.prepare("SELECT COUNT(*) as c FROM subscribe_msg_logs WHERE status = 'failed'").get().c;

  // 按模板统计
  const byTemplate = db.prepare(
    `SELECT code, 
       COUNT(*) as total,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM subscribe_msg_logs 
     GROUP BY code 
     ORDER BY total DESC`
  ).all();

  // 按用户统计授权 TOP10
  const topAuthUsers = db.prepare(
    `SELECT openid, 
       SUM(total_authorized) as total_auth,
       SUM(remaining_count) as remaining
     FROM subscribe_authorizations 
     GROUP BY openid 
     ORDER BY total_auth DESC 
     LIMIT 10`
  ).all();

  // 最近7天发送趋势
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentTrend = db.prepare(
    `SELECT DATE(created_at) as date, 
       COUNT(*) as total,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success
     FROM subscribe_msg_logs 
     WHERE created_at >= ?
     GROUP BY DATE(created_at)
     ORDER BY date`
  ).all(sevenDaysAgo);

  res.json({
    templates: { total: totalTemplates, active: activeTemplates },
    authorizations: { total: totalAuths, active: activeAuths, remaining: totalRemaining },
    messages: { total: totalSent, success: successSent, failed: failedSent, successRate: totalSent > 0 ? Math.round(successSent / totalSent * 100) : 0 },
    byTemplate,
    topAuthUsers,
    recentTrend
  });
});

/**
 * GET /api/subscribe-msg/admin/logs
 * 发送日志列表（分页+筛选）
 * query: page, limit, openid, code, status
 */
router.get('/admin/logs', (req, res) => {
  const { page = 1, limit = 20, openid, code, status } = req.query;
  const offset = (page - 1) * limit;

  let where = '1=1';
  const params = [];
  if (openid) { where += ' AND openid = ?'; params.push(openid); }
  if (code) { where += ' AND code = ?'; params.push(code); }
  if (status) { where += ' AND status = ?'; params.push(status); }

  const db = require('../models/sqlite-db').getDB();
  const total = db.prepare(`SELECT COUNT(*) as c FROM subscribe_msg_logs WHERE ${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT * FROM subscribe_msg_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit), offset);

  // 解析 data JSON
  rows.forEach(r => {
    try { r.data = JSON.parse(r.data || '{}'); } catch { r.data = {}; }
  });

  res.json({
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    pages: Math.ceil(total / limit),
    data: rows
  });
});

/**
 * GET /api/subscribe-msg/admin/authorizations
 * 授权记录列表（分页+筛选）
 * query: page, limit, openid, code, status
 */
router.get('/admin/authorizations', (req, res) => {
  const { page = 1, limit = 20, openid, code, status } = req.query;
  const offset = (page - 1) * limit;

  let where = '1=1';
  const params = [];
  if (openid) { where += ' AND openid = ?'; params.push(openid); }
  if (code) { where += ' AND code = ?'; params.push(code); }
  if (status) { where += ' AND status = ?'; params.push(status); }

  const db = require('../models/sqlite-db').getDB();
  const total = db.prepare(`SELECT COUNT(*) as c FROM subscribe_authorizations WHERE ${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT * FROM subscribe_authorizations WHERE ${where} ORDER BY authorized_at DESC LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit), offset);

  res.json({
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    pages: Math.ceil(total / limit),
    data: rows
  });
});

// ==================== 预设模板初始化 ====================

/**
 * POST /api/subscribe-msg/admin/init-templates
 * 初始化预设模板配置（需在微信公众平台配置对应模板后填入真实template_id）
 */
router.post('/admin/init-templates', (req, res) => {
  const presets = [
    {
      code: 'lead_notify',
      title: '线索提醒通知',
      description: '用户提交咨询/需求表单后，通知管理员及时跟进',
      fields: [
        { key: 'thing1', label: '客户姓名', type: 'thing' },
        { key: 'phone_number1', label: '联系电话', type: 'phone_number' },
        { key: 'thing2', label: '需求摘要', type: 'thing' },
        { key: 'time1', label: '提交时间', type: 'time' }
      ]
    },
    {
      code: 'order_status',
      title: '订单状态变更通知',
      description: '订单创建/支付成功/发货/完成时通知用户',
      fields: [
        { key: 'character_string1', label: '订单编号', type: 'character_string' },
        { key: 'phrase1', label: '订单状态', type: 'phrase' },
        { key: 'amount2', label: '订单金额', type: 'amount' },
        { key: 'time2', label: '更新时间', type: 'time' }
      ]
    },
    {
      code: 'audit_result',
      title: '审核结果通知',
      description: '入驻申请/产品上架审核结果通知用户',
      fields: [
        { key: 'thing1', label: '申请项目', type: 'thing' },
        { key: 'phrase1', label: '审核结果', type: 'phrase' },
        { key: 'time1', label: '审核时间', type: 'time' },
        { key: 'thing2', label: '备注说明', type: 'thing' }
      ]
    },
    {
      code: 'feedback_reply',
      title: '反馈回复通知',
      description: '用户反馈被管理员回复后通知用户',
      fields: [
        { key: 'thing1', label: '反馈内容', type: 'thing' },
        { key: 'thing2', label: '回复内容', type: 'thing' },
        { key: 'time1', label: '回复时间', type: 'time' }
      ]
    },
    {
      code: 'review_reply',
      title: '评价回复通知',
      description: '用户评价被管理员回复后通知用户',
      fields: [
        { key: 'thing1', label: '评价内容', type: 'thing' },
        { key: 'thing2', label: '商家回复', type: 'thing' },
        { key: 'time1', label: '回复时间', type: 'time' }
      ]
    },
    {
      code: 'points_change',
      title: '积分变动通知',
      description: '用户积分增加/兑换时通知用户',
      fields: [
        { key: 'character_string1', label: '变动数量', type: 'character_string' },
        { key: 'phrase1', label: '变动类型', type: 'phrase' },
        { key: 'amount1', label: '当前积分', type: 'amount' },
        { key: 'time1', label: '变动时间', type: 'time' }
      ]
    }
  ];

  const db = require('../models/sqlite-db').getDB();
  let created = 0, updated = 0;

  for (const preset of presets) {
    const existing = db.prepare('SELECT id FROM subscribe_templates WHERE code = ?').get(preset.code);
    if (existing) {
      db.prepare(
        `UPDATE subscribe_templates SET title = ?, description = ?, fields = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(preset.title, preset.description, JSON.stringify(preset.fields), existing.id);
      updated++;
    } else {
      // 预设的 template_id 用占位符，管理员需替换为真实ID
      db.prepare(
        `INSERT INTO subscribe_templates (template_id, code, title, description, fields, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
      ).run(`PENDING_${preset.code}`, preset.code, preset.title, preset.description, JSON.stringify(preset.fields));
      created++;
    }
  }

  res.json({ success: true, created, updated, total: presets.length });
});

module.exports = router;

// ==================== 导出内部方法供其他路由调用 ====================

/**
 * 便捷方法：发送订阅消息（供其他路由模块调用）
 * @param {string} openid - 用户openid
 * @param {string} code - 模板代码
 * @param {object} data - 消息数据 { key: { value: 'xxx' } }
 * @param {string} page - 跳转页面
 * @param {string} bizType - 业务类型
 * @param {string|number} bizId - 业务ID
 */
async function notifyUser(openid, code, data, page = '', bizType = '', bizId = '') {
  const db = require('../models/sqlite-db').getDB();

  // 查找模板
  const template = db.prepare('SELECT * FROM subscribe_templates WHERE code = ? AND status = 1').get(code);
  if (!template) {
    return { success: false, error: `模板${code}不存在或未启用` };
  }

  // 检查授权
  const hasAuth = consumeAuthorization(db, openid, code);
  if (!hasAuth) {
    db.prepare(
      `INSERT INTO subscribe_msg_logs (openid, template_id, code, title, data, page, status, error_msg, biz_type, biz_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'failed', '用户无有效授权', ?, ?, datetime('now'))`
    ).run(openid, template.template_id, code, template.title, JSON.stringify(data || {}), page, bizType, String(bizId));
    return { success: false, error: '用户无有效授权' };
  }

  // 发送
  const sendResult = await sendSubscribeMessage(openid, template.template_id, data, page);

  const status = (sendResult.errcode === 0) ? 'success' : 'failed';
  const errorMsg = sendResult.errcode === 0 ? '' : `${sendResult.errcode}: ${sendResult.errmsg}`;
  const sentAt = status === 'success' ? new Date().toISOString() : '';

  db.prepare(
    `INSERT INTO subscribe_msg_logs (openid, template_id, code, title, data, page, status, error_msg, biz_type, biz_id, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(openid, template.template_id, code, template.title, JSON.stringify(data || {}), page, status, errorMsg, bizType, String(bizId), sentAt);

  return { success: status === 'success', error: errorMsg, raw: sendResult };
}

module.exports.notifyUser = notifyUser;
