const { fetch } = require('undici');

async function shopifyGraphql({ shop, token, query, variables }) {
  const url = `https://${shop}/admin/api/2025-10/graphql.json`; // update API version over time
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    const err = new Error('Shopify GraphQL error');
    err.status = res.status;
    err.response = json;
    throw err;
  }
  return json;
}

module.exports = { shopifyGraphql };
