const crypto = require('crypto');

function safeCompare(a, b) {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyShopifyWebhookHmac(rawBody, headers, apiSecret) {
  const hmacHeader = (headers['x-shopify-hmac-sha256'] || headers['X-Shopify-Hmac-Sha256'] || '').toString();
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', apiSecret)
    .update(rawBody, 'utf8')
    .digest('base64');
  return safeCompare(digest, hmacHeader);
}

module.exports = { verifyShopifyWebhookHmac };
