const { getDB } = require('../models/db');
const router = require('express').Router();

// ==================== 全视角运营监控 API ====================

// 1. 总览指标
router.get('/overview', (req, res) => {
  const db = getDB();
  
  const orders = db.orders || [];
  const products = db.products || [];
  const agents = (db.agents || []).filter(a => a.status === 'active');
  const leads = db.agent_leads || [];
  const commissions = db.agent_commissions || [];
  const contracts = db.contracts || [];
  const tickets = db.tickets || [];
  const reviews = db.reviews || [];
  const contacts = db.contacts || [];
  const crmCustomers = db.crm_customers || [];
  const crmLeads = db.crm_leads || [];
  const crmProjects = db.crm_projects || [];
  const campaigns = db.campaigns || [];
  const partners = db.partners || [];
  const chatbotSessions = db.chatbot_sessions || [];
  const chatbotMessages = db.chatbot_messages || [];
  const users = db.users || [];
  const clients = db.clients || [];
  const enterpriseServices = db.enterprise_services || [];
  const serviceProviders = db.service_providers || [];
  const serviceMatches = db.service_matches || [];
  const refunds = db.order_refunds || [];
  const assessments = db.assessments || [];
  const articles = db.articles || [];
  const banners = db.banners || [];
  const faqs = db.faqs || [];
  
  // 订单金额
  const totalRevenue = orders.filter(o => o.status === 'completed').reduce((s,o) => s + (o.amount||0), 0);
  const pendingRevenue = orders.filter(o => o.status === 'processing' || o.status === 'paid').reduce((s,o) => s + (o.amount||0), 0);
  const refundAmount = orders.filter(o => o.status === 'refunded').reduce((s,o) => s + (o.amount||0), 0);
  
  // 代理商转化
  const convertedLeads = leads.filter(l => l.status === 'converted').length;
  const conversionRate = leads.length ? (convertedLeads / leads.length * 100).toFixed(1) : 0;
  
  // 合同
  const activeContracts = contracts.filter(c => c.status === 'active' || c.status === 'signed').length;
  const contractAmount = contracts.reduce((s,c) => s + (c.amount||0), 0);
  
  // 评价
  const avgRating = reviews.length ? (reviews.reduce((s,r) => s + (r.rating||0), 0) / reviews.length).toFixed(1) : 0;
  
  // 工单
  const openTickets = tickets.filter(t => t.status === 'open' || t.status === 'pending').length;
  
  // Chatbot
  const activeChatbotSessions = chatbotSessions.filter(s => s.status === 'active').length;
  
  res.json({
    // 交易监控
    transaction: {
      totalOrders: orders.length,
      completedOrders: orders.filter(o => o.status === 'completed').length,
      processingOrders: orders.filter(o => o.status === 'processing').length,
      paidOrders: orders.filter(o => o.status === 'paid').length,
      cancelledOrders: orders.filter(o => o.status === 'cancelled').length,
      refundedOrders: orders.filter(o => o.status === 'refunded').length,
      totalRevenue,
      pendingRevenue,
      refundAmount,
      refundRate: orders.length ? (orders.filter(o => o.status === 'refunded').length / orders.length * 100).toFixed(1) : 0,
      avgOrderValue: orders.length ? (totalRevenue / Math.max(orders.filter(o => o.status === 'completed').length, 1)).toFixed(0) : 0,
    },
    // 代理商
    agent: {
      total: agents.length,
      totalLeads: leads.length,
      convertedLeads,
      conversionRate,
      totalCommission: commissions.filter(c => c.status === 'paid').reduce((s,c) => s + (c.commission_amount||0), 0),
      frozenCommission: commissions.filter(c => c.status === 'frozen').reduce((s,c) => s + (c.commission_amount||0), 0),
    },
    // 合同
    contract: {
      total: contracts.length,
      active: activeContracts,
      totalAmount: contractAmount,
    },
    // 产品
    product: {
      total: products.length,
      active: products.filter(p => p.status === 'active').length,
    },
    // 客户
    customer: {
      total: crmCustomers.length,
      leads: crmLeads.length,
      projects: crmProjects.length,
      contacts: contacts.length,
      wechatUsers: users.length,
      clients: clients.length,
      enterpriseServices: enterpriseServices.length,
      activeServices: enterpriseServices.filter(s => s.status === 'active').length,
    },
    // 服务
    service: {
      providers: serviceProviders.length,
      matches: serviceMatches.length,
      pendingMatches: serviceMatches.filter(m => m.status === 'pending').length,
      openTickets,
      totalTickets: tickets.length,
    },
    // 评价
    review: {
      total: reviews.length,
      avgRating,
      fiveStar: reviews.filter(r => r.rating === 5).length,
      fourStar: reviews.filter(r => r.rating === 4).length,
      threeStar: reviews.filter(r => r.rating === 3).length,
      belowThree: reviews.filter(r => r.rating < 3).length,
    },
    // 营销
    marketing: {
      campaigns: campaigns.length,
      activeCampaigns: campaigns.filter(c => c.status === 'active').length,
      banners: banners.length,
      partners: partners.length,
      articles: articles.length,
    },
    // AI/chatbot
    ai: {
      chatbotSessions: chatbotSessions.length,
      activeSessions: activeChatbotSessions,
      chatbotMessages: chatbotMessages.length,
      faqs: faqs.length,
      diagnoses: assessments.length,
    },
    // 数字化评估
    assessment: {
      total: assessments.length,
      completed: assessments.filter(a => a.status === 'completed').length,
    },
  });
});

// 2. 角色使用监控
router.get('/role-usage', (req, res) => {
  const db = getDB();
  const auditLogs = db.audit_logs || [];
  const operationLogs = db.operation_logs || [];
  const admins = db.admins || [];
  const roles = db.roles || [];
  
  // 按 actor 统计操作次数
  const actorStats = {};
  auditLogs.forEach(log => {
    const key = log.actor_name || log.actor_id || 'system';
    if (!actorStats[key]) actorStats[key] = { count: 0, actions: {}, lastActive: null };
    actorStats[key].count++;
    actorStats[key].actions[log.action] = (actorStats[key].actions[log.action] || 0) + 1;
    if (!actorStats[key].lastActive || log.created_at > actorStats[key].lastActive) {
      actorStats[key].lastActive = log.created_at;
    }
  });
  
  // 按角色聚合
  const roleStats = {};
  admins.forEach(admin => {
    const role = roles.find(r => r.id === admin.role_id);
    const roleName = role ? role.name : '未知';
    if (!roleStats[roleName]) {
      roleStats[roleName] = { 
        role_id: admin.role_id,
        users: 0, 
        operations: 0, 
        permissions: role ? (()=>{ try { return JSON.parse(role.permissions || '[]') } catch { return [] } })() : [],
        members: []
      };
    }
    roleStats[roleName].users++;
    roleStats[roleName].members.push(admin.username);
    
    const adminOps = actorStats[admin.username];
    if (adminOps) {
      roleStats[roleName].operations += adminOps.count;
    }
  });
  
  // operation_logs 按角色统计
  operationLogs.forEach(log => {
    const role = log.actor_role || '未知';
    if (!roleStats[role]) {
      roleStats[role] = { role_id: 0, users: 0, operations: 0, permissions: [], members: [] };
    }
    roleStats[role].operations++;
  });
  
  // 按 action 类型统计
  const actionStats = {};
  auditLogs.forEach(log => {
    const action = log.action || 'unknown';
    actionStats[action] = (actionStats[action] || 0) + 1;
  });
  
  // 按模块统计（从 operation_logs）
  const moduleStats = {};
  operationLogs.forEach(log => {
    const mod = log.module || 'unknown';
    moduleStats[mod] = (moduleStats[mod] || 0) + 1;
  });
  
  // 按 severity 统计
  const severityStats = {};
  auditLogs.forEach(log => {
    const sev = log.severity || 'info';
    severityStats[sev] = (severityStats[sev] || 0) + 1;
  });
  
  res.json({
    roles: Object.entries(roleStats).map(([name, data]) => ({
      name,
      ...data,
      avgOpsPerUser: data.users ? Math.round(data.operations / data.users) : 0,
    })).sort((a,b) => b.operations - a.operations),
    topActors: Object.entries(actorStats)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a,b) => b.count - a.count)
      .slice(0, 10),
    actionStats: Object.entries(actionStats)
      .map(([action, count]) => ({ action, count }))
      .sort((a,b) => b.count - a.count),
    moduleStats: Object.entries(moduleStats)
      .map(([module, count]) => ({ module, count }))
      .sort((a,b) => b.count - a.count),
    severityStats,
    totalLogs: auditLogs.length,
    totalOperationLogs: operationLogs.length,
  });
});

// 3. 功能使用监控
router.get('/feature-usage', (req, res) => {
  const db = getDB();
  const operationLogs = db.operation_logs || [];
  const userEvents = db.user_events || [];
  const auditLogs = db.audit_logs || [];
  const chatbotSessions = db.chatbot_sessions || [];
  const chatbotMessages = db.chatbot_messages || [];
  
  // 功能模块使用频次（从 operation_logs.module）
  const moduleUsage = {};
  operationLogs.forEach(log => {
    const mod = log.module || '未分类';
    if (!moduleUsage[mod]) moduleUsage[mod] = { count: 0, lastUsed: null, users: new Set() };
    moduleUsage[mod].count++;
    if (!moduleUsage[mod].lastUsed || log.created_at > moduleUsage[mod].lastUsed) {
      moduleUsage[mod].lastUsed = log.created_at;
    }
    if (log.actor_name) moduleUsage[mod].users.add(log.actor_name);
  });
  
  // H5 用户行为
  const eventTypes = {};
  userEvents.forEach(e => {
    const t = e.event_type || 'unknown';
    eventTypes[t] = (eventTypes[t] || 0) + 1;
  });
  
  // 页面访问热度
  const pageViews = {};
  userEvents.filter(e => e.event_type === 'page_view').forEach(e => {
    const p = e.page_path || 'unknown';
    pageViews[p] = (pageViews[p] || 0) + 1;
  });
  
  // API 调用频次（从 audit_logs.request_path）
  const apiCalls = {};
  auditLogs.forEach(log => {
    const path = log.request_path || '';
    if (path) {
      // 简化路径：取前 2 段
      const parts = path.split('/').slice(0, 4).join('/');
      apiCalls[parts] = (apiCalls[parts] || 0) + 1;
    }
  });
  
  // Chatbot 问答热度
  const chatbotTopics = {};
  chatbotMessages.forEach(m => {
    if (m.sender === 'user' && m.content) {
      const keyword = m.content.substring(0, 20);
      chatbotTopics[keyword] = (chatbotTopics[keyword] || 0) + 1;
    }
  });
  
  res.json({
    moduleUsage: Object.entries(moduleUsage)
      .map(([mod, data]) => ({ module: mod, count: data.count, lastUsed: data.lastUsed, uniqueUsers: data.users.size }))
      .sort((a,b) => b.count - a.count),
    h5Events: Object.entries(eventTypes)
      .map(([type, count]) => ({ type, count }))
      .sort((a,b) => b.count - a.count),
    pageViews: Object.entries(pageViews)
      .map(([page, count]) => ({ page, count }))
      .sort((a,b) => b.count - a.count)
      .slice(0, 20),
    apiCalls: Object.entries(apiCalls)
      .map(([path, count]) => ({ path, count }))
      .sort((a,b) => b.count - a.count)
      .slice(0, 20),
    chatbotTopics: Object.entries(chatbotTopics)
      .map(([topic, count]) => ({ topic, count }))
      .sort((a,b) => b.count - a.count)
      .slice(0, 10),
    chatbotTotalMessages: chatbotMessages.length,
    chatbotActiveSessions: chatbotSessions.filter(s => s.status === 'active').length,
  });
});

// 4. 流程监控
router.get('/process-flow', (req, res) => {
  const db = getDB();
  const orders = db.orders || [];
  const leads = db.agent_leads || [];
  const contracts = db.contracts || [];
  const onboardings = db.onboardings || [];
  const deliveries = db.delivery_tracking || [];
  const tickets = db.tickets || [];
  const assessments = db.assessments || [];
  const serviceMatches = db.service_matches || [];
  
  // 订单流程漏斗
  const orderFlow = {
    placed: orders.length,
    paid: orders.filter(o => ['paid','processing','completed'].includes(o.status)).length,
    processing: orders.filter(o => ['processing','completed'].includes(o.status)).length,
    completed: orders.filter(o => o.status === 'completed').length,
    cancelled: orders.filter(o => o.status === 'cancelled').length,
    refunded: orders.filter(o => o.status === 'refunded').length,
  };
  
  // 代理线索转化漏斗
  const leadFlow = {
    total: leads.length,
    new: leads.filter(l => l.status === 'new' || l.status === 'pending').length,
    contacted: leads.filter(l => l.status === 'contacted').length,
    locked: leads.filter(l => l.status === 'locked').length,
    converted: leads.filter(l => l.status === 'converted').length,
    lost: leads.filter(l => l.status === 'lost' || l.status === 'rejected').length,
  };
  
  // 合同流程
  const contractFlow = {
    total: contracts.length,
    draft: contracts.filter(c => c.status === 'draft').length,
    reviewing: contracts.filter(c => c.status === 'reviewing' || c.status === 'pending').length,
    signed: contracts.filter(c => c.status === 'signed').length,
    active: contracts.filter(c => c.status === 'active').length,
    expired: contracts.filter(c => c.status === 'expired').length,
    terminated: contracts.filter(c => c.status === 'terminated').length,
  };
  
  // 入驻流程
  const onboardingFlow = {
    total: onboardings.length,
    pending: onboardings.filter(o => o.status === 'pending').length,
    reviewing: onboardings.filter(o => o.status === 'reviewing').length,
    approved: onboardings.filter(o => o.status === 'approved').length,
    rejected: onboardings.filter(o => o.status === 'rejected').length,
  };
  
  // 交付流程
  const deliveryFlow = {
    total: deliveries.length,
    notStarted: deliveries.filter(d => d.progress === 0 || !d.progress).length,
    inProgress: deliveries.filter(d => d.progress > 0 && d.progress < 100).length,
    completed: deliveries.filter(d => d.progress === 100).length,
    pendingAcceptance: deliveries.filter(d => d.acceptance_status === 'pending').length,
    accepted: deliveries.filter(d => d.acceptance_status === 'accepted').length,
  };
  
  // 工单流程
  const ticketFlow = {
    total: tickets.length,
    open: tickets.filter(t => t.status === 'open').length,
    inProgress: tickets.filter(t => t.status === 'in_progress' || t.status === 'processing').length,
    resolved: tickets.filter(t => t.status === 'resolved' || t.status === 'closed').length,
  };
  
  // 数字化评估流程
  const assessmentFlow = {
    total: assessments.length,
    pending: assessments.filter(a => a.status === 'pending').length,
    inProgress: assessments.filter(a => a.status === 'in_progress').length,
    completed: assessments.filter(a => a.status === 'completed').length,
  };
  
  // 服务撮合流程
  const serviceMatchFlow = {
    total: serviceMatches.length,
    pending: serviceMatches.filter(m => m.status === 'pending').length,
    matched: serviceMatches.filter(m => m.status === 'matched').length,
    inProgress: serviceMatches.filter(m => m.status === 'in_progress').length,
    completed: serviceMatches.filter(m => m.status === 'completed').length,
  };
  
  res.json({
    orderFlow,
    leadFlow,
    contractFlow,
    onboardingFlow,
    deliveryFlow,
    ticketFlow,
    assessmentFlow,
    serviceMatchFlow,
  });
});

// 5. 性能监控
router.get('/performance', (req, res) => {
  const db = getDB();
  const auditLogs = db.audit_logs || [];
  
  // API 响应状态码分布
  const statusCodes = {};
  auditLogs.forEach(log => {
    if (log.response_status) {
      const code = Math.floor(log.response_status / 100) + 'xx';
      statusCodes[code] = (statusCodes[code] || 0) + 1;
    }
  });
  
  // 错误率
  const errorCount = auditLogs.filter(l => l.response_status >= 400).length;
  const errorRate = auditLogs.length ? (errorCount / auditLogs.length * 100).toFixed(1) : 0;
  
  // 慢请求（从 metadata 提取）
  const slowRequests = auditLogs.filter(l => {
    try {
      const meta = JSON.parse(l.metadata || '{}');
      return meta.duration && meta.duration > 1000;
    } catch { return false; }
  });
  
  // 24h 内活动
  const now = new Date();
  const last24h = auditLogs.filter(l => {
    if (!l.created_at) return false;
    const d = new Date(l.created_at);
    return (now - d) < 86400000;
  });
  
  // 按小时分布
  const hourlyActivity = {};
  last24h.forEach(l => {
    if (l.created_at) {
      const h = new Date(l.created_at).getHours();
      hourlyActivity[h] = (hourlyActivity[h] || 0) + 1;
    }
  });
  
  // 安全事件
  const securityEvents = auditLogs.filter(l => l.severity === 'warning' || l.severity === 'error');
  
  res.json({
    apiStats: {
      totalRequests: auditLogs.length,
      statusCodes: Object.entries(statusCodes).map(([code, count]) => ({ code, count })).sort((a,b) => b.count - a.count),
      errorCount,
      errorRate,
      slowRequests: slowRequests.length,
    },
    activity24h: {
      total: last24h.length,
      hourly: Object.entries(hourlyActivity).map(([hour, count]) => ({ hour: parseInt(hour), count })).sort((a,b) => a.hour - b.hour),
    },
    security: {
      totalEvents: securityEvents.length,
      warnings: securityEvents.filter(e => e.severity === 'warning').length,
      errors: securityEvents.filter(e => e.severity === 'error').length,
      recentEvents: securityEvents.slice(-10).reverse().map(e => ({
        time: e.created_at,
        action: e.action,
        description: e.description,
        severity: e.severity,
        ip: e.ip_address,
      })),
    },
    systemHealth: {
      dbTables: Object.keys(db).filter(k => k.startsWith('_') === false).length,
      uptime: process.uptime ? Math.floor(process.uptime()) : 0,
      memoryMB: process.memoryUsage ? Math.round(process.memoryUsage().rss / 1024 / 1024) : 0,
      nodeVersion: process.version,
    },
  });
});

module.exports = router;
