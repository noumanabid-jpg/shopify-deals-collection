const { verifyShopifyWebhookHmac } = require('./utils/verify.js');
const { shopifyGraphql } = require('./utils/shopify.js');

function toNumber(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function cityFromVariant(variant) {
  const mode = (process.env.CITY_SOURCE || 'title').toLowerCase();
  if (mode === 'metafield') {
    const ns = process.env.CITY_METAFIELD_NAMESPACE || 'custom';
    const key = process.env.CITY_METAFIELD_KEY || 'city';
    const mf = (variant?.metafields || []).find(m => m.namespace === ns && m.key === key);
    if (mf?.value) return String(mf.value).toLowerCase();
  }
  return String(variant?.title || '').trim().toLowerCase();
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

exports.handler = async (event, context) => {
  try {
    // Raw body is needed for HMAC verification
    const rawBody = event.body || '';
    const headers = event.headers || {};
    const shop = process.env.SHOPIFY_SHOP;
    const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    const apiSecret = process.env.SHOPIFY_API_SECRET;

    if (!shop || !token || !apiSecret) {
      return { statusCode: 500, body: 'Missing env vars SHOPIFY_SHOP / SHOPIFY_ADMIN_ACCESS_TOKEN / SHOPIFY_API_SECRET' };
    }

    // Verify HMAC
    const ok = verifyShopifyWebhookHmac(rawBody, headers, apiSecret);
    if (!ok) {
      return { statusCode: 401, body: 'Invalid webhook signature' };
    }

    // Parse payload (product update webhook)
    const product = JSON.parse(rawBody);
    const productIdNum = product.id;
    const pGid = productGid(productIdNum);

    // Prepare add/remove sets per city based on variant promo status
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    const decisions = []; // { city, action: 'add' | 'remove', collectionId }

    const cities = ['jeddah', 'riyadh', 'dammam'];

    for (const city of cities) {
      const variant = variants.find(v => cityFromVariant(v) === city);
      if (!variant) continue;

      const price = toNumber(variant.price);
      const cap = toNumber(variant.compare_at_price);
      const promo = Number.isFinite(price) && Number.isFinite(cap) && cap > price;

      const collectionId = cityCollectionGid(city);
      if (!collectionId) continue;

      decisions.push({ city, action: promo ? 'add' : 'remove', collectionId });
    }

    // Execute mutations (idempotent)
    for (const d of decisions) {
      try {
        if (d.action === 'add') {
          await addToCollection(shop, token, d.collectionId, pGid);
        } else {
          await removeFromCollection(shop, token, d.collectionId, pGid);
        }
      } catch (e) {
        console.error('Mutation error', d, e.response || e.message);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, productId: productIdNum, decisions }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Server error' };
  }
};
