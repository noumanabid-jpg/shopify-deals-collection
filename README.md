# Shopify City Deals App (Netlify Functions)

Adds/removes products to city-specific “Deals – {City}” collections when a variant’s promotion state changes (based on `compare_at_price > price`).

## What it does
- Listens to `products/update` webhooks
- For each product variant titled **Jeddah**, **Riyadh**, **Dammam**:
  - If `compare_at_price > price` → **add** product to the corresponding deals collection
  - Else → **remove** product from that collection

## Requirements
- Shopify Plus store
- Three manual collections and their GIDs:
  - `DEALS_JEDDAH_COLLECTION_GID`
  - `DEALS_RIYADH_COLLECTION_GID`
  - `DEALS_DAMMAM_COLLECTION_GID`
- A custom app with Admin API access
  - Scopes: `read_products`, `write_products`, `read_collections`, `write_collections`
  - `SHOPIFY_ADMIN_ACCESS_TOKEN`
  - `SHOPIFY_API_SECRET` (used for HMAC verification)
  - `SHOPIFY_SHOP` (yourshop.myshopify.com)

## Env vars
Set these in Netlify “Site settings → Environment variables”:

```
SHOPIFY_SHOP=yourstore.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxx
SHOPIFY_API_SECRET=shpss_xxx
DEALS_JEDDAH_COLLECTION_GID=gid://shopify/Collection/1234567890
DEALS_RIYADH_COLLECTION_GID=gid://shopify/Collection/2345678901
DEALS_DAMMAM_COLLECTION_GID=gid://shopify/Collection/3456789012
# Optional (default: title)
CITY_SOURCE=title
# If CITY_SOURCE=metafield, also set:
CITY_METAFIELD_NAMESPACE=custom
CITY_METAFIELD_KEY=city
```

## Deploy (Netlify)
1. Create a new site from this folder (Git repo → Netlify).
2. Set the environment variables above in Netlify.
3. Deploy. Your endpoint will be:
   - `https://<your-site>.netlify.app/webhooks/products-update`

## Register the webhook
**Option A — Admin UI**
- Shopify Admin → Settings → Notifications → Webhooks → **Create webhook**
- Event: **Product update**
- Format: **JSON**
- URL: `https://<your-site>.netlify.app/webhooks/products-update`
- Save.

**Option B — API (GraphQL)**
Use the Admin API to create a webhook subscription for `PRODUCTS_UPDATE` pointing to the URL above.

## Test locally
- `npm i -g netlify-cli`
- `npm i`
- `netlify dev`
- Expose via `ngrok http 8888` (or Netlify tunneling) and use the public URL in your webhook.
- Use a real webhook from Shopify or simulate with a recorded payload and correct HMAC.

## Notes
- Mutations `collectionAddProducts` / `collectionRemoveProducts` are idempotent.
- If a city variant is missing for a product, no action is taken for that city.
- You can switch to metafield-based city detection by setting `CITY_SOURCE=metafield`.
