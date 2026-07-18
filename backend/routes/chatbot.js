/**
 * 智能客服机器人 API
 * 
 * 提供自动问答、关键词匹配、产品推荐、转人工等功能：
 * - 智能匹配FAQ知识库
 * - 产品关键词识别与推荐
 * - 多轮对话上下文
 * - 人工客服转接
 * - 会话评分反馈
 */

const express = require('express');
const router = express.Router();
const { getDB, save, nextId, syncRow } = require('../models/db');

// ==================== 配置 ====================

// 机器人默认知识库（FAQ和产品信息之外的关键词匹配规则）
const DEFAULT_BOT_KNOWLEDGE = [
  // 问候语
  { keywords: ['你好', '您好', '在吗', '有人吗', 'hi', 'hello'], 
    answer: '您好！我是数造工坊智能客服，很高兴为您服务~ 请问有什么可以帮您？', 
    type: 'greeting',
    suggestions: ['产品咨询', '价格咨询', '售后服务', '转人工客服'] },
  
  { keywords: ['谢谢', '感谢', '多谢', 'thanks'], 
    answer: '不客气！很高兴能帮到您。如有其他问题，随时可以问我哦~', 
    type: 'thanks' },
  
  // 公司介绍
  { keywords: ['数造工坊', '公司介绍', '你们公司', '关于我们'], 
    answer: '数造工坊是一家专注企业数字化转型的服务平台，我们提供：\n\n✅ 16+数字化产品方案\n✅ 行业定制解决方案\n✅ 从咨询到落地一站式服务\n✅ 已服务100+企业客户\n\n有任何需求都可以告诉我！', 
    type: 'intro',
    suggestions: ['查看产品', '免费咨询', '成功案例'] },
  
  // 联系方式
  { keywords: ['联系', '电话', '客服电话', '怎么联系', '联系方式'], 
    answer: '您可以通过以下方式联系我们：\n\n📞 咨询热线：400-888-8888\n📧 邮箱：service@shuzao.com\n📍 地址：济南市高新区\n⏰ 工作时间：周一至周五 9:00-18:00\n\n也可以直接在这里留言，我们会尽快回复！', 
    type: 'contact',
    suggestions: ['在线留言', '预约咨询', '转人工客服'] },
  
  // 价格
  { keywords: ['价格', '多少钱', '费用', '报价', '收费', '怎么卖'], 
    answer: '我们的产品价格根据具体需求和规模定制，一般范围：\n\n💰 基础版：9,800元起\n💰 标准版：29,800元起\n💰 专业版：59,800元起\n💰 企业版：定制报价\n\n您可以告诉我具体需求，我帮您推荐合适的方案！', 
    type: 'pricing',
    suggestions: ['获取报价', '预约演示', '产品对比'] },
  
  // 服务流程
  { keywords: ['流程', '怎么合作', '合作方式', '服务流程', '怎么做'], 
    answer: '我们的服务流程很简单：\n\n1️⃣ 需求沟通 → 了解您的痛点\n2️⃣ 方案定制 → 量身设计解决方案\n3️⃣ 签约合作 → 明确权责和进度\n4️⃣ 项目实施 → 敏捷开发交付\n5️⃣ 培训上线 → 手把手教会使用\n6️⃣ 售后维护 → 持续技术支持\n\n现在可以预约免费咨询哦！', 
    type: 'process',
    suggestions: ['预约咨询', '查看案例', '产品介绍'] },
  
  // 售后
  { keywords: ['售后', '维护', '技术支持', '问题', '故障', 'bug'], 
    answer: '我们提供完善的售后服务：\n\n✅ 7×24小时在线客服\n✅ 工单系统快速响应\n✅ 定期巡检和维护\n✅ 系统升级支持\n✅ 操作培训服务\n\n如需技术支持，可以提交工单或转人工客服处理~', 
    type: 'support',
    suggestions: ['提交工单', '转人工客服', '查看帮助'] },
  
  // 退款
  { keywords: ['退款', '退货', '退订', '取消'], 
    answer: '关于退款/退货，我们的政策是：\n\n📌 未开始服务：可全额退款\n📌 服务中：按进度比例退款\n📌 已完成服务：不支持退款\n\n具体请查看用户服务协议或联系人工客服处理。', 
    type: 'refund',
    suggestions: ['查看订单', '转人工客服', '服务协议'] },
  
  // 发票
  { keywords: ['发票', '开票', 'fapiao'], 
    answer: '我们可以为您开具正规发票：\n\n📄 增值税普通发票\n📄 增值税专用发票\n\n开票信息：\n- 抬头\n- 税号\n- 地址电话\n- 开户行账号\n\n请在订单页面申请开票，或联系客服处理~', 
    type: 'invoice',
    suggestions: ['申请发票', '查看订单', '转人工客服'] },
  
  // 示例案例
  { keywords: ['案例', '成功案例', '客户案例', '有没有做过'], 
    answer: '我们已服务100+企业客户，涵盖多个行业：\n\n🏭 制造业：某汽车零部件企业ERP系统\n🏪 零售业：某连锁超市会员管理系统\n🏥 医疗：某医院数字化管理系统\n🏫 教育：某培训学校CRM系统\n🏢 企业服务：某园区管理平台\n\n您可以查看「甲方严选」了解更多~', 
    type: 'cases',
    suggestions: ['查看甲方严选', '行业解决方案', '免费咨询'] },
  
  // 转人工
  { keywords: ['人工', '真人', '转人工', '人工客服', '转接'], 
    answer: '好的，正在为您转接人工客服...\n\n⏳ 预计等待时间：1-3分钟\n\n人工客服工作时间：\n周一至周五 9:00-18:00\n\n非工作时间请留言，我们会尽快回复！', 
    type: 'transfer',
    action: 'transfer_human' },
  
  // 默认回复
  { keywords: [], 
    answer: '抱歉，我没有完全理解您的问题。\n\n您可以尝试：\n✅ 描述更具体一些\n✅ 选择下方快捷问题\n✅ 转人工客服咨询', 
    type: 'fallback',
    suggestions: ['产品咨询', '价格咨询', '转人工客服'] }
];

// ==================== 工具函数 ====================

/**
 * 计算关键词匹配分数
 */
function matchScore(text, keywords) {
  if (!keywords || keywords.length === 0) return 0;
  const lowerText = text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lowerText.includes(kw.toLowerCase())) {
      score += kw.length; // 关键词越长权重越高
    }
  }
  return score;
}

/**
 * 从FAQ库中匹配答案
 */
function matchFAQ(db, text) {
  if (!db.faqs || db.faqs.length === 0) return null;
  
  const lowerText = text.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;
  
  for (const faq of db.faqs) {
    if (faq.status !== 'published') continue;
    
    // 检查问题匹配
    const questionScore = matchScore(text, [faq.question]);
    // 检查标签匹配
    const tags = faq.tags || [];
    const tagScore = matchScore(text, tags);
    
    const totalScore = questionScore + tagScore * 2;
    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestMatch = faq;
    }
  }
  
  return bestScore >= 3 ? bestMatch : null;
}

/**
 * 从产品库中匹配产品
 */
function matchProducts(db, text) {
  if (!db.products || db.products.length === 0) return [];
  
  const lowerText = text.toLowerCase();
  const matched = [];
  
  for (const product of db.products) {
    let score = 0;
    // 标题匹配
    if (lowerText.includes(product.title?.toLowerCase())) score += 10;
    // 标签匹配
    const tags = product.tags || [];
    for (const tag of tags) {
      if (lowerText.includes(tag.toLowerCase())) score += 5;
    }
    // 痛点匹配
    const painPoints = product.pain_points || [];
    for (const pp of painPoints) {
      if (lowerText.includes(pp.toLowerCase())) score += 3;
    }
    
    if (score > 0) {
      matched.push({ ...product, matchScore: score });
    }
  }
  
  // 按分数排序
  return matched.sort((a, b) => b.matchScore - a.matchScore).slice(0, 3);
}

/**
 * 从甲方产品库中匹配
 */
function matchClientProducts(db, text) {
  if (!db.client_products || db.client_products.length === 0) return [];
  
  const lowerText = text.toLowerCase();
  const matched = [];
  
  for (const cp of db.client_products) {
    let score = 0;
    if (lowerText.includes(cp.title?.toLowerCase())) score += 10;
    if (lowerText.includes(cp.category?.toLowerCase())) score += 5;
    
    if (score > 0) {
      matched.push({ ...cp, matchScore: score });
    }
  }
  
  return matched.sort((a, b) => b.matchScore - a.matchScore).slice(0, 3);
}

// ==================== API 接口 ====================

/**
 * POST /api/chatbot/chat
 * 智能对话接口
 */
router.post('/chat', (req, res) => {
  const { openid, message, session_id } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: '消息不能为空' });
  }
  
  const db = getDB();
  const userMessage = message.trim();
  
  // 初始化表
  if (!db.chatbot_sessions) db.chatbot_sessions = [];
  if (!db.chatbot_messages) db.chatbot_messages = [];
  if (!db.chatbot_stats) db.chatbot_stats = { total_sessions: 0, total_messages: 0, helpful_count: 0, unhelpful_count: 0 };
  
  // 获取或创建会话
  let session = null;
  if (session_id) {
    session = db.chatbot_sessions.find(s => s.id === session_id);
  }
  if (!session && openid) {
    session = db.chatbot_sessions.find(s => s.openid === openid && s.status === 'active');
  }
  if (!session) {
    session = {
      id: nextId('chatbot_sessions'),
      openid: openid || null,
      status: 'active',
      message_count: 0,
      transfer_requested: 0,
      rating: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.chatbot_sessions.push(session);
    db.chatbot_stats.total_sessions++;
  }
  
  // 记录用户消息
  const userMsg = {
    id: nextId('chatbot_messages'),
    session_id: session.id,
    role: 'user',
    content: userMessage,
    created_at: new Date().toISOString()
  };
  db.chatbot_messages.push(userMsg);
  session.message_count++;
  session.updated_at = new Date().toISOString();
  syncRow('chatbot_sessions', session);
  
  // ========== 智能匹配逻辑 ==========
  
  let botReply = {
    content: '',
    type: 'text',
    matched_faq: null,
    matched_products: [],
    matched_client_products: [],
    suggestions: [],
    action: null
  };
  
  // 1. 先匹配内置知识库
  let bestMatch = null;
  let bestScore = 0;
  
  for (const knowledge of DEFAULT_BOT_KNOWLEDGE) {
    const score = matchScore(userMessage, knowledge.keywords);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = knowledge;
    }
  }
  
  // 2. 匹配FAQ库
  const faqMatch = matchFAQ(db, userMessage);
  
  // 3. 匹配产品
  const productMatches = matchProducts(db, userMessage);
  
  // 4. 匹配甲方产品
  const clientProductMatches = matchClientProducts(db, userMessage);
  
  // ========== 构建回复 ==========
  
  // 如果内置知识库匹配度很高（score>=8），优先用内置知识库（处理转人工等特殊意图）
  if (bestMatch && bestScore >= 8 && bestMatch.action) {
    botReply.content = bestMatch.answer;
    botReply.type = bestMatch.type || 'text';
    botReply.suggestions = bestMatch.suggestions || [];
    botReply.action = bestMatch.action || null;
    
    if (bestMatch.action === 'transfer_human') {
      session.transfer_requested = 1;
      syncRow('chatbot_sessions', session);
      botReply.content = '好的，正在为您转接人工客服...\n\n⏳ 预计等待时间：1-3分钟\n\n人工客服工作时间：周一至周五 9:00-18:00\n\n非工作时间请留言，我们会尽快回复！';
    }
  }
  // 如果FAQ匹配度高，使用FAQ答案
  else if (faqMatch && faqMatch.question.length >= 4) {
    botReply.content = faqMatch.answer;
    botReply.matched_faq = { id: faqMatch.id, question: faqMatch.question };
    botReply.suggestions = ['查看相关产品', '转人工客服', '其他问题'];
  }
  // 如果有产品匹配
  else if (productMatches.length > 0 && bestScore < 10) {
    botReply.type = 'product_recommend';
    botReply.matched_products = productMatches.map(p => ({
      id: p.id,
      title: p.title,
      price: p.price,
      image: p.image
    }));
    botReply.content = `为您找到 ${productMatches.length} 个相关产品：\n\n${productMatches.map((p, i) => 
      `${i + 1}. ${p.title}\n   💰 ${p.price || '询价'}`
    ).join('\n\n')}\n\n点击查看详情，或继续咨询~`;
    botReply.suggestions = ['获取报价', '预约演示', '转人工客服'];
  }
  // 使用内置知识库
  else if (bestMatch && bestScore > 0) {
    botReply.content = bestMatch.answer;
    botReply.type = bestMatch.type || 'text';
    botReply.suggestions = bestMatch.suggestions || [];
    botReply.action = bestMatch.action || null;
    
    // 如果是转人工
    if (bestMatch.action === 'transfer_human') {
      session.transfer_requested = 1;
      syncRow('chatbot_sessions', session);
      botReply.content = '好的，正在为您转接人工客服...\n\n⏳ 预计等待时间：1-3分钟\n\n人工客服工作时间：周一至周五 9:00-18:00\n\n非工作时间请留言，我们会尽快回复！';
    }
  }
  // 默认回复
  else {
    const fallback = DEFAULT_BOT_KNOWLEDGE.find(k => k.type === 'fallback');
    botReply.content = fallback.answer;
    botReply.suggestions = fallback.suggestions;
  }
  
  // 记录机器人回复
  const botMsg = {
    id: nextId('chatbot_messages'),
    session_id: session.id,
    role: 'bot',
    content: botReply.content,
    type: botReply.type,
    matched_faq: botReply.matched_faq,
    matched_products: botReply.matched_products,
    suggestions: botReply.suggestions,
    action: botReply.action,
    helpful: null,
    created_at: new Date().toISOString()
  };
  db.chatbot_messages.push(botMsg);
  
  // 更新统计
  db.chatbot_stats.total_messages += 2;
  
  save();
  
  res.json({
    success: true,
    data: {
      session_id: session.id,
      message: { ...botReply, id: botMsg.id },
      transfer_requested: session.transfer_requested
    }
  });
});

/**
 * POST /api/chatbot/feedback
 * 消息反馈（有用/无用）
 */
router.post('/feedback', (req, res) => {
  const { message_id, helpful, comment } = req.body;
  if (!message_id) {
    return res.status(400).json({ error: '缺少 message_id' });
  }
  
  const db = getDB();
  const msg = db.chatbot_messages?.find(m => m.id === message_id);
  
  if (!msg) {
    return res.status(404).json({ error: '消息不存在' });
  }
  
  msg.helpful = helpful ? 1 : 0;
  if (comment) msg.feedback_comment = comment;
  msg.feedback_at = new Date().toISOString();
  syncRow('chatbot_messages', msg);
  
  // 更新统计
  if (!db.chatbot_stats) db.chatbot_stats = { total_sessions: 0, total_messages: 0, helpful_count: 0, unhelpful_count: 0 };
  if (helpful) {
    db.chatbot_stats.helpful_count++;
  } else {
    db.chatbot_stats.unhelpful_count++;
  }
  
  // 如果是FAQ，也更新FAQ的反馈
  if (msg.matched_faq?.id) {
    const faq = db.faqs?.find(f => f.id === msg.matched_faq.id);
    if (faq) {
      if (helpful) faq.helpful_count = (faq.helpful_count || 0) + 1;
      else faq.unhelpful_count = (faq.unhelpful_count || 0) + 1;
      syncRow('faqs', faq);
    }
  }
  
  save();
  
  res.json({ success: true, message: '感谢您的反馈！' });
});

/**
 * POST /api/chatbot/rate-session
 * 会话评分
 */
router.post('/rate-session', (req, res) => {
  const { session_id, rating, comment } = req.body;
  if (!session_id || !rating) {
    return res.status(400).json({ error: '缺少 session_id 或 rating' });
  }
  
  const db = getDB();
  const session = db.chatbot_sessions?.find(s => s.id === session_id);
  
  if (!session) {
    return res.status(404).json({ error: '会话不存在' });
  }
  
  session.rating = rating;
  if (comment) session.rating_comment = comment;
  session.rated_at = new Date().toISOString();
  session.status = 'closed';
  syncRow('chatbot_sessions', session);
  
  save();
  
  res.json({ success: true, message: '感谢您的评价！' });
});

/**
 * GET /api/chatbot/history
 * 获取会话历史
 */
router.get('/history', (req, res) => {
  const { openid, session_id, limit = 50 } = req.query;
  
  const db = getDB();
  
  if (session_id) {
    // 获取指定会话的消息
    const messages = (db.chatbot_messages || [])
      .filter(m => m.session_id == session_id)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return res.json({ success: true, data: messages });
  }
  
  if (openid) {
    // 获取用户的所有会话
    const sessions = (db.chatbot_sessions || [])
      .filter(s => s.openid === openid)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10);
    
    // 为每个会话附上最后一条消息
    const result = sessions.map(session => {
      const messages = (db.chatbot_messages || [])
        .filter(m => m.session_id === session.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return {
        ...session,
        last_message: messages[0]?.content?.substring(0, 100),
        messages: messages.slice(-20) // 最近20条
      };
    });
    
    return res.json({ success: true, data: result });
  }
  
  res.status(400).json({ error: '缺少 openid 或 session_id' });
});

/**
 * GET /api/chatbot/quick-questions
 * 获取快捷问题列表
 */
router.get('/quick-questions', (req, res) => {
  const questions = [
    { text: '产品咨询', icon: '📦' },
    { text: '价格咨询', icon: '💰' },
    { text: '成功案例', icon: '🏆' },
    { text: '售后服务', icon: '🛠️' },
    { text: '联系人工', icon: '👤' }
  ];
  
  res.json({ success: true, data: questions });
});

// ==================== 管理端接口 ====================

/**
 * GET /api/chatbot/admin/stats
 * 获取机器人统计
 */
router.get('/admin/stats', (req, res) => {
  const db = getDB();
  
  const sessions = db.chatbot_sessions || [];
  const messages = db.chatbot_messages || [];
  const stats = db.chatbot_stats || { total_sessions: 0, total_messages: 0, helpful_count: 0, unhelpful_count: 0 };
  
  // 今日统计
  const today = new Date().toISOString().split('T')[0];
  const todaySessions = sessions.filter(s => s.created_at?.startsWith(today));
  const todayMessages = messages.filter(m => m.created_at?.startsWith(today));
  
  // 转人工率
  const transferRate = sessions.length > 0 
    ? (sessions.filter(s => s.transfer_requested).length / sessions.length * 100).toFixed(1)
    : 0;
  
  // 满意度
  const ratedSessions = sessions.filter(s => s.rating);
  const avgRating = ratedSessions.length > 0
    ? (ratedSessions.reduce((sum, s) => sum + (s.rating || 0), 0) / ratedSessions.length).toFixed(1)
    : 0;
  
  // 有用率
  const helpfulRate = stats.helpful_count + stats.unhelpful_count > 0
    ? (stats.helpful_count / (stats.helpful_count + stats.unhelpful_count) * 100).toFixed(1)
    : 0;
  
  // 7天趋势
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    last7Days.push({
      date,
      sessions: sessions.filter(s => s.created_at?.startsWith(date)).length,
      messages: messages.filter(m => m.created_at?.startsWith(date)).length
    });
  }
  
  res.json({
    success: true,
    data: {
      overview: {
        total_sessions: sessions.length,
        total_messages: messages.length,
        today_sessions: todaySessions.length,
        today_messages: todayMessages.length,
        transfer_rate: transferRate + '%',
        avg_rating: avgRating,
        helpful_rate: helpfulRate + '%'
      },
      trend_7days: last7Days,
      helpful_stats: {
        helpful: stats.helpful_count || 0,
        unhelpful: stats.unhelpful_count || 0
      }
    }
  });
});

/**
 * GET /api/chatbot/admin/sessions
 * 获取会话列表
 */
router.get('/admin/sessions', (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const db = getDB();
  
  let sessions = db.chatbot_sessions || [];
  
  if (status) {
    sessions = sessions.filter(s => s.status === status);
  }
  
  sessions = sessions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  const total = sessions.length;
  const list = sessions.slice((page - 1) * limit, page * limit).map(session => {
    const messages = (db.chatbot_messages || []).filter(m => m.session_id === session.id);
    return {
      ...session,
      message_count: messages.length,
      last_message: messages[messages.length - 1]?.content?.substring(0, 50)
    };
  });
  
  res.json({ success: true, data: { list, total, page: +page, limit: +limit } });
});

/**
 * GET /api/chatbot/admin/sessions/:id/messages
 * 获取会话详情（消息列表）
 */
router.get('/admin/sessions/:id/messages', (req, res) => {
  const { id } = req.params;
  const db = getDB();
  
  const messages = (db.chatbot_messages || [])
    .filter(m => m.session_id == id)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  
  res.json({ success: true, data: messages });
});

/**
 * GET /api/chatbot/admin/knowledge
 * 获取机器人知识库
 */
router.get('/admin/knowledge', (req, res) => {
  res.json({ success: true, data: DEFAULT_BOT_KNOWLEDGE });
});

/**
 * POST /api/chatbot/admin/takeover
 * 人工接管会话
 */
router.post('/admin/takeover', (req, res) => {
  const { session_id, admin_message } = req.body;
  if (!session_id) {
    return res.status(400).json({ error: '缺少 session_id' });
  }
  
  const db = getDB();
  const session = db.chatbot_sessions?.find(s => s.id === session_id);
  
  if (!session) {
    return res.status(404).json({ error: '会话不存在' });
  }
  
  session.status = 'taken_over';
  session.taken_over_at = new Date().toISOString();
  syncRow('chatbot_sessions', session);
  
  // 如果有管理员消息，记录下来
  if (admin_message) {
    const msg = {
      id: nextId('chatbot_messages'),
      session_id: session.id,
      role: 'admin',
      content: admin_message,
      created_at: new Date().toISOString()
    };
    if (!db.chatbot_messages) db.chatbot_messages = [];
    db.chatbot_messages.push(msg);
  }
  
  save();
  
  res.json({ success: true, message: '已接管会话' });
});

module.exports = router;
