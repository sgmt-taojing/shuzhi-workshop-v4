/**
 * 公众号模板消息路由
 * 功能：用户提交联系表单后，向管理员推送模板消息通知
 *
 * 使用场景：
 * - 用户通过小程序提交需求表单（contact.js）
 * - 管理员收到公众号模板消息，实时获知新线索
 *
 * 配置项（WECHAT_ 开头的环境变量）：
 * - WECHAT_APPID:          公众号 AppID
 * - WECHAT_SECRET:         公众号 AppSecret
 * - WECHAT_TEMPLATE_ID:    模板消息 ID（从公众号后台获取）
 * - WECHAT_ADMIN_OPENID:   接收通知的管理员 OpenID
 * - WECHAT_TEMPLATE_URL:   点击模板消息后跳转的 URL（可选）
 *
 * 模板字段（行业咨询类通知）：
 * {{first.DATA}}      标题，如"您有一条新的咨询需求"
 * {{keyword1.DATA}}    客户姓名
 * {{keyword2.DATA}}    联系电话
 * {{keyword3.DATA}}    所在行业
 * {{keyword4.DATA}}    需求描述
 * {{remark.DATA}}      备注，如"请尽快联系客户"
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const https = require('https');

// ─────────────────────────────────────────
//  工具函数：获取公众号 Access Token
// ─────────────────────────────────────────
let _cachedToken = null;
let _tokenExpireAt = 0; // ms

async function getAccessToken() {
  const now = Date.now();
  if (_cachedToken && _tokenExpireAt > now + 60000) {
    return _cachedToken;
  }

  const appid = process.env.WECHAT_APPID;
  const secret = process.env.WECHAT_SECRET;

  if (!appid || !secret) {
    return null;
  }

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            _cachedToken = json.access_token;
            _tokenExpireAt = now + json.expires_in * 1000;
            resolve(json.access_token);
          } else {
            reject(new Error(`获取 access_token 失败: ${JSON.stringify(json)}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────
//  工具函数：发送模板消息
// ─────────────────────────────────────────
async function sendTemplateMessage({ toOpenid, templateId, data: msgData, url }) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('微信公众号未配置（缺少 WECHAT_APPID / WECHAT_SECRET）');
  }

  const payload = {
    touser: toOpenid,
    template_id: templateId,
    url: url || '',
    data: msgData
  };

  const body = JSON.stringify(payload);
  const postData = `POST /cgi-bin/message/template/send?access_token=${token} HTTP/1.1\r\nHost: api.weixin.qq.com\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.weixin.qq.com',
      path: `/cgi-bin/message/template/send?access_token=${token}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────
//  GET /api/template-msg/config
//  获取当前配置状态（掩码敏感信息）
// ─────────────────────────────────────────
router.get('/config', (req, res) => {
  const templateId = process.env.WECHAT_TEMPLATE_ID || '';
  const adminOpenid = process.env.WECHAT_ADMIN_OPENID || '';
  const appid = process.env.WECHAT_APPID || '';

  res.json({
    enabled: !!(templateId && adminOpenid),
    templateId: templateId ? `${templateId.slice(0, 6)}...${templateId.slice(-4)}` : '',
    hasAdminOpenid: !!adminOpenid,
    hasAppid: !!appid,
    message: !!(templateId && adminOpenid)
      ? '模板消息已启用'
      : '模板消息未配置（请在 .env 中设置 WECHAT_TEMPLATE_ID 和 WECHAT_ADMIN_OPENID）'
  });
});

// ─────────────────────────────────────────
//  POST /api/template-msg/send-lead
//  发送线索通知模板消息
//  body: { name, phone, company, industry, demand }
// ─────────────────────────────────────────
router.post('/send-lead', async (req, res) => {
  const { name, phone, company, industry, demand } = req.body;

  // 1. 参数校验
  if (!name || !phone || !demand) {
    return res.status(400).json({ error: '缺少必填字段：name, phone, demand' });
  }

  const { getDB, nextId, save, syncRow } = require('../models/db');
  const db = getDB();

  // 2. 初始化 template_msg_logs（如果不存在）
  if (!db.template_msg_logs) {
    db.template_msg_logs = [];
  }

  // 3. 读取配置
  const templateId = process.env.WECHAT_TEMPLATE_ID;
  const adminOpenid = process.env.WECHAT_ADMIN_OPENID;

  // 4. 模拟模式：未配置时记录日志并返回
  if (!templateId || !adminOpenid) {
    const logEntry = {
      id: nextId('template_msg_logs'),
      type: 'lead',
      status: 'mock',
      request: { name, phone, company, industry, demand },
      response: { errcode: 0, errmsg: 'mock mode（未配置 WECHAT_TEMPLATE_ID 或 WECHAT_ADMIN_OPENID）' },
      created_at: new Date().toISOString()
    };
    db.template_msg_logs.unshift(logEntry);
    // save() not needed - unshift auto-writes

    console.log('[模板消息-MOCK]', {
      to: adminOpenid || '(未配置)',
      template: templateId || '(未配置)',
      name, phone, industry
    });

    return res.json({
      success: true,
      mode: 'mock',
      message: '模板消息已记录（MOCK模式，未真实发送）',
      logId: logEntry.id
    });
  }

  // 5. 真实模式：发送模板消息
  try {
    const msgData = {
      first: {
        value: `🔥 您有一条新的咨询需求`,
        color: '#E53E30'
      },
      keyword1: {
        value: name,
        color: '#333333'
      },
      keyword2: {
        value: phone,
        color: '#333333'
      },
      keyword3: {
        value: industry || '未填写',
        color: '#333333'
      },
      keyword4: {
        value: demand.length > 50 ? demand.slice(0, 50) + '…' : demand,
        color: '#333333'
      },
      remark: {
        value: company ? `来自企业：${company}，请尽快联系客户` : '请尽快联系客户',
        color: '#888888'
      }
    };

    const templateUrl = process.env.WECHAT_TEMPLATE_LEAD_URL || '';
    const result = await sendTemplateMessage({
      toOpenid: adminOpenid,
      templateId,
      data: msgData,
      url: templateUrl
    });

    // 6. 记录日志
    const logEntry = {
      id: nextId('template_msg_logs'),
      type: 'lead',
      status: result.errcode === 0 ? 'success' : 'failed',
      request: { name, phone, company, industry, demand },
      response: result,
      created_at: new Date().toISOString()
    };
    db.template_msg_logs.unshift(logEntry);
    // save() not needed - unshift auto-writes

    console.log('[模板消息]', result.errcode === 0 ? '✅ 发送成功' : '❌ 发送失败', result);

    if (result.errcode === 0) {
      return res.json({
        success: true,
        mode: 'real',
        message: '模板消息发送成功',
        logId: logEntry.id
      });
    } else {
      return res.status(500).json({
        success: false,
        error: `微信API错误: ${result.errmsg}`,
        errcode: result.errcode,
        logId: logEntry.id
      });
    }
  } catch (err) {
    // 发送失败也记录日志
    const logEntry = {
      id: nextId('template_msg_logs'),
      type: 'lead',
      status: 'error',
      request: { name, phone, company, industry, demand },
      error: err.message,
      created_at: new Date().toISOString()
    };
    db.template_msg_logs.unshift(logEntry);
    // save() not needed - unshift auto-writes

    console.error('[模板消息] ❌ 异常:', err.message);
    return res.status(500).json({
      success: false,
      error: `发送失败: ${err.message}`,
      logId: logEntry.id
    });
  }
});

// ─────────────────────────────────────────
//  GET /api/template-msg/logs
//  查看模板消息发送历史（分页）
// ─────────────────────────────────────────
router.get('/logs', (req, res) => {
  const { getDB } = require('../models/db');
  const db = getDB();
  const logs = db.template_msg_logs || [];
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  const paged = logs.slice(offset, offset + limit);

  res.json({
    total: logs.length,
    page,
    limit,
    data: paged
  });
});

// ─────────────────────────────────────────
//  GET /api/template-msg/stats
//  发送统计
// ─────────────────────────────────────────
router.get('/stats', (req, res) => {
  const { getDB } = require('../models/db');
  const db = getDB();
  const logs = db.template_msg_logs || [];

  const success = logs.filter(l => l.status === 'success').length;
  const failed = logs.filter(l => l.status === 'failed' || l.status === 'error').length;
  const mock = logs.filter(l => l.status === 'mock').length;

  res.json({
    total: logs.length,
    success,
    failed,
    mock,
    enabled: !!(process.env.WECHAT_TEMPLATE_ID && process.env.WECHAT_ADMIN_OPENID)
  });
});


/**
 * POST /api/template-msg/send-cs
 * 发送客服消息通知模板消息
 * body: { openid, nickname, content }
 */
router.post('/send-cs', async (req, res) => {
  const { openid, nickname, content } = req.body;

  if (!openid || !content) {
    return res.status(400).json({ error: '缺少必填字段：openid, content' });
  }

  const { getDB, nextId, save } = require('../models/db');
  const db = getDB();

  if (!db.template_msg_logs) {
    db.template_msg_logs = [];
    save();
  }

  const templateId = process.env.WECHAT_TEMPLATE_ID;
  const adminOpenid = process.env.WECHAT_ADMIN_OPENID;

  // 模拟模式
  if (!templateId || !adminOpenid) {
    const logEntry = {
      id: nextId('template_msg_logs'),
      type: 'cs_message',
      status: 'mock',
      request: { openid, nickname, content },
      response: { errcode: 0, errmsg: 'mock mode' },
      created_at: new Date().toISOString()
    };
    db.template_msg_logs.unshift(logEntry);
    save();

    console.log('[模板消息-MOCK] 客服消息', { openid, nickname, content: content.slice(0, 30) });

    return res.json({
      success: true,
      mode: 'mock',
      message: '模板消息已记录（MOCK模式）',
      logId: logEntry.id
    });
  }

  // 真实模式
  try {
    const displayName = nickname || openid;
    const shortContent = content.length > 80 ? content.slice(0, 80) + '…' : content;

    const msgData = {
      first: {
        value: `💬 您收到一条新的客服消息`,
        color: '#2563eb'
      },
      keyword1: {
        value: displayName,
        color: '#333333'
      },
      keyword2: {
        value: shortContent,
        color: '#333333'
      },
      keyword3: {
        value: new Date().toLocaleString('zh-CN'),
        color: '#666666'
      },
      remark: {
        value: '请尽快回复客户消息',
        color: '#e67e22'
      }
    };

    const result = await sendTemplateMessage({
      toOpenid: adminOpenid,
      templateId,
      data: msgData,
      url: process.env.WECHAT_TEMPLATE_LEAD_URL || ''
    });

    const logEntry = {
      id: nextId('template_msg_logs'),
      type: 'cs_message',
      status: result.errcode === 0 ? 'success' : 'failed',
      request: { openid, nickname, content },
      response: result,
      created_at: new Date().toISOString()
    };
    db.template_msg_logs.unshift(logEntry);
    save();

    console.log('[模板消息-CS]', result.errcode === 0 ? '✅ 发送成功' : '❌ 发送失败', { openid, result });

    if (result.errcode === 0) {
      return res.json({
        success: true,
        mode: 'real',
        message: '模板消息发送成功',
        logId: logEntry.id
      });
    } else {
      return res.status(500).json({
        success: false,
        error: `微信API错误: ${result.errmsg}`,
        errcode: result.errcode,
        logId: logEntry.id
      });
    }
  } catch (err) {
    const logEntry = {
      id: nextId('template_msg_logs'),
      type: 'cs_message',
      status: 'error',
      request: { openid, nickname, content },
      error: err.message,
      created_at: new Date().toISOString()
    };
    db.template_msg_logs.unshift(logEntry);
    save();

    console.error('[模板消息-CS] ❌ 异常:', err.message);
    return res.status(500).json({
      success: false,
      error: `发送失败: ${err.message}`,
      logId: logEntry.id
    });
  }
});

/**
 * POST /api/template-msg/test
 * 手动测试模板消息（管理后台用）
 * body: { type: 'lead' | 'cs', ... }
 */
router.post('/test', async (req, res) => {
  const { type } = req.body;
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== 'admin123' && !token) {
    return res.status(401).json({ error: '未授权' });
  }

  if (type === 'cs') {
    req.body = {
      openid: 'test_openid_123',
      nickname: '测试用户',
      content: '这是一条测试客服消息，用于验证模板消息是否正常触发。'
    };
    return router.handle({ ...req, url: '/send-cs', path: '/send-cs' }, res);
  } else {
    req.body = {
      name: '测试客户',
      phone: '13800138000',
      company: '测试科技有限公司',
      industry: '软件/互联网',
      demand: '想了解ERP系统的具体功能和报价，以及是否支持定制开发。'
    };
    return router.handle({ ...req, url: '/send-lead', path: '/send-lead' }, res);
  }
});

module.exports = router;
module.exports.sendTemplateMessage = sendTemplateMessage;
module.exports.getAccessToken = getAccessToken;
