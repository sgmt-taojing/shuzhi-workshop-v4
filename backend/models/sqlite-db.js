/**
 * SQLite 数据库模型层
 * 
 * 替代原有的 JSON 文件存储（db.json），提供：
 * - 真正的 SQL 数据库（ACID 事务、索引、查询优化）
 * - 自动从 JSON 数据迁移
 * - 与原有 getDB/save/nextId 接口兼容
 * - 支持未来部署到服务器
 * 
 * 数据库文件：backend/data/dt-mall.db
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'dt-mall.db');
const JSON_DB_PATH = path.join(DATA_DIR, 'db.json');

let db = null;

// ==================== 表结构定义 ====================

const SCHEMA_SQL = `
-- 产品表
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT DEFAULT '',
  category TEXT DEFAULT '',
  price TEXT DEFAULT '',
  price_unit TEXT DEFAULT '',
  image TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',          -- JSON array
  highlights TEXT DEFAULT '[]',    -- JSON array
  cases TEXT DEFAULT '[]',         -- JSON array
  description TEXT DEFAULT '',
  features TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  published INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 甲方产品表
CREATE TABLE IF NOT EXISTS client_products (
  id INTEGER PRIMARY KEY,
  client_id INTEGER DEFAULT 0,
  client_name TEXT DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT DEFAULT '',
  category TEXT DEFAULT '',
  price TEXT DEFAULT '',
  price_unit TEXT DEFAULT '',
  image TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  description TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  contact_wechat TEXT DEFAULT '',
  published INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 文章表
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT DEFAULT '',
  cover TEXT DEFAULT '',
  category TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  summary TEXT DEFAULT '',
  content TEXT DEFAULT '',
  author TEXT DEFAULT '',
  source TEXT DEFAULT '',
  views INTEGER DEFAULT 0,
  published INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 客户（甲方）表
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  short_name TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  cover TEXT DEFAULT '',
  description TEXT DEFAULT '',
  qualifications TEXT DEFAULT '[]',
  team_size TEXT DEFAULT '',
  founded TEXT DEFAULT '',
  wechat_account_id TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  contact_email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  website TEXT DEFAULT '',
  published INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 痛点表
CREATE TABLE IF NOT EXISTS pain_points (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  icon TEXT DEFAULT '',
  description TEXT DEFAULT '',
  solutions TEXT DEFAULT '[]',
  effects TEXT DEFAULT '[]',
  published INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 行业表
CREATE TABLE IF NOT EXISTS industries (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  icon TEXT DEFAULT '',
  description TEXT DEFAULT '',
  cover TEXT DEFAULT '',
  published INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 订单表
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT UNIQUE NOT NULL,
  product_type TEXT DEFAULT 'client_product',
  product_id INTEGER DEFAULT 0,
  product_title TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  original_amount REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0,
  coupon_code TEXT DEFAULT '',
  coupon_id INTEGER,
  coupon_info TEXT DEFAULT '',
  quantity INTEGER DEFAULT 1,
  buyer_name TEXT DEFAULT '',
  buyer_phone TEXT DEFAULT '',
  buyer_openid TEXT DEFAULT '',
  user_id INTEGER,
  remark TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  payment_method TEXT DEFAULT '',
  transaction_id TEXT DEFAULT '',
  paid_at TEXT,
  shipped_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT DEFAULT '',
  tracking_number TEXT DEFAULT '',
  tracking_company TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  openid TEXT UNIQUE,
  nickname TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  is_admin INTEGER DEFAULT 0,
  disabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
);

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  openid TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);

-- 管理员表
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL
);

-- 联系/咨询表
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  company TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  message TEXT DEFAULT '',
  status TEXT DEFAULT 'new',
  lead_source TEXT DEFAULT '',
  lead_score INTEGER DEFAULT 0,
  assigned_to TEXT DEFAULT '',
  next_followup_date TEXT DEFAULT '',
  converted_at TEXT DEFAULT '',
  converted_order_id INTEGER DEFAULT 0,
  lost_reason TEXT DEFAULT '',
  demand TEXT DEFAULT '',
  template_msg_sent INTEGER DEFAULT 0,
  stale_remind_sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 线索跟进记录表（CRM 跟进笔记）
CREATE TABLE IF NOT EXISTS lead_notes (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  note_type TEXT DEFAULT 'note',
  content TEXT DEFAULT '',
  author TEXT DEFAULT '',
  next_followup_date TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 入驻申请表
CREATE TABLE IF NOT EXISTS onboardings (
  id INTEGER PRIMARY KEY,
  company_name TEXT DEFAULT '',
  contact_person TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  product_name TEXT DEFAULT '',
  product_desc TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 微信公众号表
CREATE TABLE IF NOT EXISTS wechat_accounts (
  id INTEGER PRIMARY KEY,
  name TEXT DEFAULT '',
  wechat_id TEXT DEFAULT '',
  type TEXT DEFAULT 'our',
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 推送历史表
CREATE TABLE IF NOT EXISTS push_history (
  id INTEGER PRIMARY KEY,
  article_id INTEGER,
  article_title TEXT DEFAULT '',
  account_id INTEGER,
  account_name TEXT DEFAULT '',
  media_id TEXT DEFAULT '',
  status TEXT DEFAULT 'simulated',
  pushed_at TEXT DEFAULT (datetime('now'))
);

-- 通知表
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  type TEXT DEFAULT 'system',
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  target_phones TEXT DEFAULT '[]',   -- JSON array
  link_type TEXT DEFAULT '',
  link_id TEXT DEFAULT '',
  icon TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 通知已读记录表
CREATE TABLE IF NOT EXISTS notification_reads (
  phone TEXT NOT NULL,
  notification_id INTEGER NOT NULL,
  read_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (phone, notification_id)
);

-- 优惠券表
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  title TEXT DEFAULT '',
  type TEXT DEFAULT 'fixed',
  value REAL DEFAULT 0,
  min_amount REAL DEFAULT 0,
  max_discount REAL DEFAULT 0,
  usage_limit INTEGER DEFAULT 0,
  used_count INTEGER DEFAULT 0,
  start_time TEXT,
  end_time TEXT,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 用户优惠券表
CREATE TABLE IF NOT EXISTS user_coupons (
  id INTEGER PRIMARY KEY,
  coupon_id INTEGER NOT NULL,
  openid TEXT NOT NULL,
  phone TEXT DEFAULT '',
  code TEXT DEFAULT '',
  title TEXT DEFAULT '',
  type TEXT DEFAULT '',
  value REAL DEFAULT 0,
  min_amount REAL DEFAULT 0,
  max_discount REAL DEFAULT 0,
  end_time TEXT,
  status TEXT DEFAULT 'unused',
  claimed_at TEXT DEFAULT (datetime('now')),
  used_at TEXT,
  remind_sent INTEGER DEFAULT 0
);

-- 评价表
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  product_type TEXT DEFAULT 'client_product',
  product_id INTEGER DEFAULT 0,
  openid TEXT DEFAULT '',
  user_id INTEGER,
  rating INTEGER DEFAULT 5,
  content TEXT DEFAULT '',
  images TEXT DEFAULT '[]',
  reply TEXT DEFAULT '',
  replied_at TEXT,
  published INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 分享记录表
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY,
  share_code TEXT UNIQUE,
  openid TEXT DEFAULT '',
  user_id INTEGER,
  product_type TEXT DEFAULT '',
  product_id INTEGER DEFAULT 0,
  product_title TEXT DEFAULT '',
  share_channel TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 分享点击表
CREATE TABLE IF NOT EXISTS share_clicks (
  id INTEGER PRIMARY KEY,
  share_id INTEGER NOT NULL,
  visitor_openid TEXT DEFAULT '',
  visitor_ip TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 推荐奖励表
CREATE TABLE IF NOT EXISTS referral_rewards (
  id INTEGER PRIMARY KEY,
  name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  reward_type TEXT DEFAULT 'coupon',
  reward_value REAL DEFAULT 0,
  coupon_id INTEGER,
  min_clicks INTEGER DEFAULT 0,
  min_conversions INTEGER DEFAULT 1,
  conversion_type TEXT DEFAULT 'contact',
  max_reward_per_user INTEGER DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 用户奖励表
CREATE TABLE IF NOT EXISTS user_rewards (
  id INTEGER PRIMARY KEY,
  openid TEXT DEFAULT '',
  user_id INTEGER,
  reward_id INTEGER,
  reward_type TEXT DEFAULT '',
  reward_value REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 客服会话表
CREATE TABLE IF NOT EXISTS cs_conversations (
  id INTEGER PRIMARY KEY,
  openid TEXT DEFAULT '',
  user_id INTEGER,
  status TEXT DEFAULT 'active',
  last_message TEXT DEFAULT '',
  last_message_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 客服消息表
CREATE TABLE IF NOT EXISTS cs_messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER,
  openid TEXT DEFAULT '',
  from_user TEXT DEFAULT '',
  direction TEXT DEFAULT 'user_to_service',
  message_type TEXT DEFAULT 'text',
  content TEXT DEFAULT '',
  handled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 模板消息日志表
CREATE TABLE IF NOT EXISTS template_msg_logs (
  id INTEGER PRIMARY KEY,
  openid TEXT DEFAULT '',
  template_id TEXT DEFAULT '',
  data TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  error_msg TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 关注关系表
CREATE TABLE IF NOT EXISTS follow_relations (
  id INTEGER PRIMARY KEY,
  openid TEXT DEFAULT '',
  account_id INTEGER,
  followed_at TEXT DEFAULT (datetime('now'))
);

-- 用户反馈表
CREATE TABLE IF NOT EXISTS feedbacks (
  id INTEGER PRIMARY KEY,
  category TEXT DEFAULT 'other',
  category_label TEXT DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  contact TEXT DEFAULT '',
  openid TEXT DEFAULT '',
  user_id INTEGER,
  rating INTEGER DEFAULT 0,
  images TEXT DEFAULT '[]',
  page TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  reply TEXT DEFAULT '',
  replied_at TEXT,
  replied_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ==================== 索引 ====================
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_buyer_phone ON orders(buyer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_buyer_openid ON orders(buyer_openid);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_products_published ON products(published);
CREATE INDEX IF NOT EXISTS idx_client_products_published ON client_products(published);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published);
CREATE INDEX IF NOT EXISTS idx_users_openid ON users(openid);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_coupon_code ON coupons(code);
CREATE INDEX IF NOT EXISTS idx_user_coupons_openid ON user_coupons(openid);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_type, product_id);
CREATE INDEX IF NOT EXISTS idx_cs_messages_conv ON cs_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_category ON feedbacks(category);
CREATE INDEX IF NOT EXISTS idx_feedbacks_openid ON feedbacks(openid);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at);

-- 用户积分表
CREATE TABLE IF NOT EXISTS user_points (
  id INTEGER PRIMARY KEY,
  openid TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  total_points INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  level_name TEXT DEFAULT '体验用户',
  today_points INTEGER DEFAULT 0,
  today_date TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 积分明细表
CREATE TABLE IF NOT EXISTS point_records (
  id INTEGER PRIMARY KEY,
  openid TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  type TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  action_label TEXT DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  description TEXT DEFAULT '',
  ref_id TEXT DEFAULT '',
  ref_type TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 积分任务表（每日任务/成就）
CREATE TABLE IF NOT EXISTS point_tasks (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  points INTEGER DEFAULT 0,
  type TEXT DEFAULT 'daily',
  icon TEXT DEFAULT '⭐',
  target_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 积分兑换商品表
CREATE TABLE IF NOT EXISTS point_rewards (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  icon TEXT DEFAULT '🎁',
  points_required INTEGER NOT NULL DEFAULT 0,
  type TEXT DEFAULT 'coupon',
  value TEXT DEFAULT '',
  stock INTEGER DEFAULT -1,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 兑换记录表
CREATE TABLE IF NOT EXISTS point_redemptions (
  id INTEGER PRIMARY KEY,
  openid TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  reward_id INTEGER NOT NULL,
  reward_title TEXT DEFAULT '',
  points_cost INTEGER NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  coupon_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_points_openid ON user_points(openid);
CREATE INDEX IF NOT EXISTS idx_point_records_openid ON point_records(openid);
CREATE INDEX IF NOT EXISTS idx_point_records_type ON point_records(type);
CREATE INDEX IF NOT EXISTS idx_point_records_created ON point_records(created_at);
CREATE INDEX IF NOT EXISTS idx_point_tasks_code ON point_tasks(code);
CREATE INDEX IF NOT EXISTS idx_point_tasks_status ON point_tasks(status);
CREATE INDEX IF NOT EXISTS idx_point_rewards_status ON point_rewards(status);
CREATE INDEX IF NOT EXISTS idx_point_redemptions_openid ON point_redemptions(openid);
CREATE INDEX IF NOT EXISTS idx_point_redemptions_status ON point_redemptions(status);

-- 用户行为事件表（转化漏斗分析）
CREATE TABLE IF NOT EXISTS user_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT DEFAULT '',
  session_id TEXT DEFAULT '',
  event_type TEXT NOT NULL,
  event_key TEXT DEFAULT '',
  page_path TEXT DEFAULT '',
  product_id INTEGER DEFAULT 0,
  product_title TEXT DEFAULT '',
  client_product_id INTEGER DEFAULT 0,
  article_id INTEGER DEFAULT 0,
  search_keyword TEXT DEFAULT '',
  referrer TEXT DEFAULT '',
  source TEXT DEFAULT '',
  extra TEXT DEFAULT '{}',
  ip TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_events_openid ON user_events(openid);
CREATE INDEX IF NOT EXISTS idx_user_events_type ON user_events(event_type);
CREATE INDEX IF NOT EXISTS idx_user_events_key ON user_events(event_key);
CREATE INDEX IF NOT EXISTS idx_user_events_created ON user_events(created_at);
CREATE INDEX IF NOT EXISTS idx_user_events_session ON user_events(session_id);

-- 小程序订阅消息模板表
CREATE TABLE IF NOT EXISTS subscribe_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  fields TEXT DEFAULT '[]',
  status INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 用户订阅授权记录表
CREATE TABLE IF NOT EXISTS subscribe_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL,
  template_id TEXT NOT NULL,
  code TEXT NOT NULL,
  remaining_count INTEGER DEFAULT 1,
  total_authorized INTEGER DEFAULT 1,
  authorized_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT DEFAULT '',
  status TEXT DEFAULT 'active'
);

-- 订阅消息发送日志表
CREATE TABLE IF NOT EXISTS subscribe_msg_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL,
  template_id TEXT NOT NULL,
  code TEXT NOT NULL,
  title TEXT DEFAULT '',
  data TEXT DEFAULT '{}',
  page TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  error_msg TEXT DEFAULT '',
  biz_type TEXT DEFAULT '',
  biz_id TEXT DEFAULT '',
  sent_at TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscribe_templates_code ON subscribe_templates(code);
CREATE INDEX IF NOT EXISTS idx_subscribe_templates_status ON subscribe_templates(status);
CREATE INDEX IF NOT EXISTS idx_subscribe_auth_openid ON subscribe_authorizations(openid);
CREATE INDEX IF NOT EXISTS idx_subscribe_auth_template ON subscribe_authorizations(template_id);
CREATE INDEX IF NOT EXISTS idx_subscribe_auth_code ON subscribe_authorizations(code);
CREATE INDEX IF NOT EXISTS idx_subscribe_auth_status ON subscribe_authorizations(status);
CREATE INDEX IF NOT EXISTS idx_subscribe_msg_logs_openid ON subscribe_msg_logs(openid);
CREATE INDEX IF NOT EXISTS idx_subscribe_msg_logs_code ON subscribe_msg_logs(code);
CREATE INDEX IF NOT EXISTS idx_subscribe_msg_logs_status ON subscribe_msg_logs(status);
CREATE INDEX IF NOT EXISTS idx_subscribe_msg_logs_biz ON subscribe_msg_logs(biz_type, biz_id);
CREATE INDEX IF NOT EXISTS idx_subscribe_msg_logs_created ON subscribe_msg_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_lead_source ON contacts(lead_source);
CREATE INDEX IF NOT EXISTS idx_contacts_assigned ON contacts(assigned_to);
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at);
CREATE INDEX IF NOT EXISTS idx_lead_notes_contact ON lead_notes(contact_id);
CREATE INDEX IF NOT EXISTS idx_lead_notes_created ON lead_notes(created_at);

-- 运营报告表
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  report_type TEXT NOT NULL DEFAULT 'daily',  -- daily / weekly / monthly
  report_date TEXT NOT NULL,                   -- 报告日期 YYYY-MM-DD
  period_start TEXT NOT NULL,                  -- 统计周期开始
  period_end TEXT NOT NULL,                    -- 统计周期结束
  title TEXT NOT NULL DEFAULT '',
  summary TEXT DEFAULT '',                     -- 摘要
  content TEXT DEFAULT '',                     -- 完整内容 (JSON)
  metrics TEXT DEFAULT '',                     -- 关键指标 (JSON)
  status TEXT DEFAULT 'generated',             -- generated / sent / archived
  sent_to TEXT DEFAULT '',                     -- 推送目标 (JSON array)
  sent_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(report_type);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(report_date);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

-- 预约演示表
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  booking_no TEXT UNIQUE NOT NULL,
  product_id INTEGER DEFAULT 0,
  product_title TEXT DEFAULT '',
  product_type TEXT DEFAULT 'product',
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  company TEXT DEFAULT '',
  position TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  email TEXT DEFAULT '',
  demo_date TEXT NOT NULL DEFAULT '',
  demo_time TEXT NOT NULL DEFAULT '',
  demo_format TEXT DEFAULT 'online',
  message TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  assigned_to TEXT DEFAULT '',
  meeting_link TEXT DEFAULT '',
  meeting_location TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  remind_sent INTEGER DEFAULT 0,
  openid TEXT DEFAULT '',
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(demo_date);
CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(phone);
CREATE INDEX IF NOT EXISTS idx_bookings_openid ON bookings(openid);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings(created_at);

-- 预约时间段配置表
CREATE TABLE IF NOT EXISTS booking_slots (
  id INTEGER PRIMARY KEY,
  slot_date TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  max_bookings INTEGER DEFAULT 3,
  current_bookings INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  UNIQUE(slot_date, slot_time)
);

CREATE INDEX IF NOT EXISTS idx_booking_slots_date ON booking_slots(slot_date);
CREATE INDEX IF NOT EXISTS idx_booking_slots_enabled ON booking_slots(enabled);

-- 数字化成熟度评估表
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY,
  openid TEXT DEFAULT '',
  company_name TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  company_size TEXT DEFAULT '',
  answers TEXT DEFAULT '[]',
  -- JSON array of {dimension, question_id, score, max_score}
  total_score REAL DEFAULT 0,
  max_score REAL DEFAULT 100,
  level TEXT DEFAULT '',
  -- beginner / intermediate / advanced / leading
  level_label TEXT DEFAULT '',
  dimension_scores TEXT DEFAULT '{}',
  -- JSON: {dimension: {score, max, level, label}}
  recommendations TEXT DEFAULT '[]',
  -- JSON array of recommended product ids + reasons
  report_summary TEXT DEFAULT '',
  -- AI-generated summary text
  status TEXT DEFAULT 'completed',
  -- completed / viewed / contacted / converted
  contact_id INTEGER DEFAULT 0,
  -- linked contact record
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assessments_openid ON assessments(openid);
CREATE INDEX IF NOT EXISTS idx_assessments_phone ON assessments(phone);
CREATE INDEX IF NOT EXISTS idx_assessments_industry ON assessments(industry);
CREATE INDEX IF NOT EXISTS idx_assessments_status ON assessments(status);
CREATE INDEX IF NOT EXISTS idx_assessments_level ON assessments(level);
CREATE INDEX IF NOT EXISTS idx_assessments_created ON assessments(created_at);

-- 操作审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL DEFAULT 'system',
  -- system / admin / user / wechat / api
  actor_id TEXT DEFAULT '',
  -- admin username / user openid / ip address
  actor_name TEXT DEFAULT '',
  -- display name
  action TEXT NOT NULL DEFAULT '',
  -- e.g. 'order.create', 'payment.refund', 'admin.login', 'product.update'
  resource_type TEXT DEFAULT '',
  -- order / product / article / client_product / user / coupon / config
  resource_id TEXT DEFAULT '',
  -- ID of the affected resource
  description TEXT DEFAULT '',
  -- human-readable description
  ip_address TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  request_method TEXT DEFAULT '',
  request_path TEXT DEFAULT '',
  request_body TEXT DEFAULT '',
  -- JSON string of key request params (sanitized)
  response_status INTEGER DEFAULT 0,
  -- HTTP response status code
  severity TEXT DEFAULT 'info',
  -- info / warning / critical
  metadata TEXT DEFAULT '{}',
  -- JSON: extra context (order_no, amount, etc.)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_logs(severity);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- ==================== 报价计算器表 ====================
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  company TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  product_id INTEGER DEFAULT 0,
  product_title TEXT NOT NULL,
  edition TEXT DEFAULT 'standard',
  edition_name TEXT DEFAULT '',
  user_count INTEGER DEFAULT 10,
  modules TEXT DEFAULT '[]',
  timeline TEXT DEFAULT 'standard',
  timeline_name TEXT DEFAULT '',
  base_price INTEGER DEFAULT 0,
  edition_price INTEGER DEFAULT 0,
  modules_price INTEGER DEFAULT 0,
  user_surcharge INTEGER DEFAULT 0,
  timeline_surcharge INTEGER DEFAULT 0,
  total_price INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new',
  lead_source TEXT DEFAULT 'quote_calculator',
  assigned_to TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_phone ON quotes(phone);
CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at);
`;

// ==================== 序列表（替代 _nextId） ====================
const SEQ_SQL = `
-- 服务交付里程碑表
CREATE TABLE IF NOT EXISTS service_milestones (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL DEFAULT 0,
  order_no TEXT DEFAULT '',
  buyer_phone TEXT DEFAULT '',
  buyer_openid TEXT DEFAULT '',
  product_title TEXT DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',  -- pending / in_progress / done / skipped
  progress INTEGER DEFAULT 0,      -- 0-100
  start_date TEXT DEFAULT '',
  expected_date TEXT DEFAULT '',
  completed_date TEXT DEFAULT '',
  deliverables TEXT DEFAULT '[]',  -- JSON array of {name, url, uploaded_at}
  notes TEXT DEFAULT '',           -- admin notes
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_service_milestones_order ON service_milestones(order_id);
CREATE INDEX IF NOT EXISTS idx_service_milestones_phone ON service_milestones(buyer_phone);
CREATE INDEX IF NOT EXISTS idx_service_milestones_status ON service_milestones(status);

-- 营销Banner表
CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  link_type TEXT DEFAULT 'page',
  link_url TEXT DEFAULT '',
  link_params TEXT DEFAULT '',
  bg_color TEXT DEFAULT '#2563eb',
  text_color TEXT DEFAULT '#ffffff',
  sort_order INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  click_count INTEGER DEFAULT 0,
  impression_count INTEGER DEFAULT 0,
  target_audience TEXT DEFAULT 'all',
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_banners_status ON banners(status);
CREATE INDEX IF NOT EXISTS idx_banners_sort ON banners(sort_order);
CREATE INDEX IF NOT EXISTS idx_banners_dates ON banners(start_date, end_date);

-- FAQ分类表
CREATE TABLE IF NOT EXISTS faq_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  icon TEXT DEFAULT '📋',
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  article_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_faq_cat_status ON faq_categories(status);
CREATE INDEX IF NOT EXISTS idx_faq_cat_sort ON faq_categories(sort_order);

-- FAQ条目表
CREATE TABLE IF NOT EXISTS faqs (
  id INTEGER PRIMARY KEY,
  category_id INTEGER DEFAULT 0,
  question TEXT NOT NULL DEFAULT '',
  answer TEXT DEFAULT '',
  answer_type TEXT DEFAULT 'text',
  tags TEXT DEFAULT '[]',
  sort_order INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  helpful_count INTEGER DEFAULT 0,
  unhelpful_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'published',
  is_pinned INTEGER DEFAULT 0,
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_faqs_category ON faqs(category_id);
CREATE INDEX IF NOT EXISTS idx_faqs_status ON faqs(status);
CREATE INDEX IF NOT EXISTS idx_faqs_pinned ON faqs(is_pinned);
CREATE INDEX IF NOT EXISTS idx_faqs_sort ON faqs(sort_order);

-- 发票表
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  invoice_no TEXT NOT NULL DEFAULT '',
  order_id INTEGER NOT NULL DEFAULT 0,
  order_no TEXT NOT NULL DEFAULT '',
  applicant_name TEXT NOT NULL DEFAULT '',
  applicant_phone TEXT NOT NULL DEFAULT '',
  applicant_openid TEXT DEFAULT '',
  -- 发票类型: normal=增值税普通电子发票, special=增值税专用发票, paper=纸质发票
  invoice_type TEXT NOT NULL DEFAULT 'normal',
  -- 抬头类型: enterprise=企业, personal=个人
  title_type TEXT NOT NULL DEFAULT 'enterprise',
  -- 发票抬头
  title_name TEXT NOT NULL DEFAULT '',
  tax_no TEXT DEFAULT '',
  -- 银行信息（专票必填）
  bank_name TEXT DEFAULT '',
  bank_account TEXT DEFAULT '',
  -- 地址信息（专票必填）
  company_address TEXT DEFAULT '',
  company_phone TEXT DEFAULT '',
  -- 收票信息
  email TEXT DEFAULT '',
  receiving_address TEXT DEFAULT '',
  receiving_name TEXT DEFAULT '',
  receiving_phone TEXT DEFAULT '',
  -- 金额
  amount REAL NOT NULL DEFAULT 0,
  -- 开票内容/备注
  content TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  -- 状态: pending=待开票, issued=已开票, rejected=已拒绝, voided=已作废
  status TEXT NOT NULL DEFAULT 'pending',
  -- 开票信息
  invoice_file_url TEXT DEFAULT '',
  invoice_number TEXT DEFAULT '',
  issued_at TEXT DEFAULT '',
  issued_by TEXT DEFAULT '',
  reject_reason TEXT DEFAULT '',
  rejected_at TEXT DEFAULT '',
  rejected_by TEXT DEFAULT '',
  voided_at TEXT DEFAULT '',
  voided_reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_phone ON invoices(applicant_phone);
CREATE INDEX IF NOT EXISTS idx_invoices_no ON invoices(invoice_no);
CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(invoice_type);

-- 售后工单表
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  ticket_no TEXT NOT NULL DEFAULT '',
  -- 关联订单
  order_id INTEGER NOT NULL DEFAULT 0,
  order_no TEXT NOT NULL DEFAULT '',
  -- 申请人信息
  applicant_name TEXT NOT NULL DEFAULT '',
  applicant_phone TEXT NOT NULL DEFAULT '',
  applicant_openid TEXT DEFAULT '',
  -- 工单内容
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  -- 工单类型: bug=缺陷, feature=需求变更, question=使用咨询, complaint=投诉, other=其他
  category TEXT NOT NULL DEFAULT 'question',
  -- 优先级: low=低, medium=中, high=高, urgent=紧急
  priority TEXT NOT NULL DEFAULT 'medium',
  -- 关联产品
  product_title TEXT DEFAULT '',
  -- 附件（JSON 数组：图片URL列表）
  attachments TEXT DEFAULT '[]',
  -- 状态: open=待处理, in_progress=处理中, resolved=已解决, closed=已关闭, reopened=已重开
  status TEXT NOT NULL DEFAULT 'open',
  -- 处理人
  assignee TEXT DEFAULT '',
  -- 解决信息
  resolution TEXT DEFAULT '',
  resolved_at TEXT DEFAULT '',
  resolved_by TEXT DEFAULT '',
  -- 关闭信息
  closed_at TEXT DEFAULT '',
  -- 评价
  satisfaction INTEGER DEFAULT 0,
  satisfaction_comment TEXT DEFAULT '',
  -- 时间戳
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_no ON tickets(ticket_no);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_phone ON tickets(applicant_phone);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);

-- 工单回复表
CREATE TABLE IF NOT EXISTS ticket_replies (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL DEFAULT 0,
  -- 回复人信息
  replier_name TEXT NOT NULL DEFAULT '',
  replier_role TEXT NOT NULL DEFAULT 'user',
  -- user=用户, admin=管理员
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT DEFAULT '[]',
  -- 是否为内部备注（用户不可见）
  is_internal INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_replies_ticket ON ticket_replies(ticket_id);

-- ===== 合作伙伴推荐计划 =====

-- 合作伙伴表
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY,
  partner_no TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  company TEXT DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT DEFAULT '',
  openid TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  level TEXT DEFAULT 'standard',         -- standard/silver/gold/platinum
  status TEXT DEFAULT 'pending',          -- pending/approved/rejected/suspended
  commission_rate INTEGER DEFAULT 10,     -- 佣金比例（百分比）
  total_referrals INTEGER DEFAULT 0,      -- 累计推荐数
  successful_referrals INTEGER DEFAULT 0, -- 成功转化数
  total_commission REAL DEFAULT 0,        -- 累计佣金（元）
  paid_commission REAL DEFAULT 0,         -- 已提现佣金
  pending_commission REAL DEFAULT 0,      -- 待结算佣金
  bank_name TEXT DEFAULT '',
  bank_account TEXT DEFAULT '',
  bank_holder TEXT DEFAULT '',
  alipay_account TEXT DEFAULT '',
  reject_reason TEXT DEFAULT '',
  approved_at TEXT DEFAULT '',
  approved_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_partners_no ON partners(partner_no);
CREATE INDEX IF NOT EXISTS idx_partners_phone ON partners(phone);
CREATE INDEX IF NOT EXISTS idx_partners_openid ON partners(openid);
CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status);
CREATE INDEX IF NOT EXISTS idx_partners_level ON partners(level);

-- 推荐记录表
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY,
  referral_no TEXT NOT NULL DEFAULT '',
  partner_id INTEGER NOT NULL DEFAULT 0,
  partner_name TEXT DEFAULT '',
  lead_name TEXT NOT NULL DEFAULT '',
  lead_phone TEXT NOT NULL DEFAULT '',
  lead_company TEXT DEFAULT '',
  lead_industry TEXT DEFAULT '',
  product_id INTEGER DEFAULT 0,
  product_title TEXT DEFAULT '',
  relationship TEXT DEFAULT 'friend',      -- friend/colleague/client/other
  remark TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',            -- pending/contacted/qualified/converted/lost
  order_id INTEGER DEFAULT 0,
  order_no TEXT DEFAULT '',
  order_amount REAL DEFAULT 0,
  commission_amount REAL DEFAULT 0,         -- 预估佣金
  commission_status TEXT DEFAULT 'none',    -- none/estimated/confirmed/paid
  converted_at TEXT DEFAULT '',
  lost_reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_referrals_no ON referrals(referral_no);
CREATE INDEX IF NOT EXISTS idx_referrals_partner ON referrals(partner_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_phone ON referrals(lead_phone);
CREATE INDEX IF NOT EXISTS idx_referrals_commission ON referrals(commission_status);

-- 佣金记录表
CREATE TABLE IF NOT EXISTS commission_records (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL DEFAULT 0,
  partner_name TEXT DEFAULT '',
  referral_id INTEGER DEFAULT 0,
  referral_no TEXT DEFAULT '',
  order_id INTEGER DEFAULT 0,
  order_no TEXT DEFAULT '',
  order_amount REAL DEFAULT 0,
  rate INTEGER DEFAULT 10,
  amount REAL DEFAULT 0,
  status TEXT DEFAULT 'estimated',          -- estimated/confirmed/paid/cancelled
  confirmed_at TEXT DEFAULT '',
  paid_at TEXT DEFAULT '',
  withdrawal_id INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commission_partner ON commission_records(partner_id);
CREATE INDEX IF NOT EXISTS idx_commission_status ON commission_records(status);
CREATE INDEX IF NOT EXISTS idx_commission_order ON commission_records(order_id);
CREATE INDEX IF NOT EXISTS idx_commission_withdrawal ON commission_records(withdrawal_id);

-- 提现记录表
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY,
  withdrawal_no TEXT NOT NULL DEFAULT '',
  partner_id INTEGER NOT NULL DEFAULT 0,
  partner_name TEXT DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  fee REAL DEFAULT 0,                       -- 手续费
  actual_amount REAL DEFAULT 0,             -- 实到金额
  method TEXT DEFAULT 'bank',               -- bank/alipay
  account_info TEXT DEFAULT '',             -- JSON: { bank_name, bank_account, bank_holder } or { alipay_account }
  status TEXT DEFAULT 'pending',            -- pending/approved/rejected/paid/failed
  reject_reason TEXT DEFAULT '',
  paid_at TEXT DEFAULT '',
  paid_by TEXT DEFAULT '',
  transaction_no TEXT DEFAULT '',           -- 银行流水号
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_no ON withdrawals(withdrawal_no);
CREATE INDEX IF NOT EXISTS idx_withdrawals_partner ON withdrawals(partner_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);

-- 智能客服会话表
CREATE TABLE IF NOT EXISTS chatbot_sessions (
  id INTEGER PRIMARY KEY,
  openid TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  message_count INTEGER DEFAULT 0,
  transfer_requested INTEGER DEFAULT 0,
  rating INTEGER DEFAULT NULL,
  rating_comment TEXT DEFAULT '',
  rated_at TEXT DEFAULT NULL,
  taken_over_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chatbot_sessions_openid ON chatbot_sessions(openid);
CREATE INDEX IF NOT EXISTS idx_chatbot_sessions_status ON chatbot_sessions(status);

-- 智能客服消息表
CREATE TABLE IF NOT EXISTS chatbot_messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT DEFAULT '',
  type TEXT DEFAULT 'text',
  matched_faq TEXT DEFAULT NULL,
  matched_products TEXT DEFAULT NULL,
  suggestions TEXT DEFAULT NULL,
  action TEXT DEFAULT NULL,
  helpful INTEGER DEFAULT NULL,
  feedback_comment TEXT DEFAULT '',
  feedback_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chatbot_messages_session ON chatbot_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_messages_role ON chatbot_messages(role);

-- 智能客服统计表
CREATE TABLE IF NOT EXISTS chatbot_stats (
  id INTEGER PRIMARY KEY DEFAULT 1,
  total_sessions INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  helpful_count INTEGER DEFAULT 0,
  unhelpful_count INTEGER DEFAULT 0
);

-- 电子合同模板表
CREATE TABLE IF NOT EXISTS contract_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  code TEXT DEFAULT '',
  category TEXT DEFAULT 'service',
  content TEXT DEFAULT '',
  clauses TEXT DEFAULT '[]',
  variables TEXT DEFAULT '[]',
  status INTEGER DEFAULT 1,
  version TEXT DEFAULT '1.0',
  creator TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ctpl_code ON contract_templates(code);
CREATE INDEX IF NOT EXISTS idx_ctpl_category ON contract_templates(category);
CREATE INDEX IF NOT EXISTS idx_ctpl_status ON contract_templates(status);

-- 电子合同表
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY,
  contract_no TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  template_id INTEGER DEFAULT 0,
  template_name TEXT DEFAULT '',
  type TEXT DEFAULT 'service',
  party_a_name TEXT DEFAULT '',
  party_a_contact TEXT DEFAULT '',
  party_a_phone TEXT DEFAULT '',
  party_a_address TEXT DEFAULT '',
  party_b_name TEXT DEFAULT '数造工坊',
  party_b_contact TEXT DEFAULT '',
  party_b_phone TEXT DEFAULT '',
  party_b_address TEXT DEFAULT '',
  product_title TEXT DEFAULT '',
  product_id INTEGER DEFAULT 0,
  order_id INTEGER DEFAULT 0,
  order_no TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  service_period TEXT DEFAULT '',
  service_start_date TEXT DEFAULT '',
  service_end_date TEXT DEFAULT '',
  content TEXT DEFAULT '',
  clauses TEXT DEFAULT '[]',
  custom_terms TEXT DEFAULT '',
  attachments TEXT DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  party_a_signed INTEGER DEFAULT 0,
  party_a_signed_at TEXT DEFAULT '',
  party_a_sign_ip TEXT DEFAULT '',
  party_b_signed INTEGER DEFAULT 0,
  party_b_signed_at TEXT DEFAULT '',
  party_b_sign_ip TEXT DEFAULT '',
  effective_at TEXT DEFAULT '',
  expired_at TEXT DEFAULT '',
  terminated_at TEXT DEFAULT '',
  terminate_reason TEXT DEFAULT '',
  buyer_openid TEXT DEFAULT '',
  buyer_phone TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  admin_remark TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contracts_no ON contracts(contract_no);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_phone ON contracts(buyer_phone);
CREATE INDEX IF NOT EXISTS idx_contracts_openid ON contracts(buyer_openid);
CREATE INDEX IF NOT EXISTS idx_contracts_order ON contracts(order_id);
CREATE INDEX IF NOT EXISTS idx_contracts_type ON contracts(type);

-- 营销活动表
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  campaign_no TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  type TEXT DEFAULT 'discount',          -- discount/gift/flash/bundle
  discount_type TEXT DEFAULT 'percent',  -- percent/fixed
  discount_value REAL DEFAULT 0,         -- 折扣比例(%)或减免金额(元)
  min_amount REAL DEFAULT 0,             -- 最低消费金额
  max_discount REAL DEFAULT 0,           -- 最大优惠金额(0=不限)
  gift_product_id INTEGER DEFAULT 0,    -- 赠品产品ID
  gift_product_title TEXT DEFAULT '',   -- 赠品产品名称
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  status TEXT DEFAULT 'draft',           -- draft/active/paused/ended/expired
  banner_image TEXT DEFAULT '',
  rules TEXT DEFAULT '[]',              -- JSON: 活动规则说明数组
  applicable_scope TEXT DEFAULT 'all',   -- all/products/categories
  applicable_products TEXT DEFAULT '[]', -- JSON: 适用产品ID列表
  applicable_categories TEXT DEFAULT '[]', -- JSON: 适用分类列表
  usage_limit INTEGER DEFAULT 0,        -- 总参与次数(0=不限)
  used_count INTEGER DEFAULT 0,         -- 已参与次数
  per_user_limit INTEGER DEFAULT 1,     -- 每用户限参与次数
  priority INTEGER DEFAULT 0,           -- 优先级(数字越大越优先)
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_time ON campaigns(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_campaigns_type ON campaigns(type);

-- 活动参与记录表
CREATE TABLE IF NOT EXISTS campaign_records (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL DEFAULT 0,
  campaign_name TEXT DEFAULT '',
  user_openid TEXT DEFAULT '',
  user_phone TEXT DEFAULT '',
  order_id INTEGER DEFAULT 0,
  order_no TEXT DEFAULT '',
  original_amount REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0,
  final_amount REAL DEFAULT 0,
  benefit_type TEXT DEFAULT '',          -- discount/gift
  benefit_detail TEXT DEFAULT '',        -- 优惠详情描述
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaign_records_campaign ON campaign_records(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_records_user ON campaign_records(user_openid);
CREATE INDEX IF NOT EXISTS idx_campaign_records_order ON campaign_records(order_id);

-- 政策追踪表
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT DEFAULT '',
  level TEXT NOT NULL DEFAULT 'national',
  -- national=国家, shandong=山东, ningxia=宁夏
  level_label TEXT DEFAULT '国家',
  category TEXT DEFAULT '',
  -- 政策类型: digital=数字化转型, tax=财税, industry=产业, talent=人才, other=其他
  category_label TEXT DEFAULT '',
  issuing_authority TEXT DEFAULT '',
  -- 发文机构
  document_no TEXT DEFAULT '',
  -- 文号
  publish_date TEXT DEFAULT '',
  effective_date TEXT DEFAULT '',
  expiry_date TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  content TEXT DEFAULT '',
  key_points TEXT DEFAULT '[]',
  -- JSON array: 关键要点
  applicable_industries TEXT DEFAULT '[]',
  -- JSON array: 适用行业
  support_measures TEXT DEFAULT '[]',
  -- JSON array: 扶持措施
  attachments TEXT DEFAULT '[]',
  -- JSON array: 附件链接
  tags TEXT DEFAULT '[]',
  -- JSON array
  views INTEGER DEFAULT 0,
  published INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_policies_level ON policies(level);
CREATE INDEX IF NOT EXISTS idx_policies_category ON policies(category);
CREATE INDEX IF NOT EXISTS idx_policies_published ON policies(published);
CREATE INDEX IF NOT EXISTS idx_policies_date ON policies(publish_date);
CREATE INDEX IF NOT EXISTS idx_policies_created ON policies(created_at);

-- 项目全过程管理表
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  code TEXT DEFAULT '',
  client_name TEXT DEFAULT '',
  client_contact TEXT DEFAULT '',
  client_phone TEXT DEFAULT '',
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planning',
  -- planning=立项中, active=执行中, paused=已暂停, completed=已完成, cancelled=已取消
  priority TEXT DEFAULT 'medium',
  -- low=低, medium=中, high=高, urgent=紧急
  phase TEXT DEFAULT 'initiation',
  -- initiation=启动, planning=规划, execution=执行, monitoring=监控, closing=收尾
  progress INTEGER DEFAULT 0,
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  actual_end_date TEXT DEFAULT '',
  budget REAL DEFAULT 0,
  spent REAL DEFAULT 0,
  manager TEXT DEFAULT '',
  manager_phone TEXT DEFAULT '',
  team_size INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  attachments TEXT DEFAULT '[]',
  remark TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_priority ON projects(priority);
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_name);
CREATE INDEX IF NOT EXISTS idx_projects_manager ON projects(manager);
CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at);

-- 项目里程碑表
CREATE TABLE IF NOT EXISTS project_milestones (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  -- pending=待开始, in_progress=进行中, done=已完成, skipped=已跳过
  sort_order INTEGER DEFAULT 0,
  planned_date TEXT DEFAULT '',
  actual_date TEXT DEFAULT '',
  deliverables TEXT DEFAULT '[]',
  remark TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pm_project ON project_milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_pm_status ON project_milestones(status);

-- 项目成员表
CREATE TABLE IF NOT EXISTS project_members (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  role TEXT DEFAULT 'developer',
  -- manager=项目经理, developer=开发, designer=设计, tester=测试, other=其他
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  responsibility TEXT DEFAULT '',
  join_date TEXT DEFAULT '',
  leave_date TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  -- active=在职, left=已离开
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pmem_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_pmem_status ON project_members(status);

-- 项目日报表
CREATE TABLE IF NOT EXISTS project_daily_reports (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL DEFAULT 0,
  member_id INTEGER DEFAULT 0,
  member_name TEXT DEFAULT '',
  report_date TEXT NOT NULL DEFAULT '',
  content TEXT DEFAULT '',
  progress INTEGER DEFAULT 0,
  issues TEXT DEFAULT '',
  plan TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  -- pending=待审核, approved=已通过, rejected=已驳回
  review_comment TEXT DEFAULT '',
  reviewed_by TEXT DEFAULT '',
  reviewed_at TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pdr_project ON project_daily_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_pdr_date ON project_daily_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_pdr_status ON project_daily_reports(status);

-- 项目审批表
CREATE TABLE IF NOT EXISTS project_approvals (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL DEFAULT 0,
  type TEXT DEFAULT 'other',
  -- budget=预算, timeline=周期, scope=范围, change=变更, other=其他
  title TEXT NOT NULL DEFAULT '',
  content TEXT DEFAULT '',
  requester TEXT DEFAULT '',
  requester_id INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  -- pending=待审批, approved=已通过, rejected=已驳回
  approver TEXT DEFAULT '',
  approver_comment TEXT DEFAULT '',
  approved_at TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pa_project ON project_approvals(project_id);
CREATE INDEX IF NOT EXISTS idx_pa_status ON project_approvals(status);
CREATE INDEX IF NOT EXISTS idx_pa_type ON project_approvals(type);

-- 政策订阅表
CREATE TABLE IF NOT EXISTS policy_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  levels TEXT DEFAULT '[]',
  categories TEXT DEFAULT '[]',
  keywords TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_policy_subs_user ON policy_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_policy_subs_status ON policy_subscriptions(status);

-- 政策推送记录表
CREATE TABLE IF NOT EXISTS policy_pushes (
  id INTEGER PRIMARY KEY,
  policy_id INTEGER NOT NULL DEFAULT 0,
  policy_title TEXT DEFAULT '',
  user_ids TEXT DEFAULT '[]',
  channel TEXT DEFAULT 'miniprogram',
  status TEXT DEFAULT 'sent',
  pushed_by TEXT DEFAULT '',
  read_at TEXT DEFAULT '',
  pushed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_policy_pushes_policy ON policy_pushes(policy_id);
CREATE INDEX IF NOT EXISTS idx_policy_pushes_channel ON policy_pushes(channel);
CREATE INDEX IF NOT EXISTS idx_policy_pushes_created ON policy_pushes(created_at);

-- 政策收藏表
CREATE TABLE IF NOT EXISTS policy_favorites (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  policy_id INTEGER NOT NULL DEFAULT 0,
  policy_title TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_policy_fav_user ON policy_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_policy_fav_policy ON policy_favorites(policy_id);

CREATE TABLE IF NOT EXISTS _seq (
  name TEXT PRIMARY KEY,
  next_val INTEGER DEFAULT 1
);
`;

// ==================== 初始化 ====================

function initDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  // 创建表结构
  db.exec(SCHEMA_SQL);
  db.exec(SEQ_SQL);
  
  // 检查是否需要从 JSON 迁移
  const tableCount = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='products'").get();
  
  if (tableCount.c > 0) {
    const productCount = db.prepare('SELECT count(*) as c FROM products').get();
    if (productCount.c === 0 && fs.existsSync(JSON_DB_PATH)) {
      console.log('📦 检测到 JSON 数据库，开始迁移到 SQLite...');
      migrateFromJSON();
      console.log('✅ JSON → SQLite 迁移完成');
    }
  }
  
  // 自动添加缺失的列（兼容已有数据库）
  const addColumnIfMissing = (table, column, type) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.find(c => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        console.log(`  ✅ 添加列: ${table}.${column}`);
      }
    } catch(e) { /* 列已存在或表不存在 */ }
  };
  addColumnIfMissing('contacts', 'stale_remind_sent', 'INTEGER DEFAULT 0');
  addColumnIfMissing('contacts', 'lead_stage', 'TEXT DEFAULT "new"');
  // partners 表新增列
  addColumnIfMissing('partners', 'remark', 'TEXT DEFAULT ""');
  
  // 确保默认管理员存在
  const adminCount = db.prepare('SELECT count(*) as c FROM admins').get();
  if (adminCount.c === 0) {
    db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run('admin', 'admin123');
  }
  
  // 确保默认优惠券存在
  const couponCount = db.prepare('SELECT count(*) as c FROM coupons').get();
  if (couponCount.c === 0) {
    const stmt = db.prepare(`INSERT INTO coupons (code, title, type, value, min_amount, max_discount, usage_limit, used_count, end_time, description, status) VALUES (@code, @title, @type, @value, @min_amount, @max_discount, @usage_limit, @used_count, @end_time, @description, @status)`);
    stmt.run({ code: 'NEW2026', title: '新用户专享优惠', type: 'fixed', value: 500, min_amount: 5000, max_discount: 0, usage_limit: 100, used_count: 0, end_time: '2026-12-31', description: '新用户首单立减500元', status: 'active' });
    stmt.run({ code: 'ERP5000', title: 'ERP方案大额优惠', type: 'fixed', value: 5000, min_amount: 30000, max_discount: 0, usage_limit: 20, used_count: 0, end_time: '2026-09-30', description: 'ERP系统订购满3万减5000', status: 'active' });
    stmt.run({ code: 'SAVE10', title: '限时9折优惠', type: 'percent', value: 10, min_amount: 10000, max_discount: 3000, usage_limit: 50, used_count: 0, end_time: '2026-06-30', description: '满1万享9折，最高减3000', status: 'active' });
  }
  
  // 确保默认推荐奖励存在
  const rewardCount = db.prepare('SELECT count(*) as c FROM referral_rewards').get();
  if (rewardCount.c === 0) {
    db.prepare(`INSERT INTO referral_rewards (name, description, reward_type, reward_value, min_clicks, min_conversions, conversion_type, max_reward_per_user, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('新人分享奖励', '成功邀请好友咨询，获得¥50优惠券', 'coupon', 50, 0, 1, 'contact', 0, 1);
    db.prepare(`INSERT INTO referral_rewards (name, description, reward_type, reward_value, min_clicks, min_conversions, conversion_type, max_reward_per_user, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('分销现金奖励', '成功邀请好友下单，获得订单金额5%现金奖励', 'cash', 5, 0, 1, 'order', 0, 1);
  }
  
  console.log('✅ SQLite 数据库初始化完成:', DB_PATH);
  console.log('✅ 默认管理员: admin / admin123');
}

// ==================== JSON → SQLite 迁移 ====================

function migrateFromJSON() {
  const jsonData = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
  
  // 迁移函数：将 JSON 数组插入到指定表（自动处理重复 ID）
  function migrateTable(tableName, rows, fieldMap) {
    if (!rows || rows.length === 0) return;
    
    const seenIds = new Set();
    let maxId = 0;
    let inserted = 0;
    
    for (const row of rows) {
      const mapped = fieldMap(row);
      
      // 处理重复 ID
      if (mapped.id !== undefined) {
        const origId = mapped.id;
        if (seenIds.has(origId)) {
          // 分配新 ID
          while (seenIds.has(maxId + 1)) maxId++;
          maxId++;
          mapped.id = maxId;
          console.log(`  ${tableName}: 重复 ID ${origId} → ${mapped.id}`);
        } else {
          maxId = Math.max(maxId, mapped.id);
        }
        seenIds.add(mapped.id);
      }
      
      const keys = Object.keys(mapped);
      const placeholders = keys.map(k => '@' + k).join(', ');
      const sql = `INSERT OR REPLACE INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders})`;
      try {
        db.prepare(sql).run(mapped);
        inserted++;
      } catch (e) {
        console.error(`  ${tableName} 迁移行失败:`, e.message, JSON.stringify(mapped).slice(0, 200));
      }
    }
    console.log(`  ${tableName}: ${inserted}/${rows.length} 条记录迁移完成`);
    
    // 更新序列
    if (maxId > 0) {
      db.prepare('INSERT OR REPLACE INTO _seq (name, next_val) VALUES (?, ?)').run(tableName, maxId + 1);
    }
  }
  
  // 产品
  migrateTable('products', jsonData.products || [], r => ({
    id: r.id, title: r.title || '', subtitle: r.subtitle || '', category: r.category || '',
    price: String(r.price || ''), price_unit: r.price_unit || '', image: r.image || '',
    tags: JSON.stringify(r.tags || []), highlights: JSON.stringify(r.highlights || []),
    cases: JSON.stringify(r.cases || []), description: r.description || '',
    features: r.features || '', sort_order: r.sort_order || 0,
    published: r.published !== undefined ? r.published : 1,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString()
  }));
  
  // 甲方产品
  migrateTable('client_products', jsonData.client_products || [], r => ({
    id: r.id, client_id: r.client_id || 0, client_name: r.client_name || '',
    title: r.title || '', subtitle: r.subtitle || '', category: r.category || '',
    price: String(r.price || ''), price_unit: r.price_unit || '', image: r.image || '',
    tags: JSON.stringify(r.tags || []), description: r.description || '',
    contact_phone: r.contact_phone || '', contact_wechat: r.contact_wechat || '',
    published: r.published !== undefined ? r.published : 1,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString()
  }));
  
  // 文章
  migrateTable('articles', jsonData.articles || [], r => ({
    id: r.id, title: r.title || '', subtitle: r.subtitle || '', cover: r.cover || '',
    category: r.category || '', tags: JSON.stringify(r.tags || []),
    summary: r.summary || '', content: r.content || '', author: r.author || '',
    source: r.source || '', views: r.views || 0,
    published: r.published !== undefined ? r.published : 0,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString()
  }));
  
  // 客户
  migrateTable('clients', jsonData.clients || [], r => ({
    id: r.id, name: r.name || '', short_name: r.short_name || '',
    industry: r.industry || '', avatar: r.avatar || '', cover: r.cover || '',
    description: r.description || '', qualifications: JSON.stringify(r.qualifications || []),
    team_size: r.team_size || '', founded: r.founded || '',
    wechat_account_id: r.wechat_account_id || '', contact_phone: r.contact_phone || '',
    contact_email: r.contact_email || '', address: r.address || '',
    website: r.website || '', published: r.published !== undefined ? r.published : 1,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString()
  }));
  
  // 订单
  migrateTable('orders', jsonData.orders || [], r => ({
    id: r.id, order_no: r.order_no, product_type: r.product_type || 'client_product',
    product_id: r.product_id || 0, product_title: r.product_title || '',
    amount: r.amount || 0, original_amount: r.original_amount || 0,
    discount_amount: r.discount_amount || 0, coupon_code: r.coupon_code || '',
    coupon_id: r.coupon_id || null, coupon_info: r.coupon_info || '',
    quantity: r.quantity || 1, buyer_name: r.buyer_name || '',
    buyer_phone: r.buyer_phone || '', buyer_openid: r.buyer_openid || '',
    user_id: r.user_id || null, remark: r.remark || '',
    status: r.status || 'pending', payment_method: r.payment_method || '',
    transaction_id: r.transaction_id || '', paid_at: r.paid_at,
    shipped_at: r.shipped_at, completed_at: r.completed_at,
    cancelled_at: r.cancelled_at, cancel_reason: r.cancel_reason || '',
    tracking_number: r.tracking_number || '', tracking_company: r.tracking_company || '',
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString()
  }));
  
  // 用户
  migrateTable('users', jsonData.users || [], r => ({
    id: r.id, openid: r.openid, nickname: r.nickname || '', avatar: r.avatar || '',
    phone: r.phone || '', is_admin: r.is_admin ? 1 : 0,
    disabled: r.disabled ? 1 : 0,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString(),
    last_login: r.last_login || null
  }));
  
  // 会话
  migrateTable('sessions', jsonData.sessions || [], r => ({
    token: r.token, openid: r.openid, user_id: r.user_id || null,
    created_at: r.created_at || new Date().toISOString(),
    expires_at: r.expires_at || null
  }));
  
  // 管理员
  migrateTable('admins', jsonData.admins || [], r => ({
    id: r.id, username: r.username, password: r.password
  }));
  
  // 联系/咨询
  migrateTable('contacts', jsonData.contacts || [], r => ({
    id: r.id, name: r.name || '', phone: r.phone || '', company: r.company || '',
    industry: r.industry || '', message: r.message || r.demand || '',
    demand: r.demand || r.message || '',
    status: r.status === 'pending' ? 'new' : (r.status === 'closed' ? 'lost' : r.status),
    lead_source: r.lead_source || 'website',
    lead_score: r.lead_score || 0,
    assigned_to: r.assigned_to || '',
    next_followup_date: r.next_followup_date || '',
    converted_at: r.converted_at || '',
    converted_order_id: r.converted_order_id || 0,
    lost_reason: r.lost_reason || '',
    template_msg_sent: r.template_msg_sent ? 1 : 0,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString()
  }));

  // 线索跟进记录
  migrateTable('lead_notes', jsonData.lead_notes || [], r => ({
    id: r.id, contact_id: r.contact_id, note_type: r.note_type || 'note',
    content: r.content || '', author: r.author || '',
    next_followup_date: r.next_followup_date || '',
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 入驻申请
  migrateTable('onboardings', jsonData.onboardings || [], r => ({
    id: r.id, company_name: r.company_name || '', contact_person: r.contact_person || '',
    phone: r.phone || '', email: r.email || '', industry: r.industry || '',
    product_name: r.product_name || '', product_desc: r.product_desc || '',
    status: r.status || 'pending',
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString()
  }));
  
  // 微信公众号
  migrateTable('wechat_accounts', jsonData.wechat_accounts || [], r => ({
    id: r.id, name: r.name || '', wechat_id: r.wechat_id || '',
    type: r.type || 'our', description: r.description || '',
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 推送历史
  migrateTable('push_history', jsonData.push_history || [], r => ({
    id: r.id, article_id: r.article_id || null, article_title: r.article_title || '',
    account_id: r.account_id || null, account_name: r.account_name || '',
    media_id: r.media_id || '', status: r.status || 'simulated',
    pushed_at: r.pushed_at || new Date().toISOString()
  }));
  
  // 通知
  migrateTable('notifications', jsonData.notifications || [], r => ({
    id: r.id, type: r.type || 'system', title: r.title || '',
    content: r.content || '', target_phones: JSON.stringify(r.target_phones || []),
    link_type: r.link_type || '', link_id: r.link_id || '',
    icon: r.icon || '',
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 优惠券
  migrateTable('coupons', jsonData.coupons || [], r => ({
    id: r.id, code: r.code, title: r.title || '', type: r.type || 'fixed',
    value: r.value || 0, min_amount: r.min_amount || 0,
    max_discount: r.max_discount || 0, usage_limit: r.usage_limit || 0,
    used_count: r.used_count || 0, start_time: r.start_time || null,
    end_time: r.end_time || null, description: r.description || '',
    status: r.status || 'active',
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 用户优惠券
  migrateTable('user_coupons', jsonData.user_coupons || [], r => ({
    id: r.id, coupon_id: r.coupon_id, openid: r.openid,
    phone: r.phone || '', code: r.code || '', title: r.title || '',
    type: r.type || '', value: r.value || 0, min_amount: r.min_amount || 0,
    max_discount: r.max_discount || 0, end_time: r.end_time || null,
    status: r.status || 'unused',
    claimed_at: r.claimed_at || new Date().toISOString(),
    used_at: r.used_at || null, remind_sent: r.remind_sent ? 1 : 0
  }));
  
  // 评价
  migrateTable('reviews', jsonData.reviews || [], r => ({
    id: r.id, product_type: r.product_type || 'client_product',
    product_id: r.product_id || 0, openid: r.openid || '',
    user_id: r.user_id || null, rating: r.rating || 5,
    content: r.content || '', images: JSON.stringify(r.images || []),
    reply: r.reply || '', replied_at: r.replied_at || null,
    published: r.published !== undefined ? r.published : 1,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString()
  }));
  
  // 分享
  migrateTable('shares', jsonData.shares || [], r => ({
    id: r.id, share_code: r.share_code || '', openid: r.openid || '',
    user_id: r.user_id || null, product_type: r.product_type || '',
    product_id: r.product_id || 0, product_title: r.product_title || '',
    share_channel: r.share_channel || '',
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 分享点击
  migrateTable('share_clicks', jsonData.share_clicks || [], r => ({
    id: r.id, share_id: r.share_id, visitor_openid: r.visitor_openid || '',
    visitor_ip: r.visitor_ip || '', user_agent: r.user_agent || '',
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 推荐奖励
  migrateTable('referral_rewards', jsonData.referral_rewards || [], r => ({
    id: r.id, name: r.name || '', description: r.description || '',
    reward_type: r.reward_type || 'coupon', reward_value: r.reward_value || 0,
    coupon_id: r.coupon_id || null, min_clicks: r.min_clicks || 0,
    min_conversions: r.min_conversions || 1, conversion_type: r.conversion_type || 'contact',
    max_reward_per_user: r.max_reward_per_user || 0,
    start_date: r.start_date || null, end_date: r.end_date || null,
    enabled: r.enabled !== undefined ? r.enabled : 1,
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 用户奖励
  migrateTable('user_rewards', jsonData.user_rewards || [], r => ({
    id: r.id, openid: r.openid || '', user_id: r.user_id || null,
    reward_id: r.reward_id, reward_type: r.reward_type || '',
    reward_value: r.reward_value || 0, status: r.status || 'pending',
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 客服会话
  migrateTable('cs_conversations', jsonData.cs_conversations || [], r => ({
    id: r.id, openid: r.openid || '', user_id: r.user_id || null,
    status: r.status || 'active', last_message: r.last_message || '',
    last_message_at: r.last_message_at || null,
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 客服消息
  migrateTable('cs_messages', jsonData.cs_messages || [], r => ({
    id: r.id, conversation_id: r.conversation_id || null,
    openid: r.openid || r.from_user || '', from_user: r.from_user || '',
    direction: r.direction || 'user_to_service', message_type: r.message_type || 'text',
    content: r.content || '', handled: r.handled ? 1 : 0,
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 模板消息日志
  migrateTable('template_msg_logs', jsonData.template_msg_logs || [], r => ({
    id: r.id, openid: r.openid || '', template_id: r.template_id || '',
    data: JSON.stringify(r.data || {}), status: r.status || 'pending',
    error_msg: r.error_msg || '',
    created_at: r.created_at || new Date().toISOString()
  }));
  
  // 痛点
  migrateTable('pain_points', jsonData.pain_points || [], r => ({
    id: String(r.id), title: r.title || '', icon: r.icon || '',
    description: r.description || '', solutions: JSON.stringify(r.solutions || []),
    effects: JSON.stringify(r.effects || []),
    published: r.published !== undefined ? r.published : 1,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString()
  }));
  
  // 行业
  migrateTable('industries', jsonData.industries || [], r => ({
    id: String(r.id), name: r.name || '', icon: r.icon || '',
    description: r.description || '', cover: r.cover || '',
    published: r.published !== undefined ? r.published : 1,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString()
  }));
  
  // 迁移通知已读记录
  if (jsonData.notification_reads) {
    for (const [phone, ids] of Object.entries(jsonData.notification_reads)) {
      if (Array.isArray(ids)) {
        for (const nid of ids) {
          try {
            db.prepare('INSERT OR IGNORE INTO notification_reads (phone, notification_id) VALUES (?, ?)').run(phone, nid);
          } catch (e) {}
        }
      }
    }
    console.log('  notification_reads: 迁移完成');
  }
  
  // 更新序列
  if (jsonData._nextId) {
    for (const [name, val] of Object.entries(jsonData._nextId)) {
      try {
        db.prepare('INSERT OR REPLACE INTO _seq (name, next_val) VALUES (?, ?)').run(name, val);
      } catch (e) {}
    }
    console.log('  _seq: 序列迁移完成');
  }
}

// ==================== 兼容接口 ====================

/**
 * 获取 SQLite 实例
 */
function getDB() {
  if (!db) initDB();
  return db;
}

/**
 * 获取下一个自增 ID（兼容原有 nextId 接口）
 */
function nextId(table) {
  const d = getDB();
  // 先尝试从序列表获取
  const seq = d.prepare('SELECT next_val FROM _seq WHERE name = ?').get(table);
  if (seq) {
    d.prepare('UPDATE _seq SET next_val = next_val + 1 WHERE name = ?').run(table);
    return seq.next_val;
  }
  // 回退：从表中取最大 ID + 1
  try {
    const max = d.prepare(`SELECT MAX(id) as m FROM ${table}`).get();
    const next = (max.m || 0) + 1;
    d.prepare('INSERT INTO _seq (name, next_val) VALUES (?, ?)').run(table, next + 1);
    return next;
  } catch (e) {
    // 表可能不存在或无 id 列，使用时间戳
    return Date.now();
  }
}

/**
 * 保存（SQLite 自动持久化，此函数保留为空以兼容旧接口）
 */
function save() {
  // SQLite WAL 模式下写操作自动持久化
}

/**
 * 关闭数据库连接
 */
function closeDB() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { initDB, getDB, nextId, save, closeDB };
