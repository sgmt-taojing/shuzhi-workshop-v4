#!/usr/bin/env node
/**
 * 数智工坊 - 数据生成机器人
 * 模拟各角色使用系统，生成活数据
 * 运行方式: node scripts/data-bot.js [--count=20] [--days=7]
 */

const path = require('path');
const dbModule = require('../models/db');

const db = dbModule.getDB();
const args = process.argv.slice(2);
let maxEvents = 20;
let daysBack = 7;

args.forEach(a => {
  const m = a.match(/--count=(\d+)/);
  if (m) maxEvents = parseInt(m[1]);
  const m2 = a.match(/--days=(\d+)/);
  if (m2) daysBack = parseInt(m2[1]);
});

// ==================== 工具函数 ====================
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomDate(daysBack) {
  const now = Date.now();
  const past = now - randomInt(0, daysBack) * 24 * 3600 * 1000 - randomInt(0, 24 * 3600 * 1000);
  return new Date(past).toISOString();
}
function nextId(table) {
  // 使用 SQLite AUTOINCREMENT，返回 null 让数据库自动生成
  // 但 push 操作需要 id 在对象上——所以用 db._nextId Proxy
  if (!db._nextId) db._nextId = {};
  if (!db._nextId[table]) db._nextId[table] = 1;
  return db._nextId[table]++;
}

// 安全插入：不设 id，让 AUTOINCREMENT 处理
function autoInsert(table, data) {
  const clean = { ...data };
  delete clean.id; // 让数据库自动生成
  const arr = db[table];
  if (arr) {
    arr.push(clean);
    // push 后数组重新加载，返回最新一条
    return arr[arr.length - 1];
  }
  return data;
}

// ==================== 角色机器人 ====================

// 1. 客户/买家 —— 提交咨询
function botCustomerConsult() {
  const companies = ['济南鑫达科技', '青岛海润物流', '潍坊盛源食品', '临沂宏图商贸', '烟台凯瑞机械', '淄博新华化工', '威海远洋渔业', '德州大地农业'];
  const names = ['张经理', '李总', '王主任', '赵经理', '刘总', '陈工', '杨经理', '孙总'];
  const phones = ['138', '139', '186', '187', '158', '159', '150', '151'];
  const intentions = [
    { source: '抖音广告', content: '想了解ERP系统，我们有200人规模，需要对接现有财务系统' },
    { source: '微信推文', content: '对MES系统感兴趣，我们是机械制造企业，年产值5000万' },
    { source: '朋友推荐', content: '咨询进销存系统价格，小公司30人，月流水100万左右' },
    { source: '百度搜索', content: '需要工程项目管理系统，我们有多个在建项目需要统一管理' },
    { source: '行业展会', content: '想了解财务管理系统，代理记账公司，服务50+客户' },
    { source: '公众号文章', content: '对数字化全家桶方案感兴趣，集团企业，下属5个子公司' },
    { source: '官网咨询', content: '咨询系统定制开发，我们有特殊行业需求（医疗器械GMP）' },
  ];
  const intention = randomFrom(intentions);
  const contact = {
    company: randomFrom(companies),
    name: randomFrom(names),
    phone: randomFrom(phones) + randomInt(10000000, 99999999).toString(),
    lead_source: intention.source,
    message: intention.content,
    demand: intention.content.slice(0, 50),
    status: 'new',
    lead_stage: 'new',
    lead_score: randomInt(1, 5),
    industry: randomFrom(['智能制造', '食品加工', '建筑工程', '物流运输', '能源电力']),
    created_at: randomDate(1),
    updated_at: new Date().toISOString()
  };
  autoInsert('contacts', contact);
  console.log(`[客户咨询] ${contact.company} - ${contact.name}: ${contact.message.slice(0, 30)}...`);
  return contact;
}

// 2. 客户/买家 —— 下单
function botCustomerOrder() {
  const products = db.products || [];
  if (products.length === 0) return null;
  const product = randomFrom(products);
  const buyers = ['济南鑫达科技', '青岛海润物流', '潍坊盛源食品', '临沂宏图商贸', '烟台凯瑞机械', '淄博新华化工'];
  const statuses = ['pending', 'paid', 'processing', 'completed', 'completed', 'completed']; // 偏向完成
  const status = randomFrom(statuses);
  const amount = product.price || randomInt(9800, 49800);
  const orderNo = 'ORD' + Date.now().toString().slice(-8) + randomInt(10, 99);
  
  const order = {
    order_no: orderNo,
    product_id: product.id,
    product_title: product.title,
    buyer_name: randomFrom(buyers),
    buyer_phone: '1' + randomInt(38, 87) + randomInt(10000000, 99999999).toString(),
    amount: amount,
    quantity: 1,
    status: status,
    payment_method: status === 'completed' || status === 'paid' ? randomFrom(['微信支付', '银行转账', '对公转账']) : '',
    remark: '',
    created_at: randomDate(daysBack),
    updated_at: new Date().toISOString()
  };
  autoInsert('orders', order);
  console.log(`[客户下单] ${order.order_no} - ${order.product_title} ¥${order.amount} (${order.status})`);
  return order;
}

// 3. 代理商 —— 推送线索
function botAgentLead() {
  const agents = (db.agents || []).slice(0, 3);
  if (agents.length === 0) {
    // 创建模拟代理商
    const agentNames = ['济南代理-张伟', '青岛代理-李娜', '临沂代理-王强'];
    const agent = {
      name: randomFrom(agentNames),
      level: 'silver',
      phone: '1' + randomInt(38, 87) + randomInt(10000000, 99999999).toString(),
      status: 'active',
      created_at: randomDate(30)
    };
    autoInsert('agents', agent);
  }
  const agent = randomFrom(db.agents);
  const companies = ['德州利民机械', '聊城光明食品', '滨州华丰纺织', '菏泽万象建材', '枣庄永泰矿业'];
  const lead = {
    agent_id: agent.id,
    agent_name: agent.name,
    company_name: randomFrom(companies),
    contact_name: randomFrom(['赵总', '钱经理', '孙主任', '周工']),
    contact_phone: '1' + randomInt(38, 87) + randomInt(10000000, 99999999).toString(),
    industry: randomFrom(['智能制造', '食品加工', '建筑工程', '物流运输']),
    region: randomFrom(['济南', '青岛', '临沂', '潍坊', '烟台']),
    demand_desc: randomFrom(['ERP系统需求', 'MES生产管理', '进销存系统', '财务系统', '仓储管理']),
    status: randomFrom(['new', 'contacted', 'follow_up']),
    created_at: randomDate(3),
    updated_at: new Date().toISOString()
  };
  autoInsert('agent_leads', lead);
  console.log(`[代理线索] ${agent.name} → ${lead.company_name} (${lead.demand_desc})`);
  return lead;
}

// 4. 甲方企业 —— 入驻申请
function botOnboarding() {
  const industries = ['智能制造', '食品加工', '建筑工程', '物流运输', '医疗器械', '新能源', '农业科技'];
  const products = ['ERP系统', 'MES生产管理', '进销存管理', '财务系统', '仓储管理', '质量追溯'];
  const onboarding = {
    company_name: randomFrom(['济南智造科技', '青岛海蓝食品', '潍坊建工集团', '临沂物流园', '淄博新材料']) + randomInt(1, 99),
    contact_person: randomFrom(['张总', '李经理', '王主任', '赵总']),
    phone: '1' + randomInt(38, 87) + randomInt(10000000, 99999999).toString(),
    email: 'contact' + randomInt(100, 999) + '@company.com',
    industry: randomFrom(industries),
    product_name: randomFrom(products),
    product_desc: '企业数字化转型需求，希望对接平台服务',
    status: 'pending',
    created_at: randomDate(2),
    updated_at: new Date().toISOString(),
    reject_reason: '',
    converted: 0,
    client_id: null,
    client_product_id: null
  };
  autoInsert('onboardings', onboarding);
  console.log(`[入驻申请] ${onboarding.company_name} - ${onboarding.product_name}`);
  return onboarding;
}

// 5. 运营 —— 发通知
function botNotification() {
  const types = [
    { type: 'system', title: '系统维护通知', content: '系统将于本周日凌晨2-4点进行例行维护，届时服务可能短暂中断，请提前做好安排。' },
    { type: 'activity', title: '夏季数字化转型优惠活动', content: '7月特惠：ERP系统首年9折，MES系统免费试用30天，名额有限，先到先得！' },
    { type: 'product', title: '新增产品上线通知', content: '仓储管理系统V3.0已上线，支持多仓库、批次管理和条码追溯，欢迎咨询。' },
    { type: 'order', title: '订单状态更新', content: '您的订单已进入实施阶段，项目经理将在24小时内与您联系。' },
    { type: 'onboarding', title: '入驻审核通过', content: '恭喜您的入驻申请已审核通过，欢迎成为数智工坊平台合作伙伴！' },
  ];
  const tmpl = randomFrom(types);
  const notification = {
    type: tmpl.type,
    title: tmpl.title,
    content: tmpl.content,
    target_phones: [],
    link_type: '',
    link_id: '',
    icon: '',
    created_at: randomDate(2)
  };
  autoInsert('notifications', notification);
  console.log(`[系统通知] ${notification.title}`);
  return notification;
}

// 6. 客户 —— 评价
function botReview() {
  const products = db.products || [];
  if (products.length === 0) return null;
  const product = randomFrom(products);
  const ratings = [5, 5, 5, 4, 4, 4, 3, 5];
  const contents = [
    '系统功能很全面，实施团队专业，强烈推荐！',
    '用了3个月，ERP模块很实用，但学习曲线有点陡。',
    '性价比很高，客服响应也快，满意。',
    'MES系统帮我们实现了生产全流程数字化，效果明显。',
    '整体不错，但希望能增加移动端支持。',
    '从选型到上线只用了2周，效率很高！',
    '对接现有系统很顺利，技术支持到位。',
  ];
  const review = {
    product_type: 'product',
    product_id: product.id,
    openid: 'bot_' + randomInt(1000, 9999),
    user_id: 0,
    rating: randomFrom(ratings),
    content: randomFrom(contents),
    images: '[]',
    reply: '',
    replied_at: null,
    published: 1,
    created_at: randomDate(daysBack),
    updated_at: new Date().toISOString()
  };
  autoInsert('reviews', review);
  console.log(`[客户评价] 用户${review.rating}星 → 产品#${review.product_id}`);
  return review;
}

// 7. 客服 —— 创建会话
function botCSConversation() {
  const questions = [
    '您好，我想咨询ERP系统的价格',
    '请问MES系统支持多工厂管理吗？',
    '系统可以定制开发吗？我们有特殊需求',
    '售后技术支持响应时间多久？',
    '可以提供系统演示吗？',
  ];
  const openid = 'bot_user_' + randomInt(1000, 9999);
  const conv = {
    openid: openid,
    user_id: 0,
    status: randomFrom(['open', 'open', 'closed']),
    last_message: randomFrom(questions),
    last_message_at: randomDate(1),
    created_at: randomDate(3)
  };
  autoInsert('cs_conversations', conv);
  
  // 添加初始消息
  const msg = {
    conversation_id: conv.id,
    openid: openid,
    from_user: 'user',
    direction: 'in',
    message_type: 'text',
    content: conv.last_message,
    handled: conv.status === 'closed' ? 1 : 0,
    created_at: conv.created_at
  };
  autoInsert('cs_messages', msg);
  
  // 如果已关闭，添加客服回复
  if (conv.status === 'closed') {
    const replies = [
      '您好，ERP系统价格根据模块和用户数不同，从9800到49800不等，我给您发详细报价。',
      'MES系统支持多工厂管理，可以统一调度不同工厂的生产计划。',
      '支持定制开发，我们有专业的技术团队，可以给您评估需求和报价。',
      '售后7x24小时响应，紧急问题2小时内到场。',
      '可以安排演示，请问您方便什么时间？',
    ];
    const reply = {
      conversation_id: conv.id,
      openid: openid,
      from_user: 'admin',
      direction: 'out',
      message_type: 'text',
      content: randomFrom(replies),
      handled: 1,
      created_at: randomDate(1)
    };
    db.cs_messages.push(reply);
  }
  
  console.log(`[客服会话] #${conv.id} - ${conv.last_message.slice(0, 20)}...`);
  return conv;
}

// 8. 积分 —— 发放积分记录
function botPointRecord() {
  const actions = [
    { action: 'daily_login', label: '每日登录', points: 5 },
    { action: 'view_product', label: '浏览产品', points: 2 },
    { action: 'share_product', label: '分享产品', points: 10 },
    { action: 'submit_review', label: '提交评价', points: 20 },
    { action: 'invite_user', label: '邀请用户', points: 50 },
    { action: 'complete_order', label: '完成订单', points: 100 },
  ];
  const act = randomFrom(actions);
  const record = {
    openid: 'bot_user_' + randomInt(1000, 9999),
    user_id: 0,
    type: 'earn',
    action: act.action,
    action_label: act.label,
    points: act.points,
    description: `通过${act.label}获得${act.points}积分`,
    ref_id: randomInt(1, 100),
    ref_type: 'system',
    created_at: randomDate(daysBack)
  };
  autoInsert('point_records', record);
  console.log(`[积分记录] +${act.points} (${act.label})`);
  return record;
}

// 9. 反馈管理
function botFeedback() {
  const categories = [
    { category: 'bug', label: '系统Bug', content: '订单详情页面在手机端显示错位' },
    { category: 'suggestion', label: '功能建议', content: '希望增加批量导出订单功能' },
    { category: 'complaint', label: '投诉', content: '客服回复速度太慢，等了2小时' },
    { category: 'praise', label: '表扬', content: '实施团队非常专业，感谢小王的支持' },
    { category: 'question', label: '咨询', content: '如何修改绑定的手机号码？' },
  ];
  const cat = randomFrom(categories);
  const statuses = ['pending', 'pending', 'processing', 'resolved', 'resolved'];
  const feedback = {
    category: cat.category,
    category_label: cat.label,
    content: cat.content,
    contact: '1' + randomInt(38, 87) + randomInt(10000000, 99999999).toString(),
    openid: 'bot_user_' + randomInt(1000, 9999),
    user_id: 0,
    rating: randomInt(3, 5),
    images: [],
    page: '/admin/',
    status: randomFrom(statuses),
    reply: '',
    replied_at: null,
    replied_by: '',
    created_at: randomDate(2)
  };
  autoInsert('feedbacks', feedback);
  console.log(`[用户反馈] [${cat.label}] ${cat.content.slice(0, 25)}...`);
  return feedback;
}

// ==================== 主执行 ====================

const bots = [
  { name: '客户咨询', fn: botCustomerConsult, weight: 2 },
  { name: '客户下单', fn: botCustomerOrder, weight: 3 },
  { name: '代理线索', fn: botAgentLead, weight: 2 },
  { name: '入驻申请', fn: botOnboarding, weight: 1 },
  { name: '系统通知', fn: botNotification, weight: 1 },
  { name: '客户评价', fn: botReview, weight: 2 },
  { name: '客服会话', fn: botCSConversation, weight: 2 },
  { name: '积分记录', fn: botPointRecord, weight: 2 },
  { name: '用户反馈', fn: botFeedback, weight: 1 },
];

// 构建加权随机池
const pool = [];
bots.forEach(b => {
  for (let i = 0; i < b.weight; i++) pool.push(b);
});

console.log(`\n🤖 数据生成机器人启动`);
console.log(`   目标: ${maxEvents} 条事件`);
console.log(`   时间范围: 最近 ${daysBack} 天\n`);

let count = 0;
for (let i = 0; i < maxEvents; i++) {
  const bot = randomFrom(pool);
  try {
    const result = bot.fn();
    if (result) count++;
  } catch(e) {
    console.error(`[ERROR] ${bot.name}: ${e.message}`);
  }
}

console.log(`\n✅ 完成！共生成 ${count} 条数据`);

// 统计
console.log(`\n📊 数据统计:`);
console.log(`   订单: ${(db.orders||[]).length}`);
console.log(`   咨询: ${(db.contacts||[]).length}`);
console.log(`   入驻: ${(db.onboarding||[]).length}`);
console.log(`   通知: ${(db.notifications||[]).length}`);
console.log(`   评价: ${(db.reviews||[]).length}`);
console.log(`   客服会话: ${(db.cs_conversations||[]).length}`);
console.log(`   积分记录: ${(db.point_records||[]).length}`);
console.log(`   反馈: ${(db.feedbacks||[]).length}`);
console.log(`   代理线索: ${(db.agent_leads||[]).length}`);
