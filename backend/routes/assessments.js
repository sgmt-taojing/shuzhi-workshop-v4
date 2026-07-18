const express = require('express');
const router = express.Router();
const { getDB, getRawDB } = require('../models/db');
const { nextId } = require('../models/sqlite-db');

// ==================== 问卷配置 ====================

const DIMENSIONS = [
  {
    key: 'strategy',
    label: '战略与组织',
    icon: '🎯',
    description: '数字化战略规划、组织架构适配、管理层重视程度',
    maxScore: 20,
    questions: [
      {
        id: 's1',
        text: '公司是否有明确的数字化转型战略规划？',
        options: [
          { text: '没有，走一步看一步', score: 0 },
          { text: '有初步想法，但未形成文档', score: 1 },
          { text: '有年度规划，管理层定期讨论', score: 3 },
          { text: '有3-5年战略，专项预算和KPI', score: 5 }
        ]
      },
      {
        id: 's2',
        text: '数字化转型的负责人的层级是？',
        options: [
          { text: 'IT人员兼任', score: 0 },
          { text: '部门经理', score: 1 },
          { text: '副总/CTO', score: 3 },
          { text: 'CEO/董事长亲自抓', score: 5 }
        ]
      },
      {
        id: 's3',
        text: '年度数字化投入占营收的比例？',
        options: [
          { text: '不到0.5%', score: 0 },
          { text: '0.5%-1%', score: 1 },
          { text: '1%-3%', score: 3 },
          { text: '3%以上', score: 5 }
        ]
      },
      {
        id: 's4',
        text: '是否设有数字化专项预算？',
        options: [
          { text: '没有', score: 0 },
          { text: '从IT预算中划拨', score: 2 },
          { text: '有独立数字化预算', score: 5 }
        ]
      }
    ]
  },
  {
    key: 'data',
    label: '数据资产',
    icon: '📊',
    description: '数据采集、存储、分析与应用能力',
    maxScore: 20,
    questions: [
      {
        id: 'd1',
        text: '核心业务数据（订单/客户/库存）的电子化程度？',
        options: [
          { text: '主要靠纸质/Excel', score: 0 },
          { text: '部分系统化，部分Excel', score: 1 },
          { text: '核心系统已电子化', score: 3 },
          { text: '全链路数据在线，实时可查', score: 5 }
        ]
      },
      {
        id: 'd2',
        text: '是否有统一的数据看板/BI系统？',
        options: [
          { text: '没有', score: 0 },
          { text: '用Excel做报表', score: 1 },
          { text: '有BI工具但用得不多', score: 3 },
          { text: '管理层日常看BI决策', score: 5 }
        ]
      },
      {
        id: 'd3',
        text: '数据是否跨部门共享和打通？',
        options: [
          { text: '各部门数据孤岛', score: 0 },
          { text: '部分打通，需手工导出', score: 1 },
          { text: '主要系统已打通', score: 3 },
          { text: '统一数据中台', score: 5 }
        ]
      },
      {
        id: 'd4',
        text: '是否利用数据做预测或智能决策？',
        options: [
          { text: '没有', score: 0 },
          { text: '偶尔看数据做判断', score: 1 },
          { text: '有预测模型', score: 3 },
          { text: 'AI辅助决策已成常态', score: 5 }
        ]
      }
    ]
  },
  {
    key: 'process',
    label: '流程与运营',
    icon: '⚙️',
    description: '核心业务流程的自动化、在线化程度',
    maxScore: 20,
    questions: [
      {
        id: 'p1',
        text: '核心业务流程（采购/生产/销售/财务）的在线化程度？',
        options: [
          { text: '主要靠线下/纸质', score: 0 },
          { text: '部分流程有系统', score: 1 },
          { text: '主要流程已系统化', score: 3 },
          { text: '全流程在线，无纸化', score: 5 }
        ]
      },
      {
        id: 'p2',
        text: '审批流程的电子化程度？',
        options: [
          { text: '纸质签字', score: 0 },
          { text: '微信/邮件口头审批', score: 1 },
          { text: '有OA/审批系统', score: 3 },
          { text: '智能审批+自动流转', score: 5 }
        ]
      },
      {
        id: 'p3',
        text: '供应链/上下游协同在线化程度？',
        options: [
          { text: '电话/邮件沟通', score: 0 },
          { text: '部分供应商有系统对接', score: 1 },
          { text: '主要供应商系统协同', score: 3 },
          { text: '全链路数字化协同', score: 5 }
        ]
      },
      {
        id: 'p4',
        text: '是否有过流程自动化(RPA)实践？',
        options: [
          { text: '没有', score: 0 },
          { text: '了解但未尝试', score: 1 },
          { text: '有1-2个RPA场景', score: 3 },
          { text: '多场景RPA常态化运行', score: 5 }
        ]
      }
    ]
  },
  {
    key: 'customer',
    label: '客户与营销',
    icon: '👥',
    description: '客户触点数字化、营销获客、客户运营',
    maxScore: 20,
    questions: [
      {
        id: 'c1',
        text: '客户触点（官网/小程序/公众号/抖音等）覆盖情况？',
        options: [
          { text: '几乎没有线上触点', score: 0 },
          { text: '有公众号', score: 1 },
          { text: '公众号+小程序+官网', score: 3 },
          { text: '全渠道矩阵运营', score: 5 }
        ]
      },
      {
        id: 'c2',
        text: '是否有客户管理系统(CRM)？',
        options: [
          { text: '没有', score: 0 },
          { text: '用Excel管客户', score: 1 },
          { text: '有CRM系统', score: 3 },
          { text: 'CRM+SCRM全链路', score: 5 }
        ]
      },
      {
        id: 'c3',
        text: '线上获客渠道的占比？',
        options: [
          { text: '几乎为零', score: 0 },
          { text: '10%以下', score: 1 },
          { text: '10%-30%', score: 3 },
          { text: '30%以上', score: 5 }
        ]
      },
      {
        id: 'c4',
        text: '是否做客户分层/精准营销？',
        options: [
          { text: '没有', score: 0 },
          { text: '简单分大客户/小客户', score: 1 },
          { text: '有标签体系', score: 3 },
          { text: 'AI驱动的精准营销', score: 5 }
        ]
      }
    ]
  },
  {
    key: 'tech',
    label: '技术与安全',
    icon: '🔧',
    description: 'IT基础设施、系统架构、信息安全',
    maxScore: 20,
    questions: [
      {
        id: 't1',
        text: '核心业务系统的部署方式？',
        options: [
          { text: '本地服务器/单机', score: 0 },
          { text: '部分上云', score: 1 },
          { text: '主要系统已上云', score: 3 },
          { text: '云原生架构', score: 5 }
        ]
      },
      {
        id: 't2',
        text: '系统间的集成方式？',
        options: [
          { text: '人工搬数据', score: 0 },
          { text: '部分API对接', score: 1 },
          { text: '主要系统API集成', score: 3 },
          { text: '统一API网关/微服务', score: 5 }
        ]
      },
      {
        id: 't3',
        text: '信息安全措施？',
        options: [
          { text: '基本没有', score: 0 },
          { text: '有防火墙/杀毒', score: 1 },
          { text: '有安全制度+定期检查', score: 3 },
          { text: '等保合规+安全运营', score: 5 }
        ]
      },
      {
        id: 't4',
        text: '是否有专职IT团队？',
        options: [
          { text: '没有，外包', score: 0 },
          { text: '1-2人兼管', score: 1 },
          { text: '3人以上IT团队', score: 3 },
          { text: '完整IT部门+CTO', score: 5 }
        ]
      }
    ]
  }
];

// 等级定义
const LEVELS = [
  { minScore: 0, maxScore: 30, level: 'beginner', label: '数字化起步期', color: '#ef4444', description: '数字化基础薄弱，建议从核心流程电子化和基础工具入手，快速补齐短板。' },
  { minScore: 30, maxScore: 55, level: 'exploring', label: '数字化探索期', color: '#f59e0b', description: '已有数字化意识，部分系统在建。建议打通数据孤岛，推进核心流程在线化。' },
  { minScore: 55, maxScore: 75, level: 'intermediate', label: '数字化成长期', color: '#3b82f6', description: '数字化体系初步成型。下一步应聚焦数据驱动决策和跨部门协同，提升运营效率。' },
  { minScore: 75, maxScore: 101, level: 'advanced', label: '数字化成熟期', color: '#10b981', description: '数字化能力较强，已具备数据驱动决策能力。建议探索AI应用和生态协同，迈向智能化。' }
];

// ==================== 工具函数 ====================

function getLevelByScore(score) {
  return LEVELS.find(l => score >= l.minScore && score < l.maxScore) || LEVELS[0];
}

function getDimensionLevel(score, maxScore) {
  const pct = (score / maxScore) * 100;
  if (pct < 30) return { label: '薄弱', color: '#ef4444' };
  if (pct < 60) return { label: '一般', color: '#f59e0b' };
  if (pct < 80) return { label: '良好', color: '#3b82f6' };
  return { label: '优秀', color: '#10b981' };
}

function generateReport(dimensionScores, totalScore, industry) {
  const level = getLevelByScore(totalScore);
  
  // 找出最弱维度和最强维度
  const sorted = [...dimensionScores].sort((a, b) => (a.score / a.maxScore) - (b.score / b.maxScore));
  const weakest = sorted[0];
  const strongest = sorted[sorted.length - 1];
  
  // 生成摘要
  let summary = `贵企业数字化成熟度总分为 ${totalScore}/100 分，处于「${level.label}」。\n\n`;
  summary += `在五大维度中，「${strongest.label}」表现最为突出（${strongest.score}/${strongest.maxScore}），`;
  summary += `而「${weakest.label}」是最需要提升的短板（${weakest.score}/${weakest.maxScore}）。\n\n`;
  summary += level.description;
  
  // 推荐产品
  const recommendations = generateRecommendations(dimensionScores, totalScore, industry);
  
  return { summary, recommendations, level };
}

function generateRecommendations(dimensionScores, totalScore, industry) {
  const _db = getDB();
  const products = (_db.products || []).filter(p => p.published !== false && p.status !== 'draft');
  const painPoints = _db.pain_points || [];
  const recommendations = [];
  
  // 按维度短板推荐
  const dimensionProductMap = {
    strategy: { keywords: ['数字化', '战略', '规划', '咨询', '诊断'], painIds: [] },
    data: { keywords: ['数据', 'BI', '中台', '分析', '报表', '大数据'], painIds: [] },
    process: { keywords: ['ERP', 'MES', 'OA', '流程', '协同', '自动化', 'RPA'], painIds: [] },
    customer: { keywords: ['CRM', '营销', 'SCRM', '客户', '小程序', '私域'], painIds: [] },
    tech: { keywords: ['云', '安全', 'API', '微服务', '架构', '运维'], painIds: [] }
  };
  
  for (const dim of dimensionScores) {
    const pct = dim.score / dim.maxScore;
    if (pct < 0.6) {
      // 短板维度，推荐相关产品
      const config = dimensionProductMap[dim.key];
      if (config) {
        const matched = products.filter(p => {
          const tags = (p.tags || []).join(' ').toLowerCase();
          const title = (p.title || '').toLowerCase();
          const subtitle = (p.subtitle || '').toLowerCase();
          return config.keywords.some(kw => 
            tags.includes(kw.toLowerCase()) || 
            title.includes(kw.toLowerCase()) ||
            subtitle.includes(kw.toLowerCase())
          );
        }).slice(0, 2);
        
        for (const p of matched) {
          if (!recommendations.find(r => r.product_id === p.id)) {
            recommendations.push({
              product_id: p.id,
              title: p.title,
              subtitle: p.subtitle || '',
              icon: p.icon || '📦',
              category: p.category || '',
              price: p.price || 0,
              unit: p.unit || '',
              reason: `提升「${dim.label}」短板`,
              priority: pct < 0.3 ? 'high' : 'medium'
            });
          }
        }
      }
    }
  }
  
  // 如果推荐不足，补充通用推荐
  if (recommendations.length < 3) {
    const existing = recommendations.map(r => r.product_id);
    const fallback = products
      .filter(p => !existing.includes(p.id))
      .slice(0, 3 - recommendations.length)
      .map(p => ({
        product_id: p.id,
        title: p.title,
        subtitle: p.subtitle || '',
        icon: p.icon || '📦',
        category: p.category || '',
        price: p.price || 0,
        unit: p.unit || '',
        reason: '精选推荐',
        priority: 'low'
      }));
    recommendations.push(...fallback);
  }
  
  return recommendations.slice(0, 5);
}

// ==================== API 接口 ====================

/**
 * GET /api/assessments/questionnaire
 * 获取评估问卷配置
 */
router.get('/questionnaire', (req, res) => {
  res.json({
    dimensions: DIMENSIONS.map(d => ({
      key: d.key,
      label: d.label,
      icon: d.icon,
      description: d.description,
      maxScore: d.maxScore,
      questionCount: d.questions.length,
      questions: d.questions
    })),
    levels: LEVELS,
    totalQuestions: DIMENSIONS.reduce((sum, d) => sum + d.questions.length, 0),
    estimatedTime: '3-5分钟'
  });
});

/**
 * POST /api/assessments/submit
 * 提交评估问卷
 * Body: { openid, company_name, contact_name, phone, industry, company_size, answers: [{dimension, question_id, score}] }
 */
router.post('/submit', (req, res) => {
  try {
    const { openid, company_name, contact_name, phone, industry, company_size, answers } = req.body;
    
    if (!answers || !Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ error: '答案不能为空' });
    }

    // 计算各维度得分
    const dimensionScores = [];
    let totalScore = 0;
    
    for (const dim of DIMENSIONS) {
      let dimScore = 0;
      const dimAnswers = answers.filter(a => a.dimension === dim.key);
      
      for (const answer of dimAnswers) {
        const question = dim.questions.find(q => q.id === answer.question_id);
        if (question) {
          const option = question.options[answer.option_index];
          if (option) {
            dimScore += option.score;
          }
        }
      }
      
      // 按维度最大分归一化到20分
      const rawMax = dim.questions.reduce((sum, q) => sum + Math.max(...q.options.map(o => o.score)), 0);
      const normalizedScore = rawMax > 0 ? Math.round((dimScore / rawMax) * dim.maxScore * 10) / 10 : 0;
      
      const dimLevel = getDimensionLevel(normalizedScore, dim.maxScore);
      
      dimensionScores.push({
        key: dim.key,
        label: dim.label,
        icon: dim.icon,
        score: normalizedScore,
        maxScore: dim.maxScore,
        percentage: Math.round((normalizedScore / dim.maxScore) * 100),
        level: dimLevel.label,
        levelColor: dimLevel.color
      });
      
      totalScore += normalizedScore;
    }
    
    totalScore = Math.round(totalScore);
    
    // 确定等级
    const levelInfo = getLevelByScore(totalScore);
    
    // 生成报告
    const { summary, recommendations } = generateReport(dimensionScores, totalScore, industry);
    
    // 创建联系记录（如果提供了联系方式）
    let contactId = 0;
    if (phone && contact_name) {
      const _db = getDB();
      const existingContact = (_db.contacts || []).find(c => c.phone === phone);
      if (existingContact) {
        contactId = existingContact.id;
      } else {
        const newContact = {
          id: nextId('contacts'),
          name: contact_name,
          phone: phone,
          company: company_name || '',
          industry: industry || '',
          message: `数字化评估提交 - 总分${totalScore}/100 (${levelInfo.label})`,
          status: 'new',
          lead_source: 'assessment',
          lead_score: totalScore > 55 ? 70 : 40,
          demand: '数字化成熟度评估',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        _db.contacts.push(newContact);
        contactId = newContact.id;
      }
    }
    
    // 保存评估记录
    const _db2 = getDB();
    const assessment = {
      id: nextId('assessments'),
      openid: openid || '',
      company_name: company_name || '',
      contact_name: contact_name || '',
      phone: phone || '',
      industry: industry || '',
      company_size: company_size || '',
      answers: answers,
      total_score: totalScore,
      max_score: 100,
      level: levelInfo.level,
      level_label: levelInfo.label,
      dimension_scores: dimensionScores,
      recommendations: recommendations,
      report_summary: summary,
      status: 'completed',
      contact_id: contactId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    _db2.assessments.push(assessment);
    
    res.json({
      id: assessment.id,
      total_score: totalScore,
      max_score: 100,
      level: levelInfo.level,
      level_label: levelInfo.label,
      level_color: levelInfo.color,
      level_description: levelInfo.description,
      dimension_scores: dimensionScores,
      report_summary: summary,
      recommendations: recommendations,
      contact_id: contactId
    });
  } catch (err) {
    console.error('评估提交错误:', err);
    res.status(500).json({ error: '评估服务异常', message: err.message });
  }
});

/**
 * GET /api/assessments/list
 * 评估记录列表（管理端）
 */
router.get('/list', (req, res) => {
  try {
    const { page = 1, pageSize = 20, level, industry, status, keyword } = req.query;
    let list = [...(getDB().assessments || [])];
    
    // 筛选
    if (level) list = list.filter(a => a.level === level);
    if (industry) list = list.filter(a => a.industry === industry);
    if (status) list = list.filter(a => a.status === status);
    if (keyword) {
      const kw = keyword.toLowerCase();
      list = list.filter(a => 
        (a.company_name || '').toLowerCase().includes(kw) ||
        (a.contact_name || '').toLowerCase().includes(kw) ||
        (a.phone || '').includes(keyword)
      );
    }
    
    // 排序
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    // 分页
    const total = list.length;
    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + Number(pageSize));
    
    res.json({
      items,
      total,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(total / pageSize)
    });
  } catch (err) {
    res.status(500).json({ error: '查询失败', message: err.message });
  }
});

/**
 * GET /api/assessments/stats/overview
 * 评估统计概览（管理端）
 */
router.get('/stats/overview', (req, res) => {
  try {
    const list = getDB().assessments || [];
    const total = list.length;
    
    // 等级分布
    const levelDist = {};
    for (const l of LEVELS) {
      levelDist[l.level] = list.filter(a => a.level === l.level).length;
    }
    
    // 平均分
    const avgScore = total > 0 ? Math.round(list.reduce((sum, a) => sum + (a.total_score || 0), 0) / total) : 0;
    
    // 行业分布
    const industryDist = {};
    for (const a of list) {
      const ind = a.industry || '未知';
      industryDist[ind] = (industryDist[ind] || 0) + 1;
    }
    
    // 转化统计
    const contacted = list.filter(a => a.status === 'contacted' || a.status === 'converted').length;
    const converted = list.filter(a => a.status === 'converted').length;
    
    // 最近7天
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentCount = list.filter(a => a.created_at >= sevenDaysAgo).length;
    
    // 维度平均分
    const dimAvgs = DIMENSIONS.map(dim => {
      const scores = list.map(a => {
        const ds = (a.dimension_scores || []).find(s => s.key === dim.key);
        return ds ? ds.score : 0;
      });
      return {
        key: dim.key,
        label: dim.label,
        icon: dim.icon,
        avgScore: total > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / total * 10) / 10 : 0,
        maxScore: dim.maxScore
      };
    });
    
    res.json({
      total,
      avgScore,
      levelDist,
      industryDist,
      contacted,
      converted,
      conversionRate: total > 0 ? Math.round(converted / total * 100) : 0,
      recentCount,
      dimensionAverages: dimAvgs
    });
  } catch (err) {
    res.status(500).json({ error: '统计失败', message: err.message });
  }
});

/**
 * PUT /api/assessments/:id/status
 * 更新评估状态（管理端标记跟进）
 */
router.put('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    const list = getDB().assessments || [];
    const assessment = list.find(a => a.id === Number(req.params.id));
    if (!assessment) return res.status(404).json({ error: '记录不存在' });
    
    assessment.status = status;
    assessment.updated_at = new Date().toISOString();
    
    // 同步到数据库
    const sqliteDB = getRawDB();
    sqliteDB.prepare('UPDATE assessments SET status = ?, updated_at = ? WHERE id = ?').run(status, assessment.updated_at, assessment.id);
    
    res.json({ success: true, assessment });
  } catch (err) {
    res.status(500).json({ error: '更新失败', message: err.message });
  }
});

/**
 * GET /api/assessments/my/:openid
 * 获取用户自己的评估历史
 */
router.get('/my/:openid', (req, res) => {
  try {
    const list = (getDB().assessments || [])
      .filter(a => a.openid === req.params.openid)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    res.json({ items: list, total: list.length });
  } catch (err) {
    res.status(500).json({ error: '查询失败', message: err.message });
  }
});

/**
 * GET /api/assessments/:id
 * 获取评估报告详情
 */
router.get('/:id', (req, res) => {
  try {
    const assessment = (getDB().assessments || []).find(a => a.id === Number(req.params.id));
    if (!assessment) return res.status(404).json({ error: '评估记录不存在' });
    res.json(assessment);
  } catch (err) {
    res.status(500).json({ error: '查询失败', message: err.message });
  }
});

module.exports = router;
