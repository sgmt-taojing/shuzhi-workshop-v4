/**
 * FAQ 帮助中心 API
 * 
 * 提供常见问题分类管理与条目 CRUD，支持：
 * - 公开接口：获取分类列表、获取FAQ列表（按分类/搜索）、获取详情、反馈有用/无用
 * - 管理端：分类CRUD、FAQ CRUD、排序、置顶、统计
 */

const express = require('express');
const router = express.Router();
const { getDB, save } = require('../models/db');

// ==================== 公开接口 ====================

/**
 * GET /api/faqs/categories
 * 获取所有启用的FAQ分类（含条目数）
 */
router.get('/categories', (req, res) => {
  const db = getDB();
  const categories = db.faq_categories
    .filter(c => c.status === 'active')
    .sort((a, b) => a.sort_order - b.sort_order);
  
  // 附上每个分类的条目数
  const result = categories.map(cat => {
    const count = db.faqs.filter(f => f.category_id === cat.id && f.status === 'published').length;
    return { ...cat, article_count: count };
  });
  
  res.json({ code: 0, data: result });
});

/**
 * GET /api/faqs/list
 * 获取FAQ列表
 * query: category_id, keyword, page, page_size
 */
router.get('/list', (req, res) => {
  const db = getDB();
  const { category_id, keyword, page = 1, page_size = 20 } = req.query;
  
  let list = db.faqs.filter(f => f.status === 'published');
  
  // 分类过滤
  if (category_id && category_id !== '0') {
    const cid = parseInt(category_id);
    list = list.filter(f => f.category_id === cid);
  }
  
  // 关键词搜索（问题 + 答案 + 标签）
  if (keyword && keyword.trim()) {
    const kw = keyword.trim().toLowerCase();
    list = list.filter(f => {
      const tags = Array.isArray(f.tags) ? f.tags.join(' ') : '';
      return f.question.toLowerCase().includes(kw) ||
             f.answer.toLowerCase().includes(kw) ||
             tags.toLowerCase().includes(kw);
    });
  }
  
  // 排序：置顶优先 → sort_order → created_at倒序
  list.sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  
  // 分页
  const total = list.length;
  const pageNum = Math.max(1, parseInt(page));
  const pageSize = Math.min(50, Math.max(1, parseInt(page_size)));
  const startIdx = (pageNum - 1) * pageSize;
  const items = list.slice(startIdx, startIdx + pageSize);
  
  // 附上分类名称
  const categories = db.faq_categories;
  const itemsWithCat = items.map(item => {
    const cat = categories.find(c => c.id === item.category_id);
    return { ...item, category_name: cat ? cat.name : '未分类' };
  });
  
  res.json({
    code: 0,
    data: {
      list: itemsWithCat,
      total,
      page: pageNum,
      page_size: pageSize,
      has_more: startIdx + pageSize < total
    }
  });
});

/**
 * GET /api/faqs/detail/:id
 * 获取FAQ详情（同时增加浏览数）
 */
router.get('/detail/:id', (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const faq = db.faqs.find(f => f.id === id && f.status === 'published');
  
  if (!faq) {
    return res.json({ code: 1, msg: 'FAQ不存在或未发布' });
  }
  
  // 增加浏览数
  faq.view_count = (faq.view_count || 0) + 1;
  save();
  
  // 附上分类信息
  const cat = db.faq_categories.find(c => c.id === faq.category_id);
  
  // 获取相关FAQ（同分类下的其他条目，最多5条）
  const related = db.faqs
    .filter(f => f.category_id === faq.category_id && f.id !== id && f.status === 'published')
    .sort((a, b) => a.sort_order - b.sort_order)
    .slice(0, 5)
    .map(f => ({ id: f.id, question: f.question }));
  
  res.json({
    code: 0,
    data: { ...faq, category_name: cat ? cat.name : '未分类', related }
  });
});

/**
 * POST /api/faqs/feedback/:id
 * 用户反馈：有用/无用
 * body: { type: 'helpful' | 'unhelpful' }
 */
router.post('/feedback/:id', (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const { type } = req.body;
  
  const faq = db.faqs.find(f => f.id === id);
  if (!faq) {
    return res.json({ code: 1, msg: 'FAQ不存在' });
  }
  
  if (type === 'helpful') {
    faq.helpful_count = (faq.helpful_count || 0) + 1;
  } else if (type === 'unhelpful') {
    faq.unhelpful_count = (faq.unhelpful_count || 0) + 1;
  }
  save();
  
  res.json({ code: 0, msg: '感谢反馈' });
});

/**
 * GET /api/faqs/hot
 * 获取热门FAQ（按浏览数排序）
 * query: limit (默认10)
 */
router.get('/hot', (req, res) => {
  const db = getDB();
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
  
  const list = db.faqs
    .filter(f => f.status === 'published')
    .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
    .slice(0, limit)
    .map(f => ({
      id: f.id,
      question: f.question,
      view_count: f.view_count || 0,
      category_id: f.category_id,
      is_pinned: f.is_pinned
    }));
  
  res.json({ code: 0, data: list });
});

/**
 * GET /api/faqs/search
 * 搜索FAQ
 * query: keyword (必填), limit (默认20)
 */
router.get('/search', (req, res) => {
  const db = getDB();
  const { keyword, limit = 20 } = req.query;
  
  if (!keyword || !keyword.trim()) {
    return res.json({ code: 0, data: [] });
  }
  
  const kw = keyword.trim().toLowerCase();
  const lim = Math.min(50, Math.max(1, parseInt(limit)));
  
  const results = db.faqs
    .filter(f => {
      if (f.status !== 'published') return false;
      const tags = Array.isArray(f.tags) ? f.tags.join(' ') : '';
      return f.question.toLowerCase().includes(kw) ||
             f.answer.toLowerCase().includes(kw) ||
             tags.toLowerCase().includes(kw);
    })
    .sort((a, b) => {
      // 置顶优先
      if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned;
      // 问题匹配优先于答案匹配
      const aQ = a.question.toLowerCase().includes(kw) ? 1 : 0;
      const bQ = b.question.toLowerCase().includes(kw) ? 1 : 0;
      if (aQ !== bQ) return bQ - aQ;
      return (b.view_count || 0) - (a.view_count || 0);
    })
    .slice(0, lim)
    .map(f => ({
      id: f.id,
      question: f.question,
      answer: f.answer.substring(0, 200),
      category_id: f.category_id,
      view_count: f.view_count || 0
    }));
  
  res.json({ code: 0, data: results });
});

// ==================== 管理端接口 ====================

/**
 * GET /api/faqs/admin/categories
 * 获取所有分类（含禁用的）
 */
router.get('/admin/categories', (req, res) => {
  const db = getDB();
  const categories = db.faq_categories.sort((a, b) => a.sort_order - b.sort_order);
  
  const result = categories.map(cat => {
    const count = db.faqs.filter(f => f.category_id === cat.id).length;
    const publishedCount = db.faqs.filter(f => f.category_id === cat.id && f.status === 'published').length;
    return { ...cat, article_count: count, published_count: publishedCount };
  });
  
  res.json({ code: 0, data: result });
});

/**
 * POST /api/faqs/admin/categories
 * 创建分类
 */
router.post('/admin/categories', (req, res) => {
  const db = getDB();
  const { name, icon = '📋', description = '', sort_order = 0, status = 'active' } = req.body;
  
  if (!name || !name.trim()) {
    return res.json({ code: 1, msg: '分类名称不能为空' });
  }
  
  // 生成ID
  const existing = db.faq_categories.map(c => c.id);
  const newId = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  
  const category = {
    id: newId,
    name: name.trim(),
    icon,
    description,
    sort_order: parseInt(sort_order) || 0,
    status,
    article_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  db.faq_categories.push(category);
  save();
  
  res.json({ code: 0, msg: '创建成功', data: category });
});

/**
 * PUT /api/faqs/admin/categories/:id
 * 更新分类
 */
router.put('/admin/categories/:id', (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const cat = db.faq_categories.find(c => c.id === id);
  
  if (!cat) {
    return res.json({ code: 1, msg: '分类不存在' });
  }
  
  const { name, icon, description, sort_order, status } = req.body;
  if (name !== undefined) cat.name = name.trim();
  if (icon !== undefined) cat.icon = icon;
  if (description !== undefined) cat.description = description;
  if (sort_order !== undefined) cat.sort_order = parseInt(sort_order) || 0;
  if (status !== undefined) cat.status = status;
  cat.updated_at = new Date().toISOString();
  
  save();
  res.json({ code: 0, msg: '更新成功', data: cat });
});

/**
 * DELETE /api/faqs/admin/categories/:id
 * 删除分类（同时删除该分类下的FAQ）
 */
router.delete('/admin/categories/:id', (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const catIdx = db.faq_categories.findIndex(c => c.id === id);
  
  if (catIdx === -1) {
    return res.json({ code: 1, msg: '分类不存在' });
  }
  
  // 删除该分类下的FAQ
  const faqsToRemove = db.faqs.filter(f => f.category_id === id);
  for (let i = faqsToRemove.length - 1; i >= 0; i--) {
    const idx = db.faqs.indexOf(faqsToRemove[i]);
    if (idx > -1) db.faqs.splice(idx, 1);
  }
  
  db.faq_categories.splice(catIdx, 1);
  save();
  
  res.json({ code: 0, msg: `已删除分类及 ${faqsToRemove.length} 条FAQ` });
});

/**
 * GET /api/faqs/admin/list
 * 管理端FAQ列表（含未发布的）
 * query: category_id, keyword, status, page, page_size
 */
router.get('/admin/list', (req, res) => {
  const db = getDB();
  const { category_id, keyword, status, page = 1, page_size = 20 } = req.query;
  
  let list = [...db.faqs];
  
  if (category_id && category_id !== '0') {
    const cid = parseInt(category_id);
    list = list.filter(f => f.category_id === cid);
  }
  
  if (status && status !== 'all') {
    list = list.filter(f => f.status === status);
  }
  
  if (keyword && keyword.trim()) {
    const kw = keyword.trim().toLowerCase();
    list = list.filter(f => f.question.toLowerCase().includes(kw) || f.answer.toLowerCase().includes(kw));
  }
  
  list.sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  
  const total = list.length;
  const pageNum = Math.max(1, parseInt(page));
  const pageSize = Math.min(50, Math.max(1, parseInt(page_size)));
  const startIdx = (pageNum - 1) * pageSize;
  const items = list.slice(startIdx, startIdx + pageSize);
  
  const categories = db.faq_categories;
  const itemsWithCat = items.map(item => {
    const cat = categories.find(c => c.id === item.category_id);
    return { ...item, category_name: cat ? cat.name : '未分类' };
  });
  
  res.json({
    code: 0,
    data: {
      list: itemsWithCat,
      total,
      page: pageNum,
      page_size: pageSize
    }
  });
});

/**
 * POST /api/faqs/admin/create
 * 创建FAQ
 */
router.post('/admin/create', (req, res) => {
  const db = getDB();
  const { category_id = 0, question, answer, answer_type = 'text', tags = [], sort_order = 0, status = 'published', is_pinned = 0 } = req.body;
  
  if (!question || !question.trim()) {
    return res.json({ code: 1, msg: '问题不能为空' });
  }
  if (!answer || !answer.trim()) {
    return res.json({ code: 1, msg: '答案不能为空' });
  }
  
  const existing = db.faqs.map(f => f.id);
  const newId = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  
  const faq = {
    id: newId,
    category_id: parseInt(category_id) || 0,
    question: question.trim(),
    answer: answer.trim(),
    answer_type,
    tags: Array.isArray(tags) ? tags : [],
    sort_order: parseInt(sort_order) || 0,
    view_count: 0,
    helpful_count: 0,
    unhelpful_count: 0,
    status,
    is_pinned: parseInt(is_pinned) || 0,
    created_by: req.body.created_by || 'admin',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  db.faqs.push(faq);
  save();
  
  res.json({ code: 0, msg: '创建成功', data: faq });
});

/**
 * PUT /api/faqs/admin/update/:id
 * 更新FAQ
 */
router.put('/admin/update/:id', (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const faq = db.faqs.find(f => f.id === id);
  
  if (!faq) {
    return res.json({ code: 1, msg: 'FAQ不存在' });
  }
  
  const { category_id, question, answer, answer_type, tags, sort_order, status, is_pinned } = req.body;
  if (category_id !== undefined) faq.category_id = parseInt(category_id) || 0;
  if (question !== undefined) faq.question = question.trim();
  if (answer !== undefined) faq.answer = answer.trim();
  if (answer_type !== undefined) faq.answer_type = answer_type;
  if (tags !== undefined) faq.tags = Array.isArray(tags) ? tags : [];
  if (sort_order !== undefined) faq.sort_order = parseInt(sort_order) || 0;
  if (status !== undefined) faq.status = status;
  if (is_pinned !== undefined) faq.is_pinned = parseInt(is_pinned) || 0;
  faq.updated_at = new Date().toISOString();
  
  save();
  res.json({ code: 0, msg: '更新成功', data: faq });
});

/**
 * DELETE /api/faqs/admin/delete/:id
 * 删除FAQ
 */
router.delete('/admin/delete/:id', (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const idx = db.faqs.findIndex(f => f.id === id);
  
  if (idx === -1) {
    return res.json({ code: 1, msg: 'FAQ不存在' });
  }
  
  db.faqs.splice(idx, 1);
  save();
  res.json({ code: 0, msg: '删除成功' });
});

/**
 * PUT /api/faqs/admin/sort
 * 批量排序
 * body: { items: [{ id, sort_order }] }
 */
router.put('/admin/sort', (req, res) => {
  const db = getDB();
  const { items } = req.body;
  
  if (!Array.isArray(items)) {
    return res.json({ code: 1, msg: '参数错误' });
  }
  
  items.forEach(({ id, sort_order }) => {
    const faq = db.faqs.find(f => f.id === parseInt(id));
    if (faq) {
      faq.sort_order = parseInt(sort_order) || 0;
    }
  });
  save();
  
  res.json({ code: 0, msg: '排序已更新' });
});

/**
 * GET /api/faqs/admin/stats
 * 管理端统计
 */
router.get('/admin/stats', (req, res) => {
  const db = getDB();
  
  const totalFaqs = db.faqs.length;
  const publishedFaqs = db.faqs.filter(f => f.status === 'published').length;
  const draftFaqs = db.faqs.filter(f => f.status === 'draft').length;
  const pinnedFaqs = db.faqs.filter(f => f.is_pinned === 1).length;
  const totalCategories = db.faq_categories.length;
  const activeCategories = db.faq_categories.filter(c => c.status === 'active').length;
  const totalViews = db.faqs.reduce((sum, f) => sum + (f.view_count || 0), 0);
  const totalHelpful = db.faqs.reduce((sum, f) => sum + (f.helpful_count || 0), 0);
  const totalUnhelpful = db.faqs.reduce((sum, f) => sum + (f.unhelpful_count || 0), 0);
  const satisfactionRate = totalHelpful + totalUnhelpful > 0
    ? Math.round(totalHelpful / (totalHelpful + totalUnhelpful) * 100)
    : 0;
  
  // 各分类条目数
  const categoryStats = db.faq_categories.map(cat => {
    const items = db.faqs.filter(f => f.category_id === cat.id);
    return {
      id: cat.id,
      name: cat.name,
      icon: cat.icon,
      total: items.length,
      published: items.filter(f => f.status === 'published').length,
      views: items.reduce((sum, f) => sum + (f.view_count || 0), 0)
    };
  });
  
  res.json({
    code: 0,
    data: {
      total_faqs: totalFaqs,
      published_faqs: publishedFaqs,
      draft_faqs: draftFaqs,
      pinned_faqs: pinnedFaqs,
      total_categories: totalCategories,
      active_categories: activeCategories,
      total_views: totalViews,
      total_helpful: totalHelpful,
      total_unhelpful: totalUnhelpful,
      satisfaction_rate: satisfactionRate,
      category_stats: categoryStats
    }
  });
});

/**
 * POST /api/faqs/admin/seed
 * 初始化默认FAQ数据
 */
router.post('/admin/seed', (req, res) => {
  const db = getDB();
  
  if (db.faq_categories.length > 0) {
    return res.json({ code: 1, msg: 'FAQ数据已存在，跳过初始化' });
  }
  
  // 创建默认分类
  const categories = [
    { id: 1, name: '平台服务', icon: '🏪', description: '关于数造工坊平台本身的使用问题', sort_order: 1 },
    { id: 2, name: '产品与方案', icon: '📦', description: '关于数字化产品和解决方案的咨询', sort_order: 2 },
    { id: 3, name: '订单与支付', icon: '💳', description: '下单、支付、退款相关', sort_order: 3 },
    { id: 4, name: '甲方入驻', icon: '🤝', description: '甲方产品入驻与合作', sort_order: 4 },
    { id: 5, name: '服务交付', icon: '🛠️', description: '项目交付进度与售后', sort_order: 5 },
    { id: 6, name: '账号与安全', icon: '🔐', description: '账号管理与隐私安全', sort_order: 6 }
  ];
  
  categories.forEach(cat => {
    cat.status = 'active';
    cat.article_count = 0;
    cat.created_at = new Date().toISOString();
    cat.updated_at = new Date().toISOString();
    db.faq_categories.push(cat);
  });
  
  // 创建默认FAQ
  const faqs = [
    // 平台服务
    { cat: 1, q: '数造工坊是什么平台？', a: '数造工坊是面向企业数字化转型的双面服务平台。A面提供我方数字化服务产品展示、政策解读与软文引流；B面展示已服务客户的产品与服务，支持购买和撮合。我们致力于让企业数字化一步到位。', tags: ['平台介绍', '数字化转型'], pinned: 1 },
    { cat: 1, q: '平台提供哪些服务？', a: '我们提供16个标准化数字化方案（涵盖CRM、ERP、OA、数据分析等），按需定制开发服务，甲方严选产品交易撮合，免费数字化成熟度诊断，以及报价计算器等工具。', tags: ['服务范围'], pinned: 0 },
    { cat: 1, q: '如何联系客服？', a: '您可以通过以下方式联系我们：\n1. 小程序内点击「联系」页面填写需求表单\n2. 点击页面右下角客服按钮接入企业微信在线客服\n3. 关注公众号「数造工坊」留言\n\n工作日 9:00-18:00 内我们会尽快响应。', tags: ['联系方式', '客服'], pinned: 0 },
    
    // 产品与方案
    { cat: 2, q: '产品方案可以定制吗？', a: '可以。我们的16个标准化方案都支持深度定制。您可以在产品详情页点击「预约演示」，我们的方案专家会与您沟通具体需求，提供定制化方案和报价。', tags: ['定制开发', '报价'], pinned: 1 },
    { cat: 2, q: '方案部署方式是什么？', a: '我们支持三种部署方式：\n1. SaaS云部署（快速上线，按年付费）\n2. 私有化部署（数据安全，一次性授权+年维护费）\n3. 混合部署（核心数据本地+非核心功能上云）\n\n具体方案可根据企业需求灵活选择。', tags: ['部署', 'SaaS', '私有化'], pinned: 0 },
    { cat: 2, q: '产品支持免费试用吗？', a: '部分SaaS类产品支持7-14天免费试用。定制类方案可预约免费演示。具体试用政策请咨询客服或查看产品详情页说明。', tags: ['试用', '演示'], pinned: 0 },
    { cat: 2, q: '如何选择适合的数字化方案？', a: '推荐三种方式：\n1. 使用小程序内的「免费诊断」功能，通过痛点速选获取推荐方案\n2. 使用「数字化成熟度评估」工具生成五维雷达图报告\n3. 使用「报价计算器」按模块组合方案\n\n也可直接联系客服，由方案专家为您一对一推荐。', tags: ['选型', '诊断', '评估'], pinned: 0 },
    
    // 订单与支付
    { cat: 3, q: '支持哪些支付方式？', a: '我们支持微信支付（JSAPI下单）。在小程序内选购甲方严选产品后，可直接通过微信支付完成付款。支付成功后订单状态自动更新，并触发服务交付流程。', tags: ['支付', '微信支付'], pinned: 0 },
    { cat: 3, q: '订单如何取消和退款？', a: '未支付订单可直接取消。已支付订单在服务开始前可申请退款：\n1. 进入「我的」→「订单」找到对应订单\n2. 点击「申请退款」并填写原因\n3. 客服审核通过后原路退回（1-3个工作日）\n\n服务已开始的项目按实际进度核算。', tags: ['退款', '取消订单'], pinned: 1 },
    { cat: 3, q: '优惠券如何使用？', a: '在下单页面会自动展示可用的优惠券列表，选择后系统自动折扣。免单场景（全额抵扣）也可使用。优惠券在「我的」→「优惠券」中管理，请注意使用期限。', tags: ['优惠券', '折扣'], pinned: 0 },
    { cat: 3, q: '可以开发票吗？', a: '可以。订单完成后，在「我的」→「订单」中找到对应订单，点击「申请发票」填写抬头信息即可。我们支持增值税普通发票和专用发票。电子发票一般1-2个工作日开具。', tags: ['发票'], pinned: 0 },
    
    // 甲方入驻
    { cat: 4, q: '如何入驻成为甲方？', a: '入驻流程：\n1. 在「我的」页面点击「企业入驻申请」\n2. 填写企业信息、产品/服务描述、联系方式\n3. 提交资质材料（营业执照等）\n4. 平台审核（1-3个工作日）\n5. 审核通过后即可上架产品\n\n入驻免费，平台收取交易额的5%作为服务费。', tags: ['入驻', '审核'], pinned: 1 },
    { cat: 4, q: '甲方产品有什么上架要求？', a: '基本要求：\n1. 合法合规的企业资质\n2. 产品/服务有明确的价格和描述\n3. 至少3张产品图片\n4. 提供售后保障说明\n\n优质产品可获得首页「甲方严选」推荐位。', tags: ['上架', '产品'], pinned: 0 },
    { cat: 4, q: '甲方产品的结算周期是多久？', a: 'T+7结算。订单完成且客户确认验收后7个工作日内，平台将扣除服务费后的款项打入甲方账户。支持对公转账和微信商户号结算。', tags: ['结算', '打款'], pinned: 0 },
    
    // 服务交付
    { cat: 5, q: '如何查看服务交付进度？', a: '在「我的」→「服务进度」中可查看所有订单的交付里程碑。系统会自动跟踪需求确认→方案设计→开发实施→测试验收→上线培训五个阶段，每个阶段完成后自动推送通知。', tags: ['交付', '进度', '里程碑'], pinned: 1 },
    { cat: 5, q: '服务周期一般多长？', a: '取决于方案复杂度：\n1. 标准SaaS产品：1-3个工作日开通\n2. 轻量定制：2-4周\n3. 深度定制开发：1-3个月\n4. 企业级全套数字化：3-6个月\n\n具体周期在方案确认后写入合同。', tags: ['周期', '时间'], pinned: 0 },
    { cat: 5, q: '提供售后技术支持吗？', a: '提供。所有方案均含：\n1. 免费维护期：上线后3个月免费Bug修复\n2. 技术支持：工作日9-18小时响应\n3. 系统升级：SaaS产品持续免费升级\n4. 培训服务：含2次免费团队培训\n\n延保服务可额外购买。', tags: ['售后', '维护', '培训'], pinned: 0 },
    
    // 账号与安全
    { cat: 6, q: '如何保护我的隐私数据？', a: '我们严格遵守《隐私保护协议》：\n1. 仅收集必要的业务信息\n2. 数据加密存储，不向第三方泄露\n3. 您可在「我的」中查看和导出个人数据\n4. 支持账号注销和数据删除\n\n详见小程序内的《隐私保护协议》。', tags: ['隐私', '数据安全'], pinned: 0 },
    { cat: 6, q: '忘记密码怎么办？', a: '小程序使用微信授权登录，无需单独设置密码。管理后台如忘记密码，请联系平台管理员重置。', tags: ['密码', '登录'], pinned: 0 },
    { cat: 6, q: '如何修改企业信息？', a: '在「我的」→「企业资料」中可修改企业名称、联系人、电话等信息。企业名称变更需重新提交营业执照审核。', tags: ['企业信息', '修改'], pinned: 0 }
  ];
  
  let faqId = 1;
  faqs.forEach(f => {
    const faq = {
      id: faqId++,
      category_id: f.cat,
      question: f.q,
      answer: f.a,
      answer_type: 'text',
      tags: f.tags,
      sort_order: 0,
      view_count: 0,
      helpful_count: 0,
      unhelpful_count: 0,
      status: 'published',
      is_pinned: f.pinned,
      created_by: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.faqs.push(faq);
  });
  
  save();
  
  res.json({
    code: 0,
    msg: `初始化完成：${categories.length}个分类，${faqs.length}条FAQ`,
    data: { categories: categories.length, faqs: faqs.length }
  });
});

module.exports = router;
