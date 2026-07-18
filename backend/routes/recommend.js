const express = require('express');
const router = express.Router();
const dbModule = require('../models/db');
const db = dbModule.getDB();

/**
 * 智能推荐引擎
 * 基于用户画像（行业、痛点、浏览历史、收藏、订单）匹配最合适的产品
 */

// ===== 权重配置 =====
const WEIGHTS = {
  industryMatch: 40,      // 行业匹配
  painPointMatch: 30,     // 痛点匹配
  browseHistory: 15,      // 浏览历史相关性
  favorited: 10,          // 已收藏的产品加分
  ordered: 5,             // 曾购买的产品加分
  popularity: 10,         // 热门程度
  freshness: 5,           // 新鲜度（新上架产品加分）
  categoryDiversity: 5    // 分类多样性（避免推荐同分类）
};

/**
 * GET /api/recommend/products
 * 智能产品推荐
 * 
 * Query params:
 *   openid    - 用户openid（用于获取历史/收藏）
 *   industry  - 用户行业
 *   pain_id   - 痛点ID
 *   limit     - 返回数量（默认6）
 *   exclude   - 排除的产品ID（逗号分隔）
 */
router.get('/products', (req, res) => {
  try {
    const { openid, industry, pain_id, limit = 6, exclude } = req.query;
    const products = (db.products || []).filter(p => p.status === 'published' || p.published !== false);
    const painPoints = db.pain_points || [];
    const industries = db.industries || [];
    const orders = db.orders || [];
    const contacts = db.contacts || [];

    // 排除的产品
    const excludeIds = (exclude || '').split(',').filter(Boolean).map(Number);

    // 获取用户浏览历史
    let browseHistory = [];
    let favoritedIds = [];
    let orderedProductIds = [];

    if (openid) {
      // 从联系表单中提取用户行业偏好
      const userContacts = contacts.filter(c => c.openid === openid);
      // 从订单中提取已购买产品
      orderedProductIds = orders
        .filter(o => o.buyer_openid === openid)
        .map(o => o.product_id);
    }

    // 痛点信息
    let painPoint = null;
    if (pain_id) {
      painPoint = painPoints.find(p => p.id === Number(pain_id));
    }

    // 行业信息
    let industryInfo = null;
    if (industry) {
      industryInfo = industries.find(i => i.id === Number(industry) || i.name === industry);
    }

    // 计算每个产品的推荐分
    const scored = products
      .filter(p => !excludeIds.includes(p.id))
      .map(product => {
        let score = 0;
        const reasons = [];

        // 1. 行业匹配
        if (industryInfo || industry) {
          const productIndustries = product.industries || product.industry_ids || [];
          const productIndustryNames = product.industries || [];
          const targetName = industryInfo ? industryInfo.name : industry;
          
          if (Array.isArray(productIndustryNames) && productIndustryNames.includes(targetName)) {
            score += WEIGHTS.industryMatch;
            reasons.push(`适合${targetName}行业`);
          } else if (product.category && industryInfo && product.category === industryInfo.name) {
            score += WEIGHTS.industryMatch * 0.7;
            reasons.push(`${targetName}行业优选`);
          }
        }

        // 2. 痛点匹配
        if (painPoint) {
          const productPainIds = product.pain_point_ids || [];
          const productTags = product.tags || [];
          const painKeywords = (painPoint.keywords || painPoint.title || '').split(/[,，\s]+/).filter(Boolean);
          
          // 痛点ID直接匹配
          if (Array.isArray(productPainIds) && productPainIds.includes(painPoint.id)) {
            score += WEIGHTS.painPointMatch;
            reasons.push(`直击「${painPoint.title}」痛点`);
          }
          // 标签关键词匹配
          else if (Array.isArray(productTags)) {
            const tagMatches = productTags.filter(tag => 
              painKeywords.some(kw => tag.toLowerCase().includes(kw.toLowerCase()))
            );
            if (tagMatches.length > 0) {
              score += WEIGHTS.painPointMatch * (tagMatches.length / Math.max(painKeywords.length, 1));
              reasons.push(`匹配「${painPoint.title}」需求`);
            }
          }
        }

        // 3. 浏览历史相关性
        if (browseHistory.length > 0) {
          const recentProductIds = browseHistory.slice(0, 10).map(h => h.product_id);
          if (recentProductIds.includes(product.id)) {
            score += WEIGHTS.browseHistory;
          }
          // 同分类产品加分
          const recentProducts = recentProductIds
            .map(id => products.find(p => p.id === id))
            .filter(Boolean);
          const sameCategory = recentProducts.some(rp => rp.category === product.category);
          if (sameCategory) {
            score += WEIGHTS.browseHistory * 0.5;
          }
        }

        // 4. 已收藏加分
        if (favoritedIds.includes(product.id)) {
          score += WEIGHTS.favorited;
          reasons.push('你已收藏');
        }

        // 5. 已购买加分（复购/升级场景）
        if (orderedProductIds.includes(product.id)) {
          score += WEIGHTS.ordered;
          reasons.push('再次了解');
        }

        // 6. 热门程度（基于订单数）
        const productOrders = orders.filter(o => o.product_id === product.id).length;
        if (productOrders > 0) {
          const popularityScore = Math.min(WEIGHTS.popularity, productOrders * 2);
          score += popularityScore;
          if (productOrders >= 5) {
            reasons.push(`${productOrders}家企业已采购`);
          }
        }

        // 7. 新鲜度
        const createdAt = product.created_at ? new Date(product.created_at) : null;
        if (createdAt) {
          const daysSinceCreated = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceCreated < 30) {
            score += WEIGHTS.freshness;
            reasons.push('新品上架');
          }
        }

        // 8. 默认推荐理由（如果没有命中任何规则）
        if (reasons.length === 0) {
          if (product.tags && product.tags.length > 0) {
            reasons.push(product.tags[0]);
          } else if (product.subtitle) {
            reasons.push(product.subtitle.slice(0, 12));
          } else {
            reasons.push('精选方案');
          }
        }

        // 限制理由数量
        const topReasons = reasons.slice(0, 2);

        return {
          id: product.id,
          title: product.title,
          subtitle: product.subtitle || '',
          icon: product.icon || '📦',
          category: product.category || '',
          price: product.price || 0,
          unit: product.unit || '',
          tags: (product.tags || []).slice(0, 3),
          image: product.image || '',
          score: Math.round(score * 10) / 10,
          reasons: topReasons,
          orderCount: productOrders
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(limit));

    // 分类多样性调整：如果前3个都是同分类，尝试插入一个不同分类的
    if (scored.length >= 3) {
      const topCategory = scored[0].category;
      const allSameCategory = scored.slice(0, 3).every(p => p.category === topCategory);
      if (allSameCategory) {
        const diverseProduct = products
          .filter(p => 
            !excludeIds.includes(p.id) && 
            p.category !== topCategory &&
            !scored.find(s => s.id === p.id)
          )
          .map(product => ({
            id: product.id,
            title: product.title,
            subtitle: product.subtitle || '',
            icon: product.icon || '📦',
            category: product.category || '',
            price: product.price || 0,
            unit: product.unit || '',
            tags: (product.tags || []).slice(0, 3),
            image: product.image || '',
            score: WEIGHTS.categoryDiversity,
            reasons: ['拓展方案'],
            orderCount: (db.orders || []).filter(o => o.product_id === product.id).length
          }))
          .sort((a, b) => b.orderCount - a.orderCount)
          .slice(0, 1);
        
        if (diverseProduct.length > 0) {
          scored.splice(2, 0, diverseProduct[0]);
          if (scored.length > Number(limit)) scored.pop();
        }
      }
    }

    res.json({
      products: scored,
      meta: {
        total: scored.length,
        userIndustry: industry || null,
        painPoint: painPoint ? painPoint.title : null,
        weights: WEIGHTS
      }
    });
  } catch (err) {
    console.error('推荐引擎错误:', err);
    res.status(500).json({ error: '推荐服务异常', message: err.message });
  }
});

/**
 * GET /api/recommend/combination
 * 方案组合推荐（基于一个产品推荐配套方案）
 * 
 * Query params:
 *   product_id - 基准产品ID
 *   limit      - 返回数量（默认3）
 */
router.get('/combination', (req, res) => {
  try {
    const { product_id, limit = 3 } = req.query;
    if (!product_id) return res.status(400).json({ error: '缺少 product_id' });

    const products = (db.products || []).filter(p => p.status === 'published' || p.published !== false);
    const baseProduct = products.find(p => p.id === Number(product_id));
    if (!baseProduct) return res.status(404).json({ error: '产品不存在' });

    // 组合规则：基于产品分类和标签推荐配套方案
    const combinationRules = {
      'ERP': ['MES', 'CRM', '数据分析', '协同办公'],
      'MES': ['ERP', 'IoT', '数据分析', '质量管理'],
      'CRM': ['数字营销', '数据分析', '协同办公', '客服系统'],
      'OA': ['协同办公', '流程管理', '文档管理', 'ERP'],
      '协同办公': ['OA', 'CRM', '项目管理', '文档管理'],
      '供应链': ['ERP', '仓储管理', '采购管理', '物流管理'],
      '数据分析': ['BI', '数据中台', 'ERP', 'CRM'],
      '数字营销': ['CRM', '数据分析', '内容管理', '社交媒体']
    };

    // 找到匹配的组合类别
    const baseCategory = baseProduct.category || '';
    const baseTags = baseProduct.tags || [];
    const recommendedCategories = combinationRules[baseCategory] || [];

    const recommendations = products
      .filter(p => p.id !== baseProduct.id)
      .map(product => {
        let score = 0;
        const reasons = [];

        // 分类匹配组合规则
        if (recommendedCategories.includes(product.category)) {
          score += 50;
          reasons.push(`${baseCategory} + ${product.category} 黄金组合`);
        }

        // 标签重叠度
        const productTags = product.tags || [];
        const sharedTags = productTags.filter(t => baseTags.includes(t));
        if (sharedTags.length > 0) {
          score += sharedTags.length * 15;
          reasons.push(`共同标签：${sharedTags.slice(0, 2).join('、')}`);
        }

        // 行业重叠
        const baseIndustries = baseProduct.industries || [];
        const productIndustries = product.industries || [];
        const sharedIndustries = baseIndustries.filter(i => productIndustries.includes(i));
        if (sharedIndustries.length > 0) {
          score += 10;
          reasons.push(`同行业适用`);
        }

        if (reasons.length === 0) {
          reasons.push('配套推荐');
        }

        return {
          id: product.id,
          title: product.title,
          subtitle: product.subtitle || '',
          icon: product.icon || '📦',
          category: product.category || '',
          price: product.price || 0,
          unit: product.unit || '',
          tags: (product.tags || []).slice(0, 3),
          image: product.image || '',
          score: Math.round(score * 10) / 10,
          reasons: reasons.slice(0, 2),
          comboSaving: Math.round((baseProduct.price + product.price) * 0.1) // 组合优惠10%
        };
      })
      .filter(p => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(limit));

    res.json({
      base: {
        id: baseProduct.id,
        title: baseProduct.title,
        price: baseProduct.price || 0,
        category: baseCategory
      },
      recommendations,
      comboDiscount: '搭配购买享9折优惠'
    });
  } catch (err) {
    console.error('组合推荐错误:', err);
    res.status(500).json({ error: '推荐服务异常', message: err.message });
  }
});

/**
 * GET /api/recommend/pain-point/:painId
 * 基于痛点的产品推荐
 */
router.get('/pain-point/:painId', (req, res) => {
  try {
    const { painId } = req.params;
    const { limit = 4 } = req.query;
    
    const painPoints = db.pain_points || [];
    const products = (db.products || []).filter(p => p.status === 'published' || p.published !== false);
    const painPoint = painPoints.find(p => p.id === Number(painId));
    
    if (!painPoint) return res.status(404).json({ error: '痛点不存在' });

    const keywords = (painPoint.keywords || painPoint.title || '').split(/[,，\s]+/).filter(Boolean);
    const painProductIds = painPoint.product_ids || [];

    const scored = products
      .map(product => {
        let score = 0;
        const reasons = [];

        // 痛点直接关联
        if (painProductIds.includes(product.id)) {
          score += 100;
          reasons.push('痛点首选方案');
        }

        // 标签匹配
        const productTags = product.tags || [];
        const tagMatches = productTags.filter(tag =>
          keywords.some(kw => tag.toLowerCase().includes(kw.toLowerCase()))
        );
        if (tagMatches.length > 0) {
          score += tagMatches.length * 30;
          reasons.push(`匹配关键词：${tagMatches.slice(0, 2).join('、')}`);
        }

        // 标题/描述匹配
        const titleMatch = keywords.some(kw => 
          (product.title || '').toLowerCase().includes(kw.toLowerCase()) ||
          (product.subtitle || '').toLowerCase().includes(kw.toLowerCase())
        );
        if (titleMatch) {
          score += 20;
          if (reasons.length === 0) reasons.push('标题相关');
        }

        if (reasons.length === 0) {
          reasons.push('可能适合你');
        }

        return {
          id: product.id,
          title: product.title,
          subtitle: product.subtitle || '',
          icon: product.icon || '📦',
          category: product.category || '',
          price: product.price || 0,
          unit: product.unit || '',
          tags: (product.tags || []).slice(0, 3),
          image: product.image || '',
          score,
          reasons: reasons.slice(0, 2)
        };
      })
      .filter(p => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(limit));

    res.json({
      painPoint: {
        id: painPoint.id,
        title: painPoint.title,
        icon: painPoint.icon || '🎯'
      },
      products: scored
    });
  } catch (err) {
    console.error('痛点推荐错误:', err);
    res.status(500).json({ error: '推荐服务异常', message: err.message });
  }
});

/**
 * GET /api/recommend/home
 * 首页推荐（综合推荐 + 热门 + 新品）
 */
router.get('/home', (req, res) => {
  try {
    const { openid, industry, limit = 6 } = req.query;
    const products = (db.products || []).filter(p => p.status === 'published' || p.published !== false);
    const orders = db.orders || [];

    // 热门产品（按订单数）
    const hotProducts = products
      .map(p => ({
        ...p,
        _orderCount: orders.filter(o => o.product_id === p.id).length
      }))
      .sort((a, b) => b._orderCount - a._orderCount)
      .slice(0, 3)
      .map(p => ({
        id: p.id,
        title: p.title,
        subtitle: p.subtitle || '',
        icon: p.icon || '📦',
        category: p.category || '',
        price: p.price || 0,
        unit: p.unit || '',
        tags: (p.tags || []).slice(0, 3),
        image: p.image || '',
        reasons: p._orderCount > 0 ? [`${p._orderCount}家企业选择`] : ['热门方案'],
        badge: '🔥 热门'
      }));

    // 新品上架
    const newProducts = products
      .filter(p => p.created_at)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 3)
      .map(p => ({
        id: p.id,
        title: p.title,
        subtitle: p.subtitle || '',
        icon: p.icon || '📦',
        category: p.category || '',
        price: p.price || 0,
        unit: p.unit || '',
        tags: (p.tags || []).slice(0, 3),
        image: p.image || '',
        reasons: ['新品上架'],
        badge: '✨ 新品'
      }));

    // 智能推荐（调用推荐逻辑）
    let smartRecommendations = [];
    if (industry) {
      const industries = db.industries || [];
      const industryInfo = industries.find(i => i.id === Number(industry) || i.name === industry);
      
      smartRecommendations = products
        .map(product => {
          let score = 0;
          const reasons = [];
          
          const productIndustries = product.industries || [];
          const targetName = industryInfo ? industryInfo.name : industry;
          
          if (Array.isArray(productIndustries) && productIndustries.includes(targetName)) {
            score += 50;
            reasons.push(`适合${targetName}行业`);
          }
          
          if (product.category === targetName) {
            score += 30;
            reasons.push(`${targetName}行业优选`);
          }

          if (reasons.length === 0) {
            return null;
          }

          return {
            id: product.id,
            title: product.title,
            subtitle: product.subtitle || '',
            icon: product.icon || '📦',
            category: product.category || '',
            price: product.price || 0,
            unit: product.unit || '',
            tags: (product.tags || []).slice(0, 3),
            image: product.image || '',
            reasons: reasons.slice(0, 2),
            badge: '🎯 推荐'
          };
        })
        .filter(Boolean)
        .sort((a, b) => {
          // 按 reasons 中第一个的分值排序（简化处理）
          return 0;
        })
        .slice(0, Number(limit));
    }

    // 如果没有行业信息或推荐不足，用热门补充
    if (smartRecommendations.length < 3) {
      const existingIds = smartRecommendations.map(p => p.id);
      const fallback = products
        .filter(p => !existingIds.includes(p.id))
        .slice(0, 3 - smartRecommendations.length)
        .map(p => ({
          id: p.id,
          title: p.title,
          subtitle: p.subtitle || '',
          icon: p.icon || '📦',
          category: p.category || '',
          price: p.price || 0,
          unit: p.unit || '',
          tags: (p.tags || []).slice(0, 3),
          image: p.image || '',
          reasons: ['精选推荐'],
          badge: '🎯 推荐'
        }));
      smartRecommendations = [...smartRecommendations, ...fallback];
    }

    res.json({
      smart: smartRecommendations,
      hot: hotProducts,
      new: newProducts
    });
  } catch (err) {
    console.error('首页推荐错误:', err);
    res.status(500).json({ error: '推荐服务异常', message: err.message });
  }
});

module.exports = router;
