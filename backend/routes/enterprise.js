const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

// ==================== 常量 ====================
const CREDIT_GRADES = ['AAA','AA','A','BBB','BB','B','C'];
const CERT_TYPES = { iso:'ISO认证', qualification:'资质', patent:'专利', trademark:'商标', other:'其他' };
const CERT_STATUS = { valid:'有效', expired:'已过期', revoked:'已撤销' };

// ==================== 企业画像 ====================

// GET / — 画像列表
router.get('/', (req, res) => {
  const db = getDB();
  let rows = (db.enterprise_profiles || []).slice();

  const search = req.query.search;
  if (search) {
    const kw = search.toLowerCase();
    rows = rows.filter(r => {
      const client = (db.clients || []).find(c => c.id === r.client_id);
      const name = (client && client.name || '').toLowerCase();
      return name.includes(kw) || JSON.stringify(r.capability_tags || []).toLowerCase().includes(kw);
    });
  }

  const grade = req.query.grade;
  if (grade && grade !== 'all') rows = rows.filter(r => r.credit_grade === grade);

  rows.sort((a, b) => (b.credit_score || 0) - (a.credit_score || 0));

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = rows.length;
  const list = rows.slice((page - 1) * limit, page * limit).map(r => {
    const client = (db.clients || []).find(c => c.id === r.client_id);
    return { ...r, client_name: client ? client.name : '', client_industry: client ? client.industry : '' };
  });

  res.json({ list, total, page, limit });
});

// GET /:id — 画像详情
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '无效ID' });

  const db = getDB();
  const profile = (db.enterprise_profiles || []).find(r => r.id === id);
  if (!profile) return res.status(404).json({ error: '画像不存在' });

  const client = (db.clients || []).find(c => c.id === profile.client_id);
  const certs = (db.enterprise_certificates || []).filter(c => c.client_id === profile.client_id);

  res.json({ ...profile, client, certificates: certs });
});

// POST / — 创建画像
router.post('/', (req, res) => {
  const { client_id, credit_score, credit_grade, capability_tags, industry_tags, service_tags, intro, radar_scores, badges } = req.body;
  if (!client_id) return res.status(400).json({ error: '缺少客户ID' });

  const db = getDB();
  const exist = (db.enterprise_profiles || []).find(r => r.client_id === client_id);
  if (exist) return res.status(409).json({ error: '该客户已有画像' });

  const id = nextId('enterprise_profiles');
  const now = new Date().toISOString();
  const profile = {
    id,
    client_id,
    credit_score: credit_score ?? 60,
    credit_grade: credit_grade || 'B',
    capability_tags: capability_tags || [],
    industry_tags: industry_tags || [],
    service_tags: service_tags || [],
    case_count: 0,
    contract_fulfillment_rate: 100,
    avg_rating: 0,
    total_revenue: 0,
    radar_scores: radar_scores || {},
    badges: badges || [],
    intro: intro || '',
    updated_at: now
  };
  db.enterprise_profiles.push(profile);
  res.status(201).json(profile);
});

// PUT /:id — 更新画像
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const profile = (db.enterprise_profiles || []).find(r => r.id === id);
  if (!profile) return res.status(404).json({ error: '画像不存在' });

  const fields = ['credit_score','credit_grade','capability_tags','industry_tags','service_tags','intro','radar_scores','badges','case_count','contract_fulfillment_rate','avg_rating','total_revenue'];
  fields.forEach(f => {
    if (req.body[f] !== undefined) profile[f] = req.body[f];
  });
  profile.updated_at = new Date().toISOString();
  syncRow('enterprise_profiles', profile);
  res.json(profile);
});

// DELETE /:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const idx = (db.enterprise_profiles || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '画像不存在' });
  db.enterprise_profiles.splice(idx, 1);
  deleteRows('enterprise_profiles', { id });
  res.json({ success: true });
});

// ==================== 资质证书 ====================

// GET /:clientId/certificates
router.get('/:id/certificates', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const profile = (db.enterprise_profiles || []).find(r => r.id === id);
  if (!profile) return res.status(404).json({ error: '画像不存在' });

  const certs = (db.enterprise_certificates || []).filter(c => c.client_id === profile.client_id);
  res.json({ list: certs });
});

// POST /:id/certificates
router.post('/:id/certificates', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const profile = (db.enterprise_profiles || []).find(r => r.id === id);
  if (!profile) return res.status(404).json({ error: '画像不存在' });

  const { name, type, issuer, issue_date, expire_date, image_url, status } = req.body;
  if (!name) return res.status(400).json({ error: '证书名称不能为空' });

  const cid = nextId('enterprise_certificates');
  const cert = {
    id: cid,
    client_id: profile.client_id,
    name,
    type: type || 'other',
    issuer: issuer || '',
    issue_date: issue_date || '',
    expire_date: expire_date || '',
    image_url: image_url || '',
    status: status || 'valid',
    created_at: new Date().toISOString()
  };
  db.enterprise_certificates.push(cert);
  res.status(201).json(cert);
});

// PUT /:id/certificates/:cid
router.put('/:id/certificates/:cid', (req, res) => {
  const cid = Number(req.params.cid);
  const db = getDB();
  const cert = (db.enterprise_certificates || []).find(c => c.id === cid);
  if (!cert) return res.status(404).json({ error: '证书不存在' });

  ['name','type','issuer','issue_date','expire_date','image_url','status'].forEach(f => {
    if (req.body[f] !== undefined) cert[f] = req.body[f];
  });
  syncRow('enterprise_certificates', cert);
  res.json(cert);
});

// DELETE /:id/certificates/:cid
router.delete('/:id/certificates/:cid', (req, res) => {
  const cid = Number(req.params.cid);
  const db = getDB();
  const idx = (db.enterprise_certificates || []).findIndex(c => c.id === cid);
  if (idx === -1) return res.status(404).json({ error: '证书不存在' });
  db.enterprise_certificates.splice(idx, 1);
  deleteRows('enterprise_certificates', { id: cid });
  res.json({ success: true });
});

// ==================== 信用评估 ====================
// POST /:id/assess — 重新计算信用分
router.post('/:id/assess', (req, res) => {
  const id = Number(req.params.id);
  const db = getDB();
  const profile = (db.enterprise_profiles || []).find(r => r.id === id);
  if (!profile) return res.status(404).json({ error: '画像不存在' });

  const client = (db.clients || []).find(c => c.id === profile.client_id);
  const certs = (db.enterprise_certificates || []).filter(c => c.client_id === profile.client_id && c.status === 'valid');
  const reviews = (db.reviews || []).filter(r => r.client_id === profile.client_id);
  const contracts = (db.contracts || []).filter(c => c.client_id === profile.client_id);

  // 信用分算法：基础60 + 资质加成 + 评价加成 + 履约加成 - 风险扣分
  let score = 60;
  score += Math.min(certs.length * 3, 15); // 资质证书加分（上限15）
  if (reviews.length > 0) {
    const avgRating = reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length;
    score += Math.round((avgRating - 3) * 5); // 评价加分
  }
  if (contracts.length > 0) {
    const fulfilled = contracts.filter(c => c.status === 'completed').length;
    const rate = fulfilled / contracts.length;
    score += Math.round(rate * 10); // 履约加分
    profile.contract_fulfillment_rate = Math.round(rate * 100);
  }
  score = Math.max(0, Math.min(100, score));

  // 信用等级
  const grade = score >= 90 ? 'AAA' : score >= 80 ? 'AA' : score >= 70 ? 'A' : score >= 60 ? 'BBB' : score >= 50 ? 'BB' : score >= 40 ? 'B' : 'C';

  // 雷达图分数
  profile.radar_scores = {
    技术能力: Math.min(100, certs.filter(c => c.type === 'iso' || c.type === 'patent').length * 20 + 40),
    服务质量: reviews.length > 0 ? Math.round(reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length * 20) : 40,
    履约能力: profile.contract_fulfillment_rate,
    行业经验: Math.min(100, (client && client.founded ? Math.min((2026 - parseInt(client.founded)) * 5, 100) : 30)),
    资质完备: Math.min(100, certs.length * 15 + 30)
  };

  profile.credit_score = score;
  profile.credit_grade = grade;
  profile.avg_rating = reviews.length > 0 ? Math.round(reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length * 10) / 10 : 0;
  profile.case_count = contracts.filter(c => c.status === 'completed').length;
  profile.updated_at = new Date().toISOString();
  syncRow('enterprise_profiles', profile);

  res.json({ score, grade, radar_scores: profile.radar_scores, ...profile });
});

module.exports = router;
