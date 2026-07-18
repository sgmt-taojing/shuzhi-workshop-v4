/**
 * 数造工坊 - 分享裂变追踪模型（JSON 文件数据库版本）
 * 追踪用户分享行为、点击转化、分销奖励
 */

const db = require('./db');
const { syncRow } = require('./db');
const { v4: uuidv4 } = require('uuid');

// ===================== 分享记录（shares） =====================

function createShare({ sharer_openid, sharer_name, page_path, page_title, page_type, target_id, target_title, share_scene }) {
  const data = db.getDB();
  const id = db.nextId('shares');
  const share_id = uuidv4().replace(/-/g, '').slice(0, 16); // 短ID用于分享链接
  const now = new Date().toISOString();
  
  const share = {
    id,
    sharer_openid: sharer_openid || '',
    sharer_name: sharer_name || '',
    page_path: page_path || '',
    page_title: page_title || '',
    page_type: page_type || '',
    target_id: target_id || 0,
    target_title: target_title || '',
    share_scene: share_scene || 0,
    share_id,
    clicked_count: 0,
    converted_count: 0,
    reward_amount: 0,
    reward_status: 'pending',
    created_at: now,
    updated_at: now
  };
  
  data.shares.push(share);
  // db.save() not needed - push auto-writes to SQLite
  return share;
}

function getShareByShareId(share_id) {
  const data = db.getDB();
  return data.shares.find(s => s.share_id === share_id) || null;
}

function getSharesByOpenid(openid, page = 1, limit = 20) {
  const data = db.getDB();
  const userShares = data.shares
    .filter(s => s.sharer_openid === openid)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  const offset = (page - 1) * limit;
  return {
    list: userShares.slice(offset, offset + limit),
    total: userShares.length,
    page,
    limit
  };
}

function incrementShareClick(share_id) {
  const data = db.getDB();
  const share = data.shares.find(s => s.share_id === share_id);
  if (share) {
    share.clicked_count = (share.clicked_count || 0) + 1;
    share.updated_at = new Date().toISOString();
    syncRow('shares', share);
  }
  return share;
}

function incrementShareConversion(share_id, conversion_type, conversion_id) {
  const data = db.getDB();
  const share = data.shares.find(s => s.share_id === share_id);
  if (share) {
    share.converted_count = (share.converted_count || 0) + 1;
    share.updated_at = new Date().toISOString();
    syncRow('shares', share);
    
    // 检查是否满足奖励条件
    checkAndIssueReward(share.sharer_openid, share_id, conversion_type);
  }
  return share;
}

function getShareStats(openid) {
  const data = db.getDB();
  const userShares = data.shares.filter(s => s.sharer_openid === openid);
  
  const total_shares = userShares.length;
  const total_clicks = userShares.reduce((sum, s) => sum + (s.clicked_count || 0), 0);
  const total_conversions = userShares.reduce((sum, s) => sum + (s.converted_count || 0), 0);
  const total_reward = userShares.reduce((sum, s) => sum + (s.reward_amount || 0), 0);
  
  // 按页面类型统计
  const by_type = {};
  userShares.forEach(s => {
    if (!by_type[s.page_type]) {
      by_type[s.page_type] = { shares: 0, clicks: 0, conversions: 0 };
    }
    by_type[s.page_type].shares++;
    by_type[s.page_type].clicks += (s.clicked_count || 0);
    by_type[s.page_type].conversions += (s.converted_count || 0);
  });
  
  return { total_shares, total_clicks, total_conversions, total_reward, by_type };
}

// ===================== 分享点击记录（share_clicks） =====================

function createShareClick({ share_id, clicker_openid, clicker_ip, user_agent, referrer, scene }) {
  const data = db.getDB();
  const id = db.nextId('share_clicks');
  const now = new Date().toISOString();
  
  const click = {
    id,
    share_id,
    clicker_openid: clicker_openid || '',
    clicker_ip: clicker_ip || '',
    user_agent: user_agent || '',
    referrer: referrer || '',
    scene: scene || 0,
    converted: 0,
    converted_at: null,
    conversion_type: '',
    conversion_id: 0,
    created_at: now
  };
  
  data.share_clicks.push(click);
  // db.save() not needed - push auto-writes
  
  // 增加分享的点击计数
  incrementShareClick(share_id);
  
  return click;
}

function markClickConverted(click_id, conversion_type, conversion_id) {
  const data = db.getDB();
  const click = data.share_clicks.find(c => c.id === click_id);
  if (click) {
    click.converted = 1;
    click.converted_at = new Date().toISOString();
    click.conversion_type = conversion_type || '';
    click.conversion_id = conversion_id || 0;
    syncRow('share_clicks', click);
    
    // 增加分享的转化计数
    incrementShareConversion(click.share_id, conversion_type, conversion_id);
  }
  return click;
}

// ===================== 分销奖励配置（referral_rewards） =====================

function getActiveRewards() {
  const data = db.getDB();
  const now = new Date().toISOString();
  return data.referral_rewards.filter(r => {
    if (!r.enabled) return false;
    if (r.start_date && r.start_date > now) return false;
    if (r.end_date && r.end_date < now) return false;
    return true;
  });
}

function getRewardById(reward_id) {
  const data = db.getDB();
  return data.referral_rewards.find(r => r.id === reward_id) || null;
}

// ===================== 用户奖励记录（user_rewards） =====================

function checkAndIssueReward(openid, share_id, conversion_type) {
  if (!openid) return null;
  
  const rewards = getActiveRewards();
  const data = db.getDB();
  
  for (const reward of rewards) {
    // 检查转化类型是否匹配
    if (reward.conversion_type && reward.conversion_type !== conversion_type) continue;
    
    // 检查用户是否已达成条件（点击数、转化数）
    const userShares = data.shares.filter(s => s.sharer_openid === openid);
    const totalClicks = userShares.reduce((sum, s) => sum + (s.clicked_count || 0), 0);
    const totalConversions = userShares.reduce((sum, s) => sum + (s.converted_count || 0), 0);
    
    if (reward.min_clicks > totalClicks) continue;
    if (reward.min_conversions > totalConversions) continue;
    
    // 检查每用户最高奖励次数
    if (reward.max_reward_per_user > 0) {
      const userRewardCount = data.user_rewards.filter(
        r => r.user_openid === openid && r.reward_id === reward.id
      ).length;
      if (userRewardCount >= reward.max_reward_per_user) continue;
    }
    
    // 发放奖励
    return issueReward(openid, share_id, reward);
  }
  
  return null;
}

function issueReward(openid, share_id, reward) {
  const data = db.getDB();
  const id = db.nextId('user_rewards');
  const now = new Date().toISOString();
  
  // 计算过期时间（30天后）
  const expire_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  
  const userReward = {
    id,
    user_openid: openid,
    share_id: share_id || '',
    reward_id: reward.id,
    reward_type: reward.reward_type,
    reward_value: reward.reward_value,
    coupon_code: '',
    status: 'issued',
    issued_at: now,
    used_at: null,
    expire_at
  };
  
  // 如果是优惠券类型，生成优惠券码
  if (reward.reward_type === 'coupon') {
    userReward.coupon_code = 'REF' + Date.now().toString(36).toUpperCase();
    // 这里可以调用优惠券系统的API来创建优惠券
  }
  
  data.user_rewards.push(userReward);
  
  // 更新分享记录的奖励金额
  if (share_id) {
    const share = data.shares.find(s => s.share_id === share_id);
    if (share) {
      share.reward_amount = (share.reward_amount || 0) + reward.reward_value;
      syncRow('shares', share);
    }
  }
  // db.save() not needed - push + syncRow auto-writes
  
  // 发送通知给用户
  notifyUserReward(openid, userReward);
  
  return userReward;
}

function getUserRewards(openid, page = 1, limit = 20) {
  const data = db.getDB();
  const rewards = data.user_rewards
    .filter(r => r.user_openid === openid)
    .sort((a, b) => new Date(b.issued_at) - new Date(a.issued_at));
  
  const offset = (page - 1) * limit;
  return {
    list: rewards.slice(offset, offset + limit),
    total: rewards.length,
    page,
    limit
  };
}

function notifyUserReward(openid, reward) {
  // 创建通知记录
  const data = db.getDB();
  if (!data.notifications) data.notifications = [];
  
  const notification = {
    id: db.nextId('notifications'),
    user_openid: openid,
    type: 'reward',
    title: '🎁 分享奖励到账',
    content: `恭喜！您获得${reward.reward_type === 'coupon' ? '优惠券' : '现金'}奖励¥${reward.reward_value}`,
    read: 0,
    created_at: new Date().toISOString()
  };
  
  data.notifications.push(notification);
  // db.save() not needed - push auto-writes
}

module.exports = {
  createShare,
  getShareByShareId,
  getSharesByOpenid,
  incrementShareClick,
  incrementShareConversion,
  getShareStats,
  createShareClick,
  markClickConverted,
  getActiveRewards,
  getRewardById,
  checkAndIssueReward,
  issueReward,
  getUserRewards
};
