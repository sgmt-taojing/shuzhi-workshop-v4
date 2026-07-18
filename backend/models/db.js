/**
 * 数据库访问层（SQLite）
 * 
 * 从 JSON 文件存储迁移到 SQLite（better-sqlite3）。
 * 
 * 核心设计：
 * - db.products 返回普通数组（从 SQLite 加载）
 * - 修改数组元素后，调用 syncRow(table, item) 写回
 * - push/splice 等数组操作自动写回数据库
 * - save() 兼容旧代码（空操作或全量同步）
 * 
 * 数据库文件：backend/data/dt-mall.db
 */

const sqliteDB = require('./sqlite-db');

// ==================== 表名映射 ====================

const TABLE_MAP = {
  products: 'products',
  client_products: 'client_products',
  articles: 'articles',
  clients: 'clients',
  orders: 'orders',
  users: 'users',
  sessions: 'sessions',
  admins: 'admins',
  contacts: 'contacts',
  lead_notes: 'lead_notes',
  onboardings: 'onboardings',
  wechat_accounts: 'wechat_accounts',
  push_history: 'push_history',
  notifications: 'notifications',
  coupons: 'coupons',
  user_coupons: 'user_coupons',
  reviews: 'reviews',
  shares: 'shares',
  share_clicks: 'share_clicks',
  referral_rewards: 'referral_rewards',
  user_rewards: 'user_rewards',
  cs_conversations: 'cs_conversations',
  cs_messages: 'cs_messages',
  template_msg_logs: 'template_msg_logs',
  pain_points: 'pain_points',
  industries: 'industries',
  follow_relations: 'follow_relations',
  feedbacks: 'feedbacks',
  bookings: 'bookings',
  booking_slots: 'booking_slots',
  user_points: 'user_points',
  point_records: 'point_records',
  point_tasks: 'point_tasks',
  point_rewards: 'point_rewards',
  point_redemptions: 'point_redemptions',
  user_events: 'user_events',
  subscribe_templates: 'subscribe_templates',
  subscribe_authorizations: 'subscribe_authorizations',
  subscribe_msg_logs: 'subscribe_msg_logs',
  assessments: 'assessments',
  audit_logs: 'audit_logs',
  quotes: 'quotes',
  service_milestones: 'service_milestones',
  banners: 'banners',
  faq_categories: 'faq_categories',
  faqs: 'faqs',
  invoices: 'invoices',
  tickets: 'tickets',
  ticket_replies: 'ticket_replies',
  partners: 'partners',
  referrals: 'referrals',
  commission_records: 'commission_records',
  withdrawals: 'withdrawals',
  chatbot_sessions: 'chatbot_sessions',
  chatbot_messages: 'chatbot_messages',
  chatbot_stats: 'chatbot_stats',
  contract_templates: 'contract_templates',
  contracts: 'contracts',
  campaigns: 'campaigns',
  campaign_records: 'campaign_records',
  policies: 'policies',
  policy_subscriptions: 'policy_subscriptions',
  policy_pushes: 'policy_pushes',
  policy_favorites: 'policy_favorites',
  projects: 'projects',
  project_milestones: 'project_milestones',
  project_members: 'project_members',
  project_daily_reports: 'project_daily_reports',
  project_approvals: 'project_approvals',
  enterprise_profiles: 'enterprise_profiles',
  enterprise_certificates: 'enterprise_certificates',
  service_demands: 'service_demands',
  service_offers: 'service_offers',
  service_matches: 'service_matches',
  product_articles: 'product_articles',
  customer_wechat_accounts: 'customer_wechat_accounts',
  weekly_star_clients: 'weekly_star_clients',
  joint_campaigns: 'joint_campaigns',
  traffic_records: 'traffic_records',
  product_skus: 'product_skus',
  cart_items: 'cart_items',
  order_refunds: 'order_refunds',
  charity_orgs: 'charity_orgs',
  charity_certificates: 'charity_certificates',
  group_buyers: 'group_buyers',
  group_buys: 'group_buys',
  group_buy_orders: 'group_buy_orders',
  product_endorsements: 'product_endorsements',
  agents: 'agents',
  agent_leads: 'agent_leads',
  agent_commissions: 'agent_commissions',
  agent_product_push: 'agent_product_push',
  delivery_tracking: 'delivery_tracking',
  delivery_phases: 'delivery_phases',
  enterprise_services: 'enterprise_services',
  maintenance_tickets: 'maintenance_tickets',
  service_providers: 'service_providers',
  provider_products: 'provider_products',
  fund_pools: 'fund_pools',
  ai_diagnoses: 'ai_diagnoses',
  roles: 'roles',
  user_roles: 'user_roles',
  acceptance_checkins: 'acceptance_checkins',
  template_messages: 'template_messages',
  brand_galleries: 'brand_galleries',
  system_config: 'system_config',
  admin_sessions: 'admin_sessions',
  h5_users: 'h5_users',
  h5_sessions: 'h5_sessions',
  analytics_snapshots: 'analytics_snapshots',
  client_onboarding: 'client_onboarding',
  marketing_materials: 'marketing_materials',
  sales_funnel: 'sales_funnel'
};

// 需要 JSON 序列化的字段
const JSON_FIELDS = {
  products: ['tags', 'highlights', 'cases'],
  client_products: ['tags'],
  articles: ['tags'],
  clients: ['qualifications'],
  notifications: ['target_phones'],
  reviews: ['images'],
  template_msg_logs: ['data'],
  feedbacks: ['images'],
  point_records: [],
  user_events: ['extra'],
  subscribe_templates: ['fields'],
  subscribe_authorizations: [],
  subscribe_msg_logs: ['data'],
  lead_notes: [],
  assessments: ['answers', 'dimension_scores', 'recommendations'],
  quotes: ['modules'],
  service_milestones: ['deliverables'],
  banners: ['link_params'],
  faq_categories: [],
  faqs: ['tags'],
  invoices: [],
  tickets: ['attachments'],
  ticket_replies: ['attachments'],
  partners: [],
  referrals: [],
  commission_records: [],
  withdrawals: ['account_info'],
  chatbot_sessions: [],
  chatbot_messages: ['matched_faq', 'matched_products', 'suggestions'],
  chatbot_stats: [],
  contract_templates: ['clauses', 'variables'],
  contracts: ['clauses', 'attachments'],
  campaigns: ['rules', 'applicable_products', 'applicable_categories'],
  campaign_records: [],
  policies: ['key_points', 'applicable_industries', 'support_measures', 'attachments', 'tags'],
  policy_subscriptions: ['levels', 'categories', 'keywords'],
  policy_pushes: ['user_ids'],
  policy_favorites: [],
  projects: ['tags', 'attachments'],
  project_milestones: ['deliverables'],
  project_members: [],
  project_daily_reports: [],
  project_approvals: [],
  enterprise_profiles: ['capability_tags', 'industry_tags', 'service_tags', 'radar_scores', 'badges'],
  enterprise_certificates: [],
  service_demands: ['requirements'],
  service_offers: ['capabilities', 'cases'],
  service_matches: ['match_reasons'],
  product_articles: ['cta_config', 'wechat_format'],
  customer_wechat_accounts: ['follower_profile'],
  weekly_star_clients: ['featured_products'],
  joint_campaigns: ['participants', 'metrics'],
  traffic_records: [],
  product_skus: ['specs'],
  cart_items: [],
  order_refunds: [],
  charity_orgs: [],
  charity_certificates: [],
  group_buyers: [],
  group_buys: ['tags'],
  group_buy_orders: [],
  product_endorsements: [],
  agents: [],
  agent_leads: [],
  agent_commissions: [],
  agent_product_push: ['materials'],
  delivery_tracking: ['phases_data'],
  delivery_phases: ['deliverables'],
  enterprise_services: [],
  maintenance_tickets: [],
  service_providers: [],
  provider_products: [],
  fund_pools: [],
  ai_diagnoses: ['diagnosis_result','recommended_products'],
  roles: ['permissions'],
  user_roles: [],
  acceptance_checkins: [],
  template_messages: [],
  brand_galleries: ['products','achievements'],
  system_config: [],
  admin_sessions: [],
  h5_users: [],
  h5_sessions: [],
  analytics_snapshots: ['metrics'],
  client_onboarding: [],
  marketing_materials: [],
  sales_funnel: []
};

// ==================== 加载表数据 ====================

function loadTable(tableName) {
  const db = sqliteDB.getDB();
  try {
    const rows = db.prepare(`SELECT * FROM ${tableName}`).all();
    const jsonFields = JSON_FIELDS[tableName] || [];
    for (const row of rows) {
      for (const f of jsonFields) {
        if (row[f] !== null && row[f] !== undefined) {
          try { row[f] = JSON.parse(row[f]); } catch { row[f] = []; }
        } else {
          row[f] = [];
        }
      }
    }
    return rows;
  } catch (e) {
    console.error(`loadTable(${tableName}) error:`, e.message);
    return [];
  }
}

/**
 * 创建一个带有数据库写回能力的数组
 * 该数组从 SQLite 加载数据，push/splice 自动写回
 */
function createTableArray(tableName) {
  const arr = loadTable(tableName);
  const jsonFields = JSON_FIELDS[tableName] || [];
  
  // 重写 push：写入数据库并刷新
  arr.push = function(item) {
    insertRow(tableName, item);
    // 重新加载
    const fresh = loadTable(tableName);
    this.length = 0;
    fresh.forEach(r => Array.prototype.push.call(this, r));
    return this.length;
  };
  
  // 重写 unshift
  arr.unshift = function(item) {
    return this.push(item);
  };
  
  // 重写 splice：支持删除和插入
  arr.splice = function(start, deleteCount, ...items) {
    const db = sqliteDB.getDB();
    const len = this.length;
    const actualStart = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const actualDeleteCount = Math.min(Math.max(deleteCount || 0, 0), len - actualStart);
    
    const removed = [];
    for (let i = actualStart; i < actualStart + actualDeleteCount; i++) {
      removed.push(this[i]);
      if (this[i] && this[i].id !== undefined) {
        try {
          db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(
            typeof this[i].id === 'number' ? this[i].id : String(this[i].id)
          );
        } catch (e) {
          console.error(`splice delete error (${tableName}):`, e.message);
        }
      }
    }
    
    // 插入新项
    for (const item of items) {
      insertRow(tableName, item);
    }
    
    // 重新加载
    const fresh = loadTable(tableName);
    this.length = 0;
    fresh.forEach(r => Array.prototype.push.call(this, r));
    return removed;
  };
  
  return arr;
}

// ==================== DB 代理对象 ====================

const _cache = {};

function getDB() {
  return new Proxy({}, {
    get(target, prop) {
      // notification_reads：key-value 结构
      if (prop === 'notification_reads') {
        const db = sqliteDB.getDB();
        const rows = db.prepare('SELECT phone, notification_id FROM notification_reads').all();
        const map = {};
        for (const r of rows) {
          if (!map[r.phone]) map[r.phone] = [];
          map[r.phone].push(r.notification_id);
        }
        return map;
      }
      
      // _nextId：序列映射
      if (prop === '_nextId') {
        const db = sqliteDB.getDB();
        const rows = db.prepare('SELECT name, next_val FROM _seq').all();
        const map = {};
        for (const r of rows) {
          map[r.name] = r.next_val;
        }
        return map;
      }
      
      if (TABLE_MAP[prop]) {
        // 每次访问都返回最新数据（不缓存，确保一致性）
        return createTableArray(TABLE_MAP[prop]);
      }
      
      return undefined;
    },
    set(target, prop, value) {
      // db.orders = [...] 模式：全量替换
      if (TABLE_MAP[prop] && Array.isArray(value)) {
        const db = sqliteDB.getDB();
        const tableName = TABLE_MAP[prop];
        const jsonFields = JSON_FIELDS[prop] || [];
        
        db.prepare(`DELETE FROM ${tableName}`).run();
        for (const item of value) {
          const keys = Object.keys(item).filter(k => item[k] !== undefined);
          const values = {};
          for (const k of keys) {
            let v = item[k];
            if (jsonFields.includes(k) && typeof v !== 'string') {
              v = JSON.stringify(v || []);
            }
            values[k] = v;
          }
          const placeholders = keys.map(k => '@' + k).join(', ');
          db.prepare(`INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders})`).run(values);
        }
        return true;
      }
      return true;
    }
  });
}

function initDB() {
  sqliteDB.initDB();
}

function save() {
  // SQLite 自动持久化
  // 旧代码模式：Object.assign(item, ...) + save()
  // 在新模式下：Object.assign(item, ...) + syncRow(table, item)
  // save() 为空操作，兼容旧代码不报错
}

function nextId(table) {
  return sqliteDB.nextId(table);
}

function closeDB() {
  sqliteDB.closeDB();
}

// ==================== 工具函数 ====================

/**
 * 更新单行数据
 */
function updateRow(table, where, updates) {
  const db = sqliteDB.getDB();
  const jsonFields = JSON_FIELDS[table] || [];
  const setClauses = [];
  const values = {};
  
  for (const [k, v] of Object.entries(updates)) {
    if (k === 'id') continue;
    let val = v;
    if (jsonFields.includes(k) && typeof v !== 'string') {
      val = JSON.stringify(v || []);
    }
    setClauses.push(`${k} = @set_${k}`);
    values[`set_${k}`] = val;
  }
  
  setClauses.push("updated_at = datetime('now')");
  
  const whereClauses = [];
  for (const [k, v] of Object.entries(where)) {
    whereClauses.push(`${k} = @w_${k}`);
    values[`w_${k}`] = v;
  }
  
  const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;
  return db.prepare(sql).run(values);
}

/**
 * 删除行
 */
function deleteRows(table, where) {
  const db = sqliteDB.getDB();
  const whereClauses = [];
  const values = {};
  
  for (const [k, v] of Object.entries(where)) {
    whereClauses.push(`${k} = @w_${k}`);
    values[`w_${k}`] = v;
  }
  
  const sql = `DELETE FROM ${table} WHERE ${whereClauses.join(' AND ')}`;
  return db.prepare(sql).run(values);
}

/**
 * 插入行
 */
function insertRow(table, data) {
  const db = sqliteDB.getDB();
  const jsonFields = JSON_FIELDS[table] || [];
  const keys = Object.keys(data).filter(k => data[k] !== undefined);
  const values = {};
  
  for (const k of keys) {
    let v = data[k];
    if (jsonFields.includes(k) && typeof v !== 'string') {
      v = JSON.stringify(v || []);
    }
    values[k] = v;
  }
  
  const placeholders = keys.map(k => '@' + k).join(', ');
  const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  return db.prepare(sql).run(values);
}

/**
 * 同步修改后的对象到数据库
 * 用于 Object.assign(item, ...) + save() 模式的替代
 * @param {string} table - 表名
 * @param {object} obj - 被修改的对象（必须包含 id 字段）
 */
function syncRow(table, obj) {
  if (!obj || obj.id === undefined) return;
  const db = sqliteDB.getDB();
  const jsonFields = JSON_FIELDS[table] || [];
  
  // 获取表中所有列名
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const colNames = cols.map(c => c.name).filter(n => n !== 'id');
  
  const setClauses = [];
  const values = {};
  
  for (const c of colNames) {
    let v = obj[c] !== undefined ? obj[c] : null;
    if (jsonFields.includes(c) && typeof v !== 'string') {
      v = JSON.stringify(v || []);
    }
    setClauses.push(`${c} = @${c}`);
    values[c] = v;
  }
  
  values.id = obj.id;
  
  const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = @id`;
  return db.prepare(sql).run(values);
}

module.exports = { 
  initDB, 
  getDB, 
  save, 
  nextId, 
  closeDB,
  updateRow,
  deleteRows,
  insertRow,
  syncRow,
  getRawDB: () => sqliteDB.getDB()
};
