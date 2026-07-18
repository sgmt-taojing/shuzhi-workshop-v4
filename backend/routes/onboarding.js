const { getDB, nextId, save, syncRow } = require('../models/db');
const { createNotification } = require('./notifications');
const pointsRoute = require('./points');
const router = require('express').Router();

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

// 公开：提交入驻申请
router.post('/', (req, res) => {
  const { company_name, industry, company_desc, contact_name, contact_phone, contact_email, product_type, product_title, description } = req.body;
  if (!company_name || !contact_name || !contact_phone || !product_title) {
    return res.status(400).json({ error: '请填写必填项' });
  }
  const db = getDB();
  const item = {
    id: nextId('onboardings'),
    company_name,
    industry: industry || '',
    company_desc: company_desc || '',
    contact_name,
    contact_phone,
    contact_email: contact_email || '',
    product_type: product_type || '实体产品',
    product_title,
    description: description || '',
    status: 'pending',
    reject_reason: '',
    converted: false,
    client_id: null,
    client_product_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.onboardings.unshift(item);
  // save() not needed - unshift auto-writes

  // 积分奖励
  const openid = req.body.openid || '';
  if (openid) {
    pointsRoute.addPoints(openid, 'complete_onboarding', String(item.id), '完成诊断: ' + company_name);
  }

  res.json({ id: item.id, message: '入驻申请已提交，1-3个工作日内完成审核' });
});

// 管理端：入驻申请统计（必须放在 /:id 之前）
router.get('/stats', authCheck, (req, res) => {
  const db = getDB();
  const all = db.onboardings || [];
  const byStatus = {};
  all.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
  res.json({
    total: all.length,
    byStatus,
    pending: all.filter(o => o.status === 'pending').length,
    approved: all.filter(o => o.status === 'approved').length,
    rejected: all.filter(o => o.status === 'rejected').length,
    converted: all.filter(o => o.converted).length
  });
});

// 管理端：入驻申请列表（支持按状态筛选）
router.get('/', authCheck, (req, res) => {
  const db = getDB();
  let rows = db.onboardings || [];
  if (req.query.status) rows = rows.filter(r => r.status === req.query.status);
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(rows);
});

// 管理端：单条入驻申请详情
router.get('/:id', authCheck, (req, res) => {
  const db = getDB();
  const item = db.onboardings.find(r => r.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '入驻申请不存在' });
  res.json(item);
});

// 管理端：审核入驻申请（通过/拒绝）
router.put('/:id/review', authCheck, (req, res) => {
  const { status, reject_reason } = req.body;
  if (!status || !['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status 参数错误' });
  }
  const db = getDB();
  const item = db.onboardings.find(r => r.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '入驻申请不存在' });
  item.status = status;
  item.reject_reason = reject_reason || '';
  item.updated_at = new Date().toISOString();
  syncRow('onboardings', item);
  // 通知申请人审核结果
  createNotification({
    type: 'onboarding',
    title: status === 'approved' ? '入驻审核通过' : '入驻审核未通过',
    content: status === 'approved'
      ? `恭喜！您的入驻申请「${item.product_title}」已审核通过，即将上线展示。`
      : `您的入驻申请「${item.product_title}」未通过审核。${reject_reason ? '原因：' + reject_reason : ''}`,
    target_phones: [item.contact_phone],
    link_type: 'onboarding',
    link_id: String(item.id),
    icon: status === 'approved' ? '✅' : '❌'
  });

  // 发送订阅消息通知审核结果
  if (item.contact_phone) {
    try {
      const subscribeMsg = require('./subscribe-msg');
      const db2 = require('../models/sqlite-db').getDB();
      // 通过手机号查找用户openid
      const user = db2.prepare('SELECT openid FROM users WHERE phone = ?').get(item.contact_phone);
      if (user && user.openid) {
        subscribeMsg.notifyUser(
          user.openid,
          'audit_result',
          {
            thing1: { value: item.product_title.substring(0, 20) },
            phrase1: { value: status === 'approved' ? '审核通过' : '未通过' },
            time1: { value: new Date().toLocaleString('zh-CN') },
            thing2: { value: reject_reason ? reject_reason.substring(0, 20) : '感谢您的参与' }
          },
          '/package-user/pages/my-onboarding/my-onboarding',
          'onboarding',
          item.id
        );
      }
    } catch (e) {
      console.warn('[Onboarding] 发送订阅消息失败:', e.message);
    }
  }
  res.json({ message: status === 'approved' ? '审核通过' : '已拒绝', id: item.id });
});

// 管理端：将审核通过的入驻申请转换为甲方 + 甲方产品
router.post('/:id/convert', authCheck, (req, res) => {
  const db = getDB();
  const onboarding = db.onboardings.find(r => r.id === Number(req.params.id));
  if (!onboarding) return res.status(404).json({ error: '入驻申请不存在' });
  if (onboarding.status !== 'approved') {
    return res.status(400).json({ error: '只有审核通过的申请才能转为甲方产品' });
  }
  if (onboarding.converted) {
    return res.status(400).json({ error: '该申请已转换，请勿重复操作' });
  }

  const now = new Date().toISOString();

  // 1. 创建/复用甲方客户
  let client = (db.clients || []).find(c => c.name === onboarding.company_name);
  let clientId;
  if (!client) {
    clientId = nextId('clients');
    client = {
      id: clientId,
      name: onboarding.company_name,
      short_name: onboarding.company_name.slice(0, 8),
      industry: onboarding.industry || '其他',
      avatar: '🏢',
      cover: '',
      description: onboarding.company_desc || `${onboarding.company_name} 入驻企业`,
      qualifications: [],
      team_size: '',
      founded: '',
      wechat_account_id: '',
      contact_phone: onboarding.contact_phone || '',
      contact_email: onboarding.contact_email || '',
      address: '',
      website: '',
      published: 1,
      created_at: now,
      updated_at: now
    };
    if (!db.clients) db.clients = [];
    db.clients.push(client);
  } else {
    clientId = client.id;
  }

  // 2. 创建甲方产品
  const productId = nextId('client_products');
  const clientProduct = {
    id: productId,
    clientId: `c${clientId}`,
    clientName: onboarding.company_name,
    clientIndustry: onboarding.industry || '其他',
    clientAvatar: '🏢',
    type: onboarding.product_type === '服务/撮合' ? 'service' : 'product',
    typeName: onboarding.product_type || '实体产品',
    title: onboarding.product_title,
    subtitle: onboarding.company_desc ? onboarding.company_desc.slice(0, 30) : '',
    price: null,
    unit: '面议',
    image: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=600',
    tags: onboarding.industry ? [onboarding.industry] : [],
    desc: onboarding.description || '',
    contact: onboarding.contact_phone || '',
    officialAccount: '',
    needMatch: onboarding.product_type === '服务/撮合',
    published: 1,
    onboarding_id: onboarding.id,
    created_at: now,
    updated_at: now
  };
  if (!db.client_products) db.client_products = [];
  db.client_products.push(clientProduct);

  // 3. 更新入驻申请状态
  onboarding.converted = true;
  onboarding.client_id = clientId;
  onboarding.client_product_id = productId;
  onboarding.updated_at = now;
  syncRow('onboardings', onboarding);

  res.json({
    message: '已转为甲方产品',
    client_id: clientId,
    client_product_id: productId
  });
});

module.exports = router;
