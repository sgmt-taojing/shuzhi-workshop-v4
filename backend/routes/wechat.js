const { getDB, nextId, save, syncRow, deleteRows } = require('../models/db');
const router = require('express').Router();

// 获取微信access_token（真实API模式）
async function getAccessToken() {
  const appId = process.env.WECHAT_APPID;
  const appSecret = process.env.WECHAT_SECRET;
  if (!appId || !appSecret) return null;
  try {
    const res = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`);
    const data = await res.json();
    return data.access_token || null;
  } catch { return null; }
}

// POST /api/wechat/push-article - 推送文章到公众号草稿箱
router.post('/push-article', async (req, res) => {
  const { article_id, wechat_account_id } = req.body;
  const db = getDB();
  const article = (db.articles || []).find(a => a.id === Number(article_id));
  if (!article) return res.status(404).json({ error: '文章不存在' });

  const account = wechat_account_id
    ? (db.wechat_accounts || []).find(a => a.id === Number(wechat_account_id))
    : (db.wechat_accounts || []).find(a => a.type === 'our');

  const accessToken = await getAccessToken();
  let media_id, status;

  if (accessToken) {
    // 真实微信API调用
    try {
      const draftRes = await fetch(`https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          articles: [{
            title: article.title,
            author: account?.name || '数造工坊',
            digest: article.summary || '',
            content: article.content || '',
            content_source_url: article.officialUrl || '',
            thumb_media_id: '', // 需要预先上传封面图
            need_open_comment: 0,
            only_fans_can_comment: 0
          }]
        })
      });
      const draftData = await draftRes.json();
      if (draftData.media_id) {
        media_id = draftData.media_id;
        status = 'pushed';
      } else {
        media_id = `draft_${Date.now()}`;
        status = 'simulated';
      }
    } catch {
      media_id = `draft_${Date.now()}`;
      status = 'simulated';
    }
  } else {
    // 模拟模式
    media_id = `draft_${Date.now()}`;
    status = 'simulated';
  }

  // 记录推送历史
  const history = {
    id: nextId('push_history'),
    article_id: article.id,
    article_title: article.title,
    account_id: account?.id || null,
    account_name: account?.name || '默认',
    media_id,
    status,
    pushed_at: new Date().toISOString()
  };
  if (!db.push_history) db.push_history = [];
  db.push_history.push(history);
  // save() not needed - push auto-writes

  res.json({ media_id, message: status === 'pushed' ? '文章已推送到公众号草稿箱' : '文章已模拟推送到公众号（未配置微信API）', status });
});

// POST /api/wechat/publish-draft - 发布草稿
router.post('/publish-draft', async (req, res) => {
  const { media_id } = req.body;
  const accessToken = await getAccessToken();
  if (accessToken) {
    try {
      const pubRes = await fetch(`https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=${accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_id })
      });
      const pubData = await pubRes.json();
      if (pubData.errcode === 0) {
        return res.json({ message: '草稿已提交发布', publish_id: pubData.publish_id });
      }
    } catch {}
  }
  // 模拟模式
  const db = getDB();
  const record = (db.push_history || []).find(h => h.media_id === media_id);
  if (record) {
    record.status = 'published';
    syncRow('push_history', record);
  }
  res.json({ message: '草稿已模拟发布（未配置微信API）', status: 'simulated' });
});

// GET /api/wechat/accounts - 公众号列表
router.get('/accounts', (req, res) => {
  const db = getDB();
  res.json(db.wechat_accounts || []);
});

// POST /api/wechat/accounts - 添加公众号
router.post('/accounts', (req, res) => {
  const db = getDB();
  const item = { id: nextId('wechat_accounts'), ...req.body, created_at: new Date().toISOString() };
  if (!db.wechat_accounts) db.wechat_accounts = [];
  db.wechat_accounts.push(item);
  // save() not needed - push auto-writes
  res.json({ id: item.id, message: '公众号添加成功' });
});

// PUT /api/wechat/accounts/:id - 更新公众号
router.put('/accounts/:id', (req, res) => {
  const db = getDB();
  const item = (db.wechat_accounts || []).find(a => a.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: '公众号不存在' });
  Object.assign(item, req.body, { id: item.id, updated_at: new Date().toISOString() });
  syncRow('wechat_accounts', item);
  res.json({ message: '更新成功' });
});

// DELETE /api/wechat/accounts/:id - 删除公众号
router.delete('/accounts/:id', (req, res) => {
  const db = getDB();
  deleteRows('wechat_accounts', { id: Number(req.params.id) });
  res.json({ message: '删除成功' });
});

// POST /api/wechat/follow - 记录关注关系
router.post('/follow', (req, res) => {
  const db = getDB();
  const { our_account_id, client_account_id, status } = req.body;
  if (!our_account_id || !client_account_id) return res.status(400).json({ error: '缺少参数' });

  // 检查是否已存在
  if (!db.follow_relations) db.follow_relations = [];
  const existing = db.follow_relations.find(
    r => r.our_account_id === Number(our_account_id) && r.client_account_id === Number(client_account_id)
  );
  if (existing) {
    existing.status = status || existing.status;
    existing.updated_at = new Date().toISOString();
    syncRow('follow_relations', existing);
  } else {
    db.follow_relations.push({
      id: nextId('wechat_accounts'), // 复用计数器
      our_account_id: Number(our_account_id),
      client_account_id: Number(client_account_id),
      status: status || 'pending',
      created_at: new Date().toISOString()
    });
  }
  // save() not needed - push/syncRow auto-writes
  res.json({ message: '关注关系已记录' });
});

// GET /api/wechat/push-history - 推送历史
router.get('/push-history', (req, res) => {
  const db = getDB();
  const { article_id, page = 1, limit = 20 } = req.query;
  let history = db.push_history || [];
  if (article_id) history = history.filter(h => h.article_id === Number(article_id));
  history.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
  const total = history.length;
  const start = (Number(page) - 1) * Number(limit);
  const items = history.slice(start, start + Number(limit));
  res.json({ total, page: Number(page), limit: Number(limit), data: items });
});

// GET /api/wechat/dashboard - 微信运营概览
router.get('/dashboard', (req, res) => {
  const db = getDB();
  const accounts = db.wechat_accounts || [];
  const history = db.push_history || [];
  const follows = db.follow_relations || [];
  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 3600 * 1000);

  res.json({
    totalPushes: history.length,
    thisWeekPushes: history.filter(h => new Date(h.pushed_at) >= weekAgo).length,
    totalAccounts: accounts.length,
    mutualFollows: follows.filter(f => f.status === 'mutual').length,
    recentPushes: history.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at)).slice(0, 5)
  });
});

module.exports = router;
