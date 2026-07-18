/**
 * 合作伙伴推荐计划 API
 *
 * 功能：
 * - 用户端：合作伙伴注册、推荐线索、查看佣金、申请提现
 * - 管理端：审核合作伙伴、管理推荐、确认佣金、处理提现
 *
 * 佣金规则：
 * - standard: 10%  | silver: 12% | gold: 15% | platinum: 20%
 * - 订单完成（completed）后佣金从 estimated → confirmed
 * - 提现审核通过后佣金从 confirmed → paid
 */

const express = require('express');
const router = express.Router();
const { getDB, nextId, save, syncRow } = require('../models/db');
const db = getDB();

// ===== 工具函数 =====

function genPartnerNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `P${ymd}${rand}`;
}

function genReferralNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `R${ymd}${rand}`;
}

function genWithdrawalNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `W${ymd}${rand}`;
}

const LEVEL_RATES = {
  standard: 10,
  silver: 12,
  gold: 15,
  platinum: 20
};

const LEVEL_LABELS = {
  standard: '标准伙伴',
  silver: '银牌伙伴',
  gold: '金牌伙伴',
  platinum: '白金伙伴'
};

const STATUS_LABELS = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
  suspended: '已暂停'
};

const REFERRAL_STATUS_LABELS = {
  pending: '待联系',
  contacted: '已联系',
  qualified: '意向确认',
  converted: '已成交',
  lost: '已流失'
};

const COMMISSION_STATUS_LABELS = {
  none: '无佣金',
  estimated: '预估中',
  confirmed: '已确认',
  paid: '已提现'
};

const WITHDRAWAL_STATUS_LABELS = {
  pending: '待审核',
  approved: '审核通过',
  rejected: '已拒绝',
  paid: '已打款',
  failed: '打款失败'
};

// ==================== 用户端接口 ====================

/**
 * POST /api/partners/register
 * 合作伙伴注册申请
 */
router.post('/register', (req, res) => {
  const { name, company, phone, email, openid, avatar, bank_name, bank_account, bank_holder, alipay_account, remark } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ code: 1, message: '姓名和手机号必填' });
  }

  // 检查是否已注册
  const existing = (db.partners || []).find(p => p.phone === phone);
  if (existing) {
    if (existing.status === 'rejected') {
      return res.json({ code: 1, message: '您的申请已被拒绝，请联系管理员' });
    }
    if (existing.status === 'suspended') {
      return res.json({ code: 1, message: '您的账号已被暂停，请联系管理员' });
    }
    return res.json({ code: 0, message: '已注册', data: existing });
  }

  const id = nextId('partners');
  const partner = {
    id,
    partner_no: genPartnerNo(),
    name,
    company: company || '',
    phone,
    email: email || '',
    openid: openid || '',
    avatar: avatar || '',
    level: 'standard',
    status: 'pending',
    commission_rate: LEVEL_RATES.standard,
    total_referrals: 0,
    successful_referrals: 0,
    total_commission: 0,
    paid_commission: 0,
    pending_commission: 0,
    bank_name: bank_name || '',
    bank_account: bank_account || '',
    bank_holder: bank_holder || '',
    alipay_account: alipay_account || '',
    reject_reason: '',
    approved_at: '',
    approved_by: '',
    remark: remark || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.partners.push(partner);

  res.json({ code: 0, message: '注册成功，等待审核', data: partner });
});

/**
 * GET /api/partners/info
 * 获取合作伙伴信息（通过手机号或 openid）
 */
router.get('/info', (req, res) => {
  const { phone, openid } = req.query;
  let partner = null;

  if (openid) {
    partner = (db.partners || []).find(p => p.openid === openid);
  }
  if (!partner && phone) {
    partner = (db.partners || []).find(p => p.phone === phone);
  }

  if (!partner) {
    return res.json({ code: 1, message: '未找到合作伙伴信息' });
  }
  if (partner.status === 'rejected') {
    return res.json({ code: 1, message: '您的申请已被拒绝', data: { status: partner.status, reject_reason: partner.reject_reason } });
  }
  if (partner.status === 'suspended') {
    return res.json({ code: 1, message: '账号已暂停', data: { status: partner.status } });
  }

  res.json({
    code: 0,
    data: {
      ...partner,
      level_label: LEVEL_LABELS[partner.level] || partner.level,
      status_label: STATUS_LABELS[partner.status] || partner.status
    }
  });
});

/**
 * GET /api/partners/dashboard
 * 合作伙伴工作台数据概览
 */
router.get('/dashboard', (req, res) => {
  const { partner_id } = req.query;
  const pid = parseInt(partner_id);
  if (!pid) return res.status(400).json({ code: 1, message: 'partner_id 必填' });

  const partner = (db.partners || []).find(p => p.id === pid);
  if (!partner) return res.json({ code: 1, message: '未找到合作伙伴' });

  const referrals = (db.referrals || []).filter(r => r.partner_id === pid);
  const commissions = (db.commission_records || []).filter(c => c.partner_id === pid);
  const withdrawals = (db.withdrawals || []).filter(w => w.partner_id === pid);

  // 按状态统计推荐
  const referralStats = {
    total: referrals.length,
    pending: referrals.filter(r => r.status === 'pending').length,
    contacted: referrals.filter(r => r.status === 'contacted').length,
    qualified: referrals.filter(r => r.status === 'qualified').length,
    converted: referrals.filter(r => r.status === 'converted').length,
    lost: referrals.filter(r => r.status === 'lost').length
  };

  // 佣金统计
  const commissionStats = {
    estimated: commissions.filter(c => c.status === 'estimated').reduce((s, c) => s + c.amount, 0),
    confirmed: commissions.filter(c => c.status === 'confirmed').reduce((s, c) => s + c.amount, 0),
    paid: commissions.filter(c => c.status === 'paid').reduce((s, c) => s + c.amount, 0),
    cancelled: commissions.filter(c => c.status === 'cancelled').reduce((s, c) => s + c.amount, 0)
  };

  // 近7天推荐趋势
  const now = new Date();
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const count = referrals.filter(r => (r.created_at || '').slice(0, 10) === dateStr).length;
    trend.push({ date: dateStr, count });
  }

  // 待审核提现
  const pendingWithdrawals = withdrawals.filter(w => w.status === 'pending').length;

  res.json({
    code: 0,
    data: {
      partner: {
        ...partner,
        level_label: LEVEL_LABELS[partner.level] || partner.level,
        status_label: STATUS_LABELS[partner.status] || partner.status
      },
      referralStats,
      commissionStats,
      pendingWithdrawals,
      trend,
      availableBalance: partner.total_commission - partner.paid_commission - partner.pending_commission
    }
  });
});

/**
 * POST /api/partners/referrals
 * 提交推荐线索
 */
router.post('/referrals', (req, res) => {
  const { partner_id, lead_name, lead_phone, lead_company, lead_industry, product_id, product_title, relationship, remark } = req.body;

  if (!partner_id || !lead_name || !lead_phone) {
    return res.status(400).json({ code: 1, message: '合作伙伴ID、线索姓名、线索手机号必填' });
  }

  const partner = (db.partners || []).find(p => p.id === parseInt(partner_id));
  if (!partner) return res.status(404).json({ code: 1, message: '合作伙伴不存在' });
  if (partner.status !== 'approved') return res.json({ code: 1, message: '合作伙伴尚未通过审核' });

  // 检查重复推荐（同一线索被同一伙伴推荐过）
  const dup = (db.referrals || []).find(r => r.partner_id === parseInt(partner_id) && r.lead_phone === lead_phone && r.status !== 'lost');
  if (dup) {
    return res.json({ code: 1, message: '该线索您已推荐过，请勿重复提交' });
  }

  const id = nextId('referrals');
  const referral = {
    id,
    referral_no: genReferralNo(),
    partner_id: parseInt(partner_id),
    partner_name: partner.name,
    lead_name,
    lead_phone,
    lead_company: lead_company || '',
    lead_industry: lead_industry || '',
    product_id: product_id || 0,
    product_title: product_title || '',
    relationship: relationship || 'friend',
    remark: remark || '',
    status: 'pending',
    order_id: 0,
    order_no: '',
    order_amount: 0,
    commission_amount: 0,
    commission_status: 'none',
    converted_at: '',
    lost_reason: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.referrals.push(referral);

  // 更新合作伙伴统计
  partner.total_referrals = (partner.total_referrals || 0) + 1;
  partner.updated_at = new Date().toISOString();
  db.partners.splice(db.partners.findIndex(p => p.id === partner.id), 1, partner);

  res.json({ code: 0, message: '推荐成功', data: referral });
});

/**
 * GET /api/partners/referrals
 * 获取我的推荐列表
 */
router.get('/referrals', (req, res) => {
  const { partner_id, status, page = 1, page_size = 20 } = req.query;
  const pid = parseInt(partner_id);
  if (!pid) return res.status(400).json({ code: 1, message: 'partner_id 必填' });

  let list = (db.referrals || []).filter(r => r.partner_id === pid);
  if (status) list = list.filter(r => r.status === status);

  list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = list.length;
  const start = (parseInt(page) - 1) * parseInt(page_size);
  const items = list.slice(start, start + parseInt(page_size));

  res.json({
    code: 0,
    data: {
      items: items.map(r => ({
        ...r,
        status_label: REFERRAL_STATUS_LABELS[r.status] || r.status,
        commission_status_label: COMMISSION_STATUS_LABELS[r.commission_status] || r.commission_status
      })),
      total,
      page: parseInt(page),
      page_size: parseInt(page_size)
    }
  });
});

/**
 * GET /api/partners/commissions
 * 获取我的佣金记录
 */
router.get('/commissions', (req, res) => {
  const { partner_id, status, page = 1, page_size = 20 } = req.query;
  const pid = parseInt(partner_id);
  if (!pid) return res.status(400).json({ code: 1, message: 'partner_id 必填' });

  let list = (db.commission_records || []).filter(c => c.partner_id === pid);
  if (status) list = list.filter(c => c.status === status);

  list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = list.length;
  const start = (parseInt(page) - 1) * parseInt(page_size);
  const items = list.slice(start, start + parseInt(page_size));

  res.json({
    code: 0,
    data: {
      items,
      total,
      page: parseInt(page),
      page_size: parseInt(page_size)
    }
  });
});

/**
 * GET /api/partners/withdrawals
 * 获取我的提现记录
 */
router.get('/withdrawals', (req, res) => {
  const { partner_id, page = 1, page_size = 20 } = req.query;
  const pid = parseInt(partner_id);
  if (!pid) return res.status(400).json({ code: 1, message: 'partner_id 必填' });

  let list = (db.withdrawals || []).filter(w => w.partner_id === pid);
  list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = list.length;
  const start = (parseInt(page) - 1) * parseInt(page_size);
  const items = list.slice(start, start + parseInt(page_size));

  res.json({
    code: 0,
    data: {
      items: items.map(w => ({
        ...w,
        status_label: WITHDRAWAL_STATUS_LABELS[w.status] || w.status
      })),
      total,
      page: parseInt(page),
      page_size: parseInt(page_size)
    }
  });
});

/**
 * POST /api/partners/withdrawals
 * 申请提现
 */
router.post('/withdrawals', (req, res) => {
  const { partner_id, amount, method, account_info } = req.body;
  const pid = parseInt(partner_id);
  if (!pid || !amount) return res.status(400).json({ code: 1, message: 'partner_id 和 amount 必填' });

  const partner = (db.partners || []).find(p => p.id === pid);
  if (!partner) return res.status(404).json({ code: 1, message: '合作伙伴不存在' });
  if (partner.status !== 'approved') return res.json({ code: 1, message: '合作伙伴尚未通过审核' });

  const available = partner.total_commission - partner.paid_commission - partner.pending_commission;
  if (amount > available) {
    return res.json({ code: 1, message: `可提现余额不足，当前可提现 ${available.toFixed(2)} 元` });
  }
  if (amount < 100) {
    return res.json({ code: 1, message: '最低提现金额 100 元' });
  }

  const id = nextId('withdrawals');
  const fee = Math.max(amount * 0.006, 0);  // 0.6% 手续费
  const withdrawal = {
    id,
    withdrawal_no: genWithdrawalNo(),
    partner_id: pid,
    partner_name: partner.name,
    amount,
    fee: parseFloat(fee.toFixed(2)),
    actual_amount: parseFloat((amount - fee).toFixed(2)),
    method: method || 'bank',
    account_info: account_info || {
      bank_name: partner.bank_name,
      bank_account: partner.bank_account,
      bank_holder: partner.bank_holder
    },
    status: 'pending',
    reject_reason: '',
    paid_at: '',
    paid_by: '',
    transaction_no: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.withdrawals.push(withdrawal);

  // 冻结佣金
  partner.pending_commission = (partner.pending_commission || 0) + amount;
  partner.updated_at = new Date().toISOString();
  db.partners.splice(db.partners.findIndex(p => p.id === partner.id), 1, partner);

  res.json({ code: 0, message: '提现申请已提交，等待审核', data: withdrawal });
});

// ==================== 管理端接口 ====================

/**
 * GET /api/partners/admin/list
 * 管理端合作伙伴列表
 */
router.get('/admin/list', (req, res) => {
  const { status, level, keyword, page = 1, page_size = 20 } = req.query;

  let list = [...(db.partners || [])];
  if (status) list = list.filter(p => p.status === status);
  if (level) list = list.filter(p => p.level === level);
  if (keyword) {
    const kw = keyword.toLowerCase();
    list = list.filter(p =>
      (p.name || '').toLowerCase().includes(kw) ||
      (p.phone || '').includes(kw) ||
      (p.company || '').toLowerCase().includes(kw) ||
      (p.partner_no || '').toLowerCase().includes(kw)
    );
  }

  list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = list.length;
  const start = (parseInt(page) - 1) * parseInt(page_size);
  const items = list.slice(start, start + parseInt(page_size));

  // 统计概览
  const allPartners = db.partners || [];
  const stats = {
    total: allPartners.length,
    pending: allPartners.filter(p => p.status === 'pending').length,
    approved: allPartners.filter(p => p.status === 'approved').length,
    rejected: allPartners.filter(p => p.status === 'rejected').length,
    suspended: allPartners.filter(p => p.status === 'suspended').length,
    totalCommission: allPartners.reduce((s, p) => s + (p.total_commission || 0), 0),
    totalPaid: allPartners.reduce((s, p) => s + (p.paid_commission || 0), 0)
  };

  res.json({
    code: 0,
    data: {
      items: items.map(p => ({
        ...p,
        level_label: LEVEL_LABELS[p.level] || p.level,
        status_label: STATUS_LABELS[p.status] || p.status
      })),
      total,
      page: parseInt(page),
      page_size: parseInt(page_size),
      stats
    }
  });
});

/**
 * PUT /api/partners/admin/:id
 * 审核或更新合作伙伴
 */
router.put('/admin/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const partner = (db.partners || []).find(p => p.id === id);
  if (!partner) return res.status(404).json({ code: 1, message: '合作伙伴不存在' });

  const { status, level, commission_rate, bank_name, bank_account, bank_holder, alipay_account, reject_reason } = req.body;

  const oldStatus = partner.status;

  if (status) {
    partner.status = status;
    if (status === 'approved' && oldStatus !== 'approved') {
      partner.approved_at = new Date().toISOString();
      partner.approved_by = req.body.admin_name || 'admin';
    }
    if (status === 'rejected') {
      partner.reject_reason = reject_reason || '';
    }
  }
  if (level) {
    partner.level = level;
    partner.commission_rate = LEVEL_RATES[level] || partner.commission_rate;
  }
  if (commission_rate !== undefined) partner.commission_rate = commission_rate;
  if (bank_name !== undefined) partner.bank_name = bank_name;
  if (bank_account !== undefined) partner.bank_account = bank_account;
  if (bank_holder !== undefined) partner.bank_holder = bank_holder;
  if (alipay_account !== undefined) partner.alipay_account = alipay_account;

  partner.updated_at = new Date().toISOString();
  db.partners.splice(db.partners.findIndex(p => p.id === id), 1, partner);

  res.json({ code: 0, message: '更新成功', data: partner });
});

/**
 * GET /api/partners/admin/referrals
 * 管理端推荐列表
 */
router.get('/admin/referrals', (req, res) => {
  const { status, partner_id, keyword, page = 1, page_size = 20 } = req.query;

  let list = [...(db.referrals || [])];
  if (status) list = list.filter(r => r.status === status);
  if (partner_id) list = list.filter(r => r.partner_id === parseInt(partner_id));
  if (keyword) {
    const kw = keyword.toLowerCase();
    list = list.filter(r =>
      (r.lead_name || '').toLowerCase().includes(kw) ||
      (r.lead_phone || '').includes(kw) ||
      (r.lead_company || '').toLowerCase().includes(kw) ||
      (r.partner_name || '').toLowerCase().includes(kw) ||
      (r.referral_no || '').toLowerCase().includes(kw)
    );
  }

  list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = list.length;
  const start = (parseInt(page) - 1) * parseInt(page_size);
  const items = list.slice(start, start + parseInt(page_size));

  res.json({
    code: 0,
    data: {
      items: items.map(r => ({
        ...r,
        status_label: REFERRAL_STATUS_LABELS[r.status] || r.status,
        commission_status_label: COMMISSION_STATUS_LABELS[r.commission_status] || r.commission_status
      })),
      total,
      page: parseInt(page),
      page_size: parseInt(page_size)
    }
  });
});

/**
 * PUT /api/partners/admin/referrals/:id
 * 更新推荐状态（管理端跟进）
 */
router.put('/admin/referrals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const referral = (db.referrals || []).find(r => r.id === id);
  if (!referral) return res.status(404).json({ code: 1, message: '推荐记录不存在' });

  const { status, lost_reason, order_id, order_no, order_amount } = req.body;

  const oldStatus = referral.status;
  if (status) referral.status = status;
  if (lost_reason) referral.lost_reason = lost_reason;
  if (order_id) referral.order_id = parseInt(order_id);
  if (order_no) referral.order_no = order_no;
  if (order_amount) referral.order_amount = parseFloat(order_amount);

  // 成交时自动创建佣金记录
  if (status === 'converted' && oldStatus !== 'converted') {
    referral.converted_at = new Date().toISOString();
    const partner = (db.partners || []).find(p => p.id === referral.partner_id);
    if (partner) {
      const rate = partner.commission_rate || 10;
      const commissionAmount = parseFloat((referral.order_amount * rate / 100).toFixed(2));
      referral.commission_amount = commissionAmount;
      referral.commission_status = 'estimated';

      // 创建佣金记录
      const cid = nextId('commission_records');
      const commission = {
        id: cid,
        partner_id: partner.id,
        partner_name: partner.name,
        referral_id: referral.id,
        referral_no: referral.referral_no,
        order_id: referral.order_id,
        order_no: referral.order_no,
        order_amount: referral.order_amount,
        rate,
        amount: commissionAmount,
        status: 'estimated',
        confirmed_at: '',
        paid_at: '',
        withdrawal_id: 0,
        remark: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      db.commission_records.push(commission);

      // 更新合作伙伴统计
      partner.successful_referrals = (partner.successful_referrals || 0) + 1;
      partner.total_commission = (partner.total_commission || 0) + commissionAmount;
      partner.pending_commission = (partner.pending_commission || 0) + commissionAmount;
      partner.updated_at = new Date().toISOString();
      db.partners.splice(db.partners.findIndex(p => p.id === partner.id), 1, partner);
    }
  }

  referral.updated_at = new Date().toISOString();
  db.referrals.splice(db.referrals.findIndex(r => r.id === id), 1, referral);

  res.json({ code: 0, message: '更新成功', data: referral });
});

/**
 * GET /api/partners/admin/commissions
 * 管理端佣金列表
 */
router.get('/admin/commissions', (req, res) => {
  const { status, partner_id, page = 1, page_size = 20 } = req.query;

  let list = [...(db.commission_records || [])];
  if (status) list = list.filter(c => c.status === status);
  if (partner_id) list = list.filter(c => c.partner_id === parseInt(partner_id));

  list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = list.length;
  const start = (parseInt(page) - 1) * parseInt(page_size);
  const items = list.slice(start, start + parseInt(page_size));

  res.json({
    code: 0,
    data: {
      items,
      total,
      page: parseInt(page),
      page_size: parseInt(page_size)
    }
  });
});

/**
 * PUT /api/partners/admin/commissions/:id
 * 更新佣金状态（确认/取消）
 */
router.put('/admin/commissions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const commission = (db.commission_records || []).find(c => c.id === id);
  if (!commission) return res.status(404).json({ code: 1, message: '佣金记录不存在' });

  const { status, remark } = req.body;

  if (status === 'confirmed' && commission.status === 'estimated') {
    commission.status = 'confirmed';
    commission.confirmed_at = new Date().toISOString();
    // 从 pending 移到 available
    const partner = (db.partners || []).find(p => p.id === commission.partner_id);
    if (partner) {
      partner.pending_commission = Math.max(0, (partner.pending_commission || 0) - commission.amount);
      partner.updated_at = new Date().toISOString();
      db.partners.splice(db.partners.findIndex(p => p.id === partner.id), 1, partner);
    }
  } else if (status === 'cancelled') {
    commission.status = 'cancelled';
    // 回扣合作伙伴统计
    const partner = (db.partners || []).find(p => p.id === commission.partner_id);
    if (partner) {
      partner.total_commission = Math.max(0, (partner.total_commission || 0) - commission.amount);
      partner.pending_commission = Math.max(0, (partner.pending_commission || 0) - commission.amount);
      partner.updated_at = new Date().toISOString();
      db.partners.splice(db.partners.findIndex(p => p.id === partner.id), 1, partner);
    }
  }
  if (remark !== undefined) commission.remark = remark;

  commission.updated_at = new Date().toISOString();
  db.commission_records.splice(db.commission_records.findIndex(c => c.id === id), 1, commission);

  res.json({ code: 0, message: '更新成功', data: commission });
});

/**
 * GET /api/partners/admin/withdrawals
 * 管理端提现列表
 */
router.get('/admin/withdrawals', (req, res) => {
  const { status, partner_id, page = 1, page_size = 20 } = req.query;

  let list = [...(db.withdrawals || [])];
  if (status) list = list.filter(w => w.status === status);
  if (partner_id) list = list.filter(w => w.partner_id === parseInt(partner_id));

  list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = list.length;
  const start = (parseInt(page) - 1) * parseInt(page_size);
  const items = list.slice(start, start + parseInt(page_size));

  // 统计
  const allWithdrawals = db.withdrawals || [];
  const stats = {
    total: allWithdrawals.length,
    pending: allWithdrawals.filter(w => w.status === 'pending').length,
    approved: allWithdrawals.filter(w => w.status === 'approved').length,
    paid: allWithdrawals.filter(w => w.status === 'paid').length,
    pendingAmount: allWithdrawals.filter(w => w.status === 'pending').reduce((s, w) => s + w.amount, 0)
  };

  res.json({
    code: 0,
    data: {
      items: items.map(w => ({
        ...w,
        status_label: WITHDRAWAL_STATUS_LABELS[w.status] || w.status
      })),
      total,
      page: parseInt(page),
      page_size: parseInt(page_size),
      stats
    }
  });
});

/**
 * PUT /api/partners/admin/withdrawals/:id
 * 处理提现（审核/打款/拒绝）
 */
router.put('/admin/withdrawals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const withdrawal = (db.withdrawals || []).find(w => w.id === id);
  if (!withdrawal) return res.status(404).json({ code: 1, message: '提现记录不存在' });

  const { status, reject_reason, transaction_no, admin_name } = req.body;
  const partner = (db.partners || []).find(p => p.id === withdrawal.partner_id);

  if (status === 'rejected' && withdrawal.status === 'pending') {
    withdrawal.status = 'rejected';
    withdrawal.reject_reason = reject_reason || '';
    // 解冻佣金
    if (partner) {
      partner.pending_commission = Math.max(0, (partner.pending_commission || 0) - withdrawal.amount);
      partner.updated_at = new Date().toISOString();
      db.partners.splice(db.partners.findIndex(p => p.id === partner.id), 1, partner);
    }
  } else if (status === 'paid' && (withdrawal.status === 'pending' || withdrawal.status === 'approved')) {
    withdrawal.status = 'paid';
    withdrawal.paid_at = new Date().toISOString();
    withdrawal.paid_by = admin_name || 'admin';
    withdrawal.transaction_no = transaction_no || '';
    // 从 pending 转到 paid
    if (partner) {
      partner.pending_commission = Math.max(0, (partner.pending_commission || 0) - withdrawal.amount);
      partner.paid_commission = (partner.paid_commission || 0) + withdrawal.amount;
      partner.updated_at = new Date().toISOString();
      db.partners.splice(db.partners.findIndex(p => p.id === partner.id), 1, partner);
    }
    // 标记关联佣金记录为已提现
    const relatedCommissions = (db.commission_records || []).filter(c => c.partner_id === withdrawal.partner_id && c.status === 'confirmed');
    for (const c of relatedCommissions) {
      c.status = 'paid';
      c.paid_at = new Date().toISOString();
      c.withdrawal_id = withdrawal.id;
      c.updated_at = new Date().toISOString();
      db.commission_records.splice(db.commission_records.findIndex(cc => cc.id === c.id), 1, c);
    }
  } else if (status === 'approved' && withdrawal.status === 'pending') {
    withdrawal.status = 'approved';
  }

  withdrawal.updated_at = new Date().toISOString();
  db.withdrawals.splice(db.withdrawals.findIndex(w => w.id === id), 1, withdrawal);

  res.json({ code: 0, message: '处理成功', data: withdrawal });
});

/**
 * GET /api/partners/admin/stats
 * 管理端统计数据
 */
router.get('/admin/stats', (req, res) => {
  const partners = db.partners || [];
  const referrals = db.referrals || [];
  const commissions = db.commission_records || [];
  const withdrawals = db.withdrawals || [];

  // 近30天趋势
  const now = new Date();
  const dailyStats = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    dailyStats.push({
      date: dateStr,
      referrals: referrals.filter(r => (r.created_at || '').slice(0, 10) === dateStr).length,
      converted: referrals.filter(r => r.status === 'converted' && (r.converted_at || '').slice(0, 10) === dateStr).length
    });
  }

  // 等级分布
  const levelDistribution = {};
  for (const lv of Object.keys(LEVEL_LABELS)) {
    levelDistribution[lv] = {
      label: LEVEL_LABELS[lv],
      count: partners.filter(p => p.level === lv).length
    };
  }

  // 转化漏斗
  const funnel = {
    referrals: referrals.length,
    contacted: referrals.filter(r => ['contacted', 'qualified', 'converted'].includes(r.status)).length,
    qualified: referrals.filter(r => ['qualified', 'converted'].includes(r.status)).length,
    converted: referrals.filter(r => r.status === 'converted').length
  };

  res.json({
    code: 0,
    data: {
      overview: {
        totalPartners: partners.length,
                        activePartners: partners.filter(p => p.status === 'approved').length,
        pendingPartners: partners.filter(p => p.status === 'pending').length,
        totalReferrals: referrals.length,
        convertedReferrals: referrals.filter(r => r.status === 'converted').length,
        conversionRate: referrals.length ? (referrals.filter(r => r.status === 'converted').length / referrals.length * 100).toFixed(1) : 0,
        totalCommission: commissions.reduce((s, c) => s + c.amount, 0),
                        paidCommission: commissions.filter(c => c.status === 'paid').reduce((s, c) => s + c.amount, 0),
        pendingWithdrawals: withdrawals.filter(w => w.status === 'pending').length
      },
      levelDistribution,
      funnel,
      dailyStats
    }
  });
});

module.exports = router;
