// functions/products-update.js
const { verifyShopifyWebhookHmac } = require('./utils/verify.js');
const { shopifyGraphql } = require('./utils/shopify.js');

/* ---------------- helpers ---------------- */
function toNumber(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}
function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function normalizeCityName(s) {
  const n = normalize(s);
  if (!n) return '';
  if (n.includes('jeddah') || n.includes('jedddah')) return 'jeddah';
  if (n.includes('riyadh')) return 'riyadh';
  if (n.includes('dammam')) return 'dammam';
  return n;
}
function cityFromVariant(variant) {
  const mode = (process.env.CITY_SOURCE || 'title').toLowerCase();
  if (mode === 'metafield') {
    const ns = process.env.CITY_METAFIELD_NAMESPACE || 'custom';
    const key = process.env.CITY_METAFIELD_KEY || 'city';
    const mf = (variant?.metafields || []).find(m => m.namespace === ns && m.key === key);
    if (mf?.value) return normalizeCityName(mf.value);
  }
  return normalizeCityName(variant?.title);
}
function cityCollectionGid(city) {
  switch (city) {
    case 'jeddah': return process.env.DEALS_JEDDAH_COLLECTION_GID;
    case 'riyadh': return process.env.DEALS_RIYADH_COLLECTION_GID;
    case 'dammam': return process.env.DEALS_DAMMAM_COLLECTION_GID;
    default: return null;
  }
}
function productGid(idNum) { return `gid://shopify/Product/${idNum}`; }

/* promo detectors */
function promoByPrice(variant) {
  const price = toNumber(variant.price);
  const cap   = toNumber(variant.compare_at_price);
  return { promo: Number.isFinite(price) && Number.isFinite(cap) && cap > price, price, cap };
}
function promoByMetafield(variant) {
  const ns = process.env.PROMO_METAFIELD_NAMESPACE || 'custom';
  const key = process.env.PROMO_METAFIELD_KEY || 'promo_active';
  const mf = (variant?.metafields || []).find(m => m.namespace === ns && m.key === key);
  // Accept “true”, "1", true
  const val = String(mf?.value ?? '').toLowerCase().trim();
  const promo = val === 'true' || val === '1';
  return { promo, price: toNumber(variant.price), cap: toNumber(variant.compare_at_price) };
}
function promoByTag(product, city) {
  const tags = (product.tags || '').toLowerCase();
  const promo = tags.includes(`deal-${city}`);
  return { promo, price: NaN, cap: NaN };
}

async function addToCollection(shop, token, collectionId, productId) {
  const query = `#graphql
    mutation AddToCollection($id: ID!, $pids: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $pids) {
        job { id }
        userErrors { field message }
      }
    }`;
  return shopifyGraphql({ shop, token, query, variables: { id: collectionId, pids: [productId] } });
}
async function removeFromCollection(shop, token, collectionId, productId) {
  const query = `#graphql
    mutation RemoveFromCollection($id: ID!, $pids: [ID!]!) {
      collectionRemoveProducts(id: $id, productIds: $pids) {
        job { id }
        userErrors { field message }
      }
    }`;
  return shopifyGraphql({ shop, token, query, variables: { id: collectionId, pids: [productId] } });
}

/* ---------------- handler ---------------- */
exports.handler = async (event) => {
  const verbose = (process.env.LOG_LEVEL || 'info') === 'debug';
  const promoSource = (process.env.PROMO_SOURCE || 'price').toLowerCase(); // 'price' | 'metafield' | 'tag'

  try {
    const rawBody = event.body || '';
    const headers = event.headers || {};
    const shop = process.env.SHOPIFY_SHOP;
    const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    const apiSecret = process.env.SHOPIFY_API_SECRET;

    if (!shop || !token || !apiSecret) {
      return { statusCode: 500, body: 'Missing env vars SHOPIFY_SHOP / SHOPIFY_ADMIN_ACCESS_TOKEN / SHOPIFY_API_SECRET' };
    }

    // HMAC (bypass only for testing)
    if (process.env.SKIP_HMAC === '1') {
      console.warn('WARNING: HMAC verification bypassed (testing mode: SKIP_HMAC=1)');
    } else {
      const ok = require('./utils/verify.js').verifyShopifyWebhookHmac(rawBody, headers, apiSecret);
      if (!ok) return { statusCode: 200, body: 'Invalid webhook signature' };
    }

    const product = JSON.parse(rawBody);
    const productIdNum = product.id;
    const pGid = productGid(productIdNum);
    const variants = Array.isArray(product?.variants) ? product.variants : [];

    if (verbose) console.log('Incoming product', productIdNum, 'variant titles:', variants.map(v => v.title));

    const targetCities = ['jeddah', 'riyadh', 'dammam'];
    const decisions = [];

    for (const v of variants) {
      const city = cityFromVariant(v);
      if (!targetCities.includes(city)) continue;

      let res = { promo: false, price: NaN, cap: NaN };
      if (promoSource === 'price')      res = promoByPrice(v);
      else if (promoSource === 'metafield') res = promoByMetafield(v);
      else if (promoSource === 'tag')   res = promoByTag(product, city);

      if (verbose) console.log(`Variant ${v.id} (${city}) price=${res.price} cap=${res.cap} promo=${res.promo}`);

      const collectionId = cityCollectionGid(city);
      if (!collectionId) continue;

      decisions.push({
        city,
        action: res.promo ? 'add' : 'remove',
        collectionId,
        price: res.price,
        compare_at_price: res.cap,
        variantId: v.id
      });
    }

    if (verbose) console.log('Decisions:', decisions);

    const results = [];
    for (const d of decisions) {
      try {
        if (d.action === 'add') await addToCollection(shop, token, d.collectionId, pGid);
        else await removeFromCollection(shop, token, d.collectionId, pGid);
        results.push({ city: d.city, action: d.action, ok: true });
      } catch (e) {
        console.error('Mutation error for', d.city, d.action, e.response || e.message);
        results.push({ city: d.city, action: d.action, ok: false, error: e.response || e.message });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, productId: productIdNum, decisions, results }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Server error' };
  }
};
