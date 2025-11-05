// functions/products-update.js
const { verifyShopifyWebhookHmac } = require('./utils/verify.js');
const { shopifyGraphql } = require('./utils/shopify.js');

/* ------------------------------ helpers ------------------------------ */
function toNumber(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}
function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
// tolerate minor misspellings and composite titles like "Jeddah / 1kg"
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
  // fallback: use variant.title (can be "Jeddah" or "Jeddah / Large")
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
function productGid(numericId) {
  return `gid://shopify/Product/${numericId}`;
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

/* ------------------------------ handler ------------------------------ */
exports.handler = async (event) => {
  const verbose = (process.env.LOG_LEVEL || 'info') === 'debug';
  try {
    const rawBody = event.body || '';
    const headers = event.headers || {};
    const shop = process.env.SHOPIFY_SHOP;
    const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    const apiSecret = process.env.SHOPIFY_API_SECRET;

    if (!shop || !token || !apiSecret) {
      return { statusCode: 500, body: 'Missing env vars SHOPIFY_SHOP / SHOPIFY_ADMIN_ACCESS_TOKEN / SHOPIFY_API_SECRET' };
    }

    // --- HMAC verification (with optional bypass for testing) ---
    if (process.env.SKIP_HMAC === '1') {
      console.warn('WARNING: HMAC verification bypassed (testing mode: SKIP_HMAC=1)');
    } else {
      const ok = verifyShopifyWebhookHmac(rawBody, headers, apiSecret);
      if (!ok) {
        return { statusCode: 200, body: 'Invalid webhook signature' }; // 200 to avoid retries while debugging
      }
    }

    // Parse Shopify product payload
    const product = JSON.parse(rawBody);
    const productIdNum = product.id;
    const pGid = productGid(productIdNum);

    const variants = Array.isArray(product?.variants) ? product.variants : [];
    if (verbose) {
      console.log('Incoming product', productIdNum, 'variant titles:', variants.map(v => v.title));
    }

    const targetCities = ['jeddah', 'riyadh', 'dammam'];
    const decisions = []; // { city, action: 'add'|'remove', collectionId, price, compare_at_price, variantId }

    for (const v of variants) {
      const city = cityFromVariant(v);
      if (!targetCities.includes(city)) continue;

      const price = toNumber(v.price);
      const cap = toNumber(v.compare_at_price);
      const promo = Number.isFinite(price) && Number.isFinite(cap) && cap > price;

      const collectionId = cityCollectionGid(city);
      if (!collectionId) continue;

      decisions.push({
        city,
        action: promo ? 'add' : 'remove',
        collectionId,
        price,
        compare_at_price: cap,
        variantId: v.id
      });
    }

    if (verbose) console.log('Decisions:', decisions);

    // Execute mutations (idempotent on Shopify’s side)
    const results = [];
    for (const d of decisions) {
      try {
        if (d.action === 'add') {
          await addToCollection(shop, token, d.collectionId, pGid);
        } else {
          await removeFromCollection(shop, token, d.collectionId, pGid);
        }
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
