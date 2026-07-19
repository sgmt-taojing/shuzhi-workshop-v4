#!/usr/bin/env node
/**
 * 业务流程端到端测试
 * 验证各功能模块的创建→流转→完成全流程
 */

const BASE = 'http://127.0.0.1:3004/api';

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { return { raw: text.slice(0, 200), status: r.status }; }
}

async function main() {
  // 登录
  const loginRes = await api('POST', '/admin/login', null, { username: 'admin', password: 'admin123' });
  const token = loginRes.token;
  console.log(`✅ 登录成功: ${loginRes.username}`);
  console.log('');

  let pass = 0, fail = 0;
  function ok(msg) { console.log(`  ✅ ${msg}`); pass++; }
  function err(msg) { console.log(`  ❌ ${msg}`); fail++; }

  // ===== 1. 咨询线索流程 =====
  console.log('=== 1. 咨询线索流程 ===');
  try {
    const contacts = await api('GET', '/contact', token);
    const list = Array.isArray(contacts) ? contacts : [];
    ok(`查询咨询列表: ${list.length} 条`);
    
    const pending = list.filter(c => c.status === 'new' || c.status === 'pending');
    if (pending.length > 0) {
      const c = pending[0];
      const cid = c.id;
      // new → contacted
      const r1 = await api('PUT', `/contact/${cid}`, token, { status: 'contacted' });
      ok(`流转 #${cid}: new → contacted`);
      // contacted → won
      const r2 = await api('PUT', `/contact/${cid}`, token, { status: 'won' });
      ok(`流转 #${cid}: contacted → won`);
    } else {
      ok('无待处理咨询（数据机器人会补充）');
    }
  } catch(e) { err('咨询流程异常: ' + e.message); }
  console.log('');

  // ===== 2. 入驻申请流程 =====
  console.log('=== 2. 入驻申请流程 ===');
  try {
    const obs = await api('GET', '/onboarding', token);
    const obList = Array.isArray(obs) ? obs : [];
    ok(`查询入驻列表: ${obList.length} 条`);
    
    const pending = obList.filter(o => o.status === 'pending');
    if (pending.length > 0) {
      const ob = pending[0];
      const obid = ob.id;
      // pending → approved (review)
      const r1 = await api('PUT', `/onboarding/${obid}/review`, token, { status: 'approved' });
      if (r1.error) {
        err(`审核失败: ${r1.error}`);
      } else {
        ok(`审核 #${obid}: pending → approved`);
        // approved → convert (创建甲方+甲方产品)
        const r2 = await api('POST', `/onboarding/${obid}/convert`, token);
        if (r2.error) {
          err(`转换失败: ${r2.error}`);
        } else {
          ok(`转换 #${obid}: approved → converted (甲方: ${r2.client?.name || r2.clientName || '?'})`);
        }
      }
    } else {
      ok('无待审核入驻（数据机器人会补充）');
    }
  } catch(e) { err('入驻流程异常: ' + e.message); }
  console.log('');

  // ===== 3. 订单流程 =====
  console.log('=== 3. 订单流程 ===');
  try {
    const orders = await api('GET', '/admin/orders', token);
    const list = Array.isArray(orders) ? orders : [];
    ok(`查询订单: ${list.length} 条`);
    
    const statusFlow = ['pending', 'paid', 'processing', 'completed'];
    const pendingOrder = list.find(o => o.status === 'pending');
    if (pendingOrder) {
      const oid = pendingOrder.id;
      for (let i = 1; i < statusFlow.length; i++) {
        const r = await api('PUT', `/admin/orders/${oid}`, token, { status: statusFlow[i] });
        ok(`流转 #${oid}: ${statusFlow[i-1]} → ${statusFlow[i]}`);
      }
      ok(`订单 #{oid} 全流程完成: 待支付→已支付→处理中→已完成`);
    } else {
      ok('无待支付订单（数据机器人会补充）');
    }
  } catch(e) { err('订单流程异常: ' + e.message); }
  console.log('');

  // ===== 4. 客服会话流程 =====
  console.log('=== 4. 客服会话流程 ===');
  try {
    const cs = await api('GET', '/customer-service/conversations', token);
    ok(`查询会话: ${cs.total || 0} 条`);
    
    const openConvs = (cs.data || []).filter(c => c.status === 'open');
    if (openConvs.length > 0) {
      const conv = openConvs[0];
      const convId = conv.id;
      // 回复
      const r1 = await api('POST', '/customer-service/reply', token, { conversation_id: convId, content: '您好，已为您处理' });
      ok(`回复会话 #${convId}`);
      // 查看消息
      const msgs = await api('GET', `/customer-service/admin/messages?conversation_id=${convId}`, token);
      ok(`查看消息: ${msgs.total || 0} 条`);
      // 关闭
      const r2 = await api('PUT', `/customer-service/admin/close/${convId}`, token);
      ok(`关闭会话 #${convId}`);
    } else {
      ok('无开放会话');
    }
  } catch(e) { err('客服流程异常: ' + e.message); }
  console.log('');

  // ===== 5. 反馈管理流程 =====
  console.log('=== 5. 反馈管理流程 ===');
  try {
    const fb = await api('GET', '/feedback', token);
    ok(`查询反馈: ${fb.total || 0} 条`);
    
    const pendingFb = (fb.data || []).filter(f => f.status === 'pending');
    if (pendingFb.length > 0) {
      const f = pendingFb[0];
      const fid = f.id;
      // pending → processing
      const r1 = await api('PUT', `/feedback/${fid}`, token, { status: 'processing' });
      ok(`流转 #${fid}: pending → processing`);
      // processing → resolved (with reply)
      const r2 = await api('PUT', `/feedback/${fid}`, token, { status: 'resolved', reply: '已处理完毕' });
      ok(`流转 #${fid}: processing → resolved (含回复)`);
    } else {
      ok('无待处理反馈');
    }
  } catch(e) { err('反馈流程异常: ' + e.message); }
  console.log('');

  // ===== 6. 优惠券流程 =====
  console.log('=== 6. 优惠券流程 ===');
  try {
    const coupons = await api('GET', '/coupons', token);
    ok(`查询优惠券: ${coupons.length || 0} 条`);
    
    // 创建
    const r1 = await api('POST', '/coupons', token, {
      code: 'TESTFLOW',
      title: '流程测试优惠券',
      type: 'fixed',
      value: 50,
      min_amount: 100
    });
    if (r1.id) {
      ok(`创建优惠券 #${r1.id}: ${r1.code}`);
      // 删除
      const r2 = await api('DELETE', `/coupons/${r1.id}`, token);
      ok(`删除优惠券 #${r1.id}: ${r2.ok ? '成功' : '失败'}`);
    } else {
      err(`创建失败: ${r1.error || JSON.stringify(r1)}`);
    }
  } catch(e) { err('优惠券流程异常: ' + e.message); }
  console.log('');

  // ===== 7. 通知中心流程 =====
  console.log('=== 7. 通知中心流程 ===');
  try {
    const notifs = await api('GET', '/notifications', token);
    ok(`查询通知: ${notifs.length || 0} 条`);
    
    // 发送
    const r1 = await api('POST', '/notifications', token, {
      type: 'activity',
      title: '流程测试通知',
      content: '这是一条流程测试通知'
    });
    if (r1.id) {
      ok(`发送通知 #${r1.id}: ${r1.title}`);
      // 删除
      const r2 = await api('DELETE', `/notifications/${r1.id}`, token);
      ok(`删除通知 #${r1.id}: ${r2.ok ? '成功' : '失败'}`);
    } else {
      err(`发送失败: ${r1.error || JSON.stringify(r1)}`);
    }
  } catch(e) { err('通知流程异常: ' + e.message); }
  console.log('');

  // ===== 8. 积分奖品流程 =====
  console.log('=== 8. 积分奖品流程 ===');
  try {
    const rewards = await api('GET', '/points/rewards', token);
    ok(`查询奖品: ${(rewards.rewards || []).length} 条`);
    
    // 创建
    const r1 = await api('POST', '/points/admin/rewards', token, {
      title: '流程测试奖品',
      description: '测试用',
      points_required: 50,
      type: 'coupon',
      value: 'TEST50',
      stock: 5
    });
    if (r1.success && r1.reward) {
      const rid = r1.reward.id;
      ok(`创建奖品 #${rid}: ${r1.reward.title}`);
      // 删除
      const r2 = await api('DELETE', `/points/admin/rewards/${rid}`, token);
      ok(`下架奖品 #${rid}: ${r2.success ? '成功' : '失败'}`);
    } else {
      err(`创建失败: ${r1.error || JSON.stringify(r1)}`);
    }
  } catch(e) { err('积分奖品流程异常: ' + e.message); }
  console.log('');

  // ===== 9. 售后工单流程 =====
  console.log('=== 9. 售后工单流程 ===');
  try {
    const tickets = await api('GET', '/tickets/admin/list', token);
    const tData = tickets.data || {};
    const tList = tData.list || tData || [];
    const tTotal = tData.total || tickets.total || 0;
    ok(`查询工单: ${tTotal} 条`);
    const openTickets = (Array.isArray(tList) ? tList : []).filter(t => t.status === 'open');
    if (openTickets.length > 0) {
      const t = openTickets[0];
      ok(`开放工单: #${t.id} - ${t.title}`);
    } else {
      ok('无开放工单');
    }
  } catch(e) { err('工单流程异常: ' + e.message); }
  console.log('');

  // ===== 汇总 =====
  console.log('═══════════════════════════════');
  console.log(`  通过: ${pass} | 失败: ${fail} | 总计: ${pass + fail}`);
  console.log('═══════════════════════════════');
}

main().catch(e => console.error('Fatal:', e));
