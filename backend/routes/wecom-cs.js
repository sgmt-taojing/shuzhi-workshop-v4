const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const https = require('https');
const router = express.Router();

// ─────────────────────────────────────────
//  鉴权中间件（与管理后台共用）
// ─────────────────────────────────────────
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

// 配置文件路径（独立于 .env，支持后台动态修改）
const CONFIG_FILE = path.join(__dirname, '../data/wecom-config.json');

// ─────────────────────────────────────────
//  读取配置文件
// ─────────────────────────────────────────
function loadConfigFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('[WeCom配置] 读取配置文件失败:', e.message);
  }
  return {};
}

// ─────────────────────────────────────────
//  写入配置文件
// ─────────────────────────────────────────
function saveConfigFile(config) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// ─────────────────────────────────────────
//  合并配置：env 变量（优先级高）+ 配置文件
// ─────────────────────────────────────────
function getMergedConfig() {
  const fileConfig = loadConfigFile();
  return {
    corpId:          process.env.WECOM_CORP_ID  || fileConfig.corpId || '',
    csUrl:           process.env.WECOM_CUSTOMSERVICE_URL || fileConfig.csUrl || '',
    secret:          process.env.WECOM_CUSTOMSERVICE_SECRET || fileConfig.secret || '',
    agentId:         process.env.WECOM_AGENT_ID || fileConfig.agentId || '',
    token:           process.env.WECOM_CUSTOMSERVICE_TOKEN || fileConfig.token || '',
    encodingAESKey:  process.env.WECOM_CUSTOMSERVICE_AES_KEY || fileConfig.encodingAESKey || '',
    avatar:          process.env.WECOM_CUSTOMSERVICE_AVATAR || fileConfig.avatar || '',
    name:            process.env.WECOM_CUSTOMSERVICE_NAME || fileConfig.name || '在线客服',
    enabled:         !!(process.env.WECOM_CORP_ID || fileConfig.corpId)
  };
}

// ─────────────────────────────────────────
//  GET /api/wecom-cs/config-admin
//  管理后台：获取当前配置（脱敏）
// ─────────────────────────────────────────
router.get('/config-admin', authCheck, (req, res) => {
  const config = getMergedConfig();
  // 脱敏：secret 和 encodingAESKey 只返回是否已配置
  res.json({
    corpId:         config.corpId,
    csUrl:          config.csUrl,
    secretConfigured:   !!config.secret,
    agentId:        config.agentId,
    tokenConfigured:     !!config.token,
    aesKeyConfigured:    !!config.encodingAESKey,
    avatar:         config.avatar,
    name:           config.name,
    enabled:        config.enabled,
    source:         process.env.WECOM_CORP_ID ? 'env' : (loadConfigFile().corpId ? 'file' : 'none')
  });
});

// ─────────────────────────────────────────
//  POST /api/wecom-cs/config-admin
//  管理后台：保存配置到文件（不覆盖 env）
// ─────────────────────────────────────────
router.post('/config-admin', authCheck, (req, res) => {
  const { corpId, csUrl, secret, agentId, token, encodingAESKey, avatar, name } = req.body;

  const fileConfig = loadConfigFile();

  if (corpId !== undefined) fileConfig.corpId = corpId.trim();
  if (csUrl !== undefined)  fileConfig.csUrl = csUrl.trim();
  if (secret !== undefined)  fileConfig.secret = secret.trim();
  if (agentId !== undefined) fileConfig.agentId = agentId.trim();
  if (token !== undefined)   fileConfig.token = token.trim();
  if (encodingAESKey !== undefined) fileConfig.encodingAESKey = encodingAESKey.trim();
  if (avatar !== undefined)  fileConfig.avatar = avatar.trim();
  if (name !== undefined)    fileConfig.name = name.trim();

  try {
    saveConfigFile(fileConfig);
    console.log('[WeCom配置] 配置已保存:', CONFIG_FILE);
    res.json({ success: true, message: '配置保存成功，重启后端后生效' });
  } catch (err) {
    console.error('[WeCom配置] 保存失败:', err.message);
    res.status(500).json({ error: '保存失败: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  GET /api/wecom-cs/config
//  小程序端：获取客服配置（供小程序使用）
// ─────────────────────────────────────────
router.get('/config', (req, res) => {
  const config = getMergedConfig();
  const configured = !!(config.corpId && (config.csUrl || config.secret));

  res.json({
    enabled: configured,
    mode: configured ? (config.csUrl ? 'miniprogram_component' : 'webhook') : 'mock',
    corpId:     configured ? config.corpId : 'wwDemoCorpId',
    csUrl:      configured ? config.csUrl : '',
    agentId:    configured ? config.agentId : '',
    avatar:     configured ? config.avatar : '',
    name:       configured ? config.name : '在线客服',
    message:    configured
      ? '企业微信客服已接入'
      : '企业微信客服未配置。请前往管理后台 → 系统设置 → 企业微信客服 进行配置。'
  });
});

// ─────────────────────────────────────────
//  GET /api/wecom-cs/chat-config
//  小程序拉起客服会话所需参数
// ─────────────────────────────────────────
router.get('/chat-config', (req, res) => {
  const config = getMergedConfig();
  const configured = !!(config.corpId && (config.csUrl || config.secret));

  if (!configured) {
    return res.json({
      enabled: false,
      mode: 'local',
      note: '企业微信未配置，使用本地客服'
    });
  }

  res.json({
    enabled: true,
    mode: config.csUrl ? 'miniprogram_component' : 'webhook',
    corpId:  config.corpId,
    url:     config.csUrl,
    agentId: config.agentId,
    note: config.csUrl
      ? '使用微信小程序客服组件（wx.openCustomerServiceChat）'
      : '使用企业微信Webhook接收消息'
  });
});

// ─────────────────────────────────────────
//  微信客服消息签名验证（企业微信 → 后端 webhook）
//  验证流程：
//    1. 企业微信发来 GET 请求做 URL 验证（首次配置）
//    2. 企业微信发来 POST 请求推送消息（AES 加密）
// ─────────────────────────────────────────

/**
 * 验证 URL（企业微信配置接收消息服务器时的 GET 请求）
 */
function verifyURL(req) {
  const config = getMergedConfig();
  const token = config.token;
  const encodingAESKey = config.encodingAESKey;

  const { msg_signature, timestamp, nonce, echostr } = req.query;

  if (!msg_signature || !timestamp || !nonce || !echostr) {
    return null;
  }

  // 验证签名
  const sorted = [token, timestamp, nonce, echostr].sort().join('');
  const hash = crypto.createHash('sha1').update(sorted).digest('hex');

  if (hash !== msg_signature) {
    console.warn('[WeCom Webhook] URL验证签名不匹配');
    return null;
  }

  // 解密 echostr（AES + Base64）
  try {
    const aesKey = Buffer.from(encodingAESKey + '=', 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.slice(0, 16));
    decipher.setAutoPadding(false);
    const encrypted = Buffer.from(echostr, 'base64');
    let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    // 去除 PKCS7 padding
    const padLen = decrypted[decrypted.length - 1];
    decrypted = decrypted.slice(0, decrypted.length - padLen);
    // 格式：16字节随机 + 4字节消息长度 + 消息内容 + corpId
    const msgLen = decrypted.readUInt32BE(16);
    const msg = decrypted.slice(20, 20 + msgLen).toString('utf-8');
    return msg; // 返回解密后的 echostr
  } catch (e) {
    console.error('[WeCom Webhook] 解密 echostr 失败:', e.message);
    return null;
  }
}

/**
 * 验证消息签名（POST 消息推送）
 */
function verifyMessageSignature(req) {
  const config = getMergedConfig();
  const token = config.token;

  const signature = req.headers['x-wx-signature'] || req.query.msg_signature;
  const timestamp = req.headers['x-wx-timestamp'] || req.query.timestamp;
  const nonce = req.headers['x-wx-nonce'] || req.query.nonce;

  if (!signature || !timestamp || !nonce) return false;

  const sorted = [token, timestamp, nonce].sort().join('');
  const hash = crypto.createHash('sha1').update(sorted).digest('hex');

  return hash === signature;
}

// ─────────────────────────────────────────
//  GET /api/wecom-cs/webhook
//  企业微信 URL 验证（首次配置接收消息服务器）
// ─────────────────────────────────────────
router.get('/webhook', (req, res) => {
  const echostr = verifyURL(req);
  if (echostr) {
    console.log('[WeCom Webhook] ✅ URL验证成功');
    res.send(echostr);
  } else {
    console.warn('[WeCom Webhook] ❌ URL验证失败');
    res.status(403).send('signature verification failed');
  }
});

// ─────────────────────────────────────────
//  POST /api/wecom-cs/webhook
//  企业微信推送客服消息
// ─────────────────────────────────────────
router.post('/webhook',
  express.raw({ type: 'application/xml', limit: '1mb' }),
  async (req, res) => {
    const config = getMergedConfig();

    // 如未配置 token/aesKey，直接返回 success（开发阶段）
    if (!config.token || !config.encodingAESKey) {
      console.log('[WeCom Webhook] 未配置签名密钥，跳过验证，直接返回 success');
      return res.send('success');
    }

    // 验证签名
    const valid = verifyMessageSignature(req);
    if (!valid) {
      console.warn('[WeCom Webhook] 消息签名验证失败');
      return res.status(403).send('invalid signature');
    }

    // 解密消息体（AES-256-CBC）
    try {
      const aesKey = Buffer.from(config.encodingAESKey + '=', 'base64');
      const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.slice(0, 16));
      decipher.setAutoPadding(false);
      const encrypted = Buffer.from(req.body.toString(), 'base64');
      let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      const padLen = decrypted[decrypted.length - 1];
      decrypted = decrypted.slice(0, decrypted.length - padLen);
      const msgLen = decrypted.readUInt32BE(16);
      const xmlMsg = decrypted.slice(20, 20 + msgLen).toString('utf-8');

      console.log('[WeCom Webhook] 收到消息:', xmlMsg.slice(0, 200));

      // TODO: 解析 XML，保存消息到数据库，触发自动回复

    } catch (e) {
      console.error('[WeCom Webhook] 解密消息失败:', e.message);
    }

    res.send('success');
  }
);

// ─────────────────────────────────────────
//  POST /api/wecom-cs/send-message
//  后端主动向用户发送消息
// ─────────────────────────────────────────
router.post('/send-message', async (req, res) => {
  const { openid, msg_type = 'text', content } = req.body;
  if (!openid || !content) {
    return res.status(400).json({ error: '缺少 openid 或 content' });
  }

  const config = getMergedConfig();
  if (!config.corpId || !config.secret) {
    // 未配置 → fallback 写入本地消息库
    const { getDB, nextId, save, syncRow } = require('../models/db');
    const db = getDB();
    if (!db.cs_conversations) db.cs_conversations = [];
    if (!db.cs_messages) db.cs_messages = [];

    let conv = db.cs_conversations.find(c => c.openid === openid);
    const now = new Date().toISOString();
    if (!conv) {
      conv = {
        id: nextId('cs_conversations'),
        openid,
        nickname: '访客',
        avatar: '',
        last_message: typeof content === 'string' ? content : '',
        last_time: now,
        unread_count: 0,
        status: 'open',
        source: 'wecom_fallback',
        created_at: now
      };
      db.cs_conversations.push(conv);
    }
    const msg = {
      id: nextId('cs_messages'),
      conversation_id: conv.id,
      openid,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      type: msg_type,
      direction: 'out',
      is_read: 1,
      created_at: now
    };
    db.cs_messages.push(msg);
    conv.last_message = msg.content;
    conv.last_time = now;
    syncRow('cs_conversations', conv);
    // save() not needed - push + syncRow auto-writes

    return res.json({ success: true, mode: 'local', message_id: msg.id });
  }

  // 真实发送（调用企业微信 API）
  try {
    const https = require('https');
    const token = await getWeComToken(config);

    let msgBody = { touser: openid };
    if (msg_type === 'text') {
      msgBody.msgtype = 'text';
      msgBody.text = { content };
    } else if (msg_type === 'news') {
      msgBody.msgtype = 'news';
      msgBody.news = { articles: Array.isArray(content) ? content : [content] };
    }

    const jsonStr = JSON.stringify(msgBody);
    const result = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'qyapi.weixin.qq.com',
        path: `/cgi-bin/kf/send_msg?access_token=${token}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(jsonStr) }
      }, (res2) => {
        let data = '';
        res2.on('data', chunk => data += chunk);
        res2.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req2.on('error', reject);
      req2.write(jsonStr);
      req2.end();
    });

    if (result.errcode === 0) {
      console.log('[WeCom客服] ✅ 消息发送成功 to', openid);
      return res.json({ success: true, mode: 'wecom', msgid: result.msgid });
    } else {
      console.error('[WeCom客服] ❌ 发送失败:', result.errmsg);
      return res.status(500).json({ error: result.errmsg, errcode: result.errcode });
    }
  } catch (err) {
    console.error('[WeCom客服] ❌ 异常:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
//  工具：获取企业微信 Access Token（带缓存）
// ─────────────────────────────────────────
let _wecomTokenCache = null;
let _wecomTokenExpire = 0;

async function getWeComToken(config) {
  config = config || getMergedConfig();
  const now = Date.now();
  if (_wecomTokenCache && _wecomTokenExpire > now + 60000) {
    return _wecomTokenCache;
  }

  const https = require('https');
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${config.corpId}&corpsecret=${config.secret}`;

  const data = await new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

  if (data.access_token) {
    _wecomTokenCache = data.access_token;
    _wecomTokenExpire = now + data.expires_in * 1000;
    return data.access_token;
  } else {
    throw new Error(`获取WeCom token失败: ${JSON.stringify(data)}`);
  }
}

// ─────────────────────────────────────────
//  GET /api/wecom-cs/stats
//  客服统计
// ─────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const config = getMergedConfig();
  const { getDB } = require('../models/db');
  const db = getDB();
  const conversations = db.cs_conversations || [];
  const messages = db.cs_messages || [];

  const openConvs = conversations.filter(c => c.status === 'open').length;
  const todayConvs = conversations.filter(c => {
    const d = new Date(c.last_time || c.created_at);
    const today = new Date();
    return d.toDateString() === today.toDateString();
  }).length;

  res.json({
    configured: !!(config.corpId && (config.csUrl || config.secret)),
    corpId: config.corpId,
    local: {
      totalConversations: conversations.length,
      openConversations: openConvs,
      todayConversations: todayConvs,
      totalMessages: messages.length
    }
  });
});

module.exports = router;
