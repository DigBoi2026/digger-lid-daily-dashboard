/* Build the trailing-3-day product window ("3") for shopify_data.js from a fresh
   ShopifyQL pull (net_sales/orders/net_items_sold by product, SINCE -3d ending
   yesterday). Reuses the existing title→category map so tagging stays consistent.
   Run: node source/build_win3.js   → prints the "3": [...] window block. */
const w = global.window = {};
require('../shopify_data.js');
const D = window.DL_SHOPIFY;

// title → category key, from the authoritative 12M window (includes Mobile Protection).
const tmap = {};
D.windows['12M'].forEach(r => tmap[r.t] = r.k);

// Fresh pull: trailing 3 days (Jun 29 – Jul 1), net_sales / orders / net_items_sold.
const rows = [
  ["KAJO Grease Packs", 54602.99, 180, 3760],
  ["Pro Excavator Enclosure", 45938.77, 85, 93],
  ["PRO Mat", 39651.48, 202, 254],
  ["1.7 Tonne Excavator Cover", 14404.02, 53, 52],
  ["Battery Grease Gun KAJO Adapter", 8568.16, 136, 155],
  ["Quicky Cover", 8524.70, 74, 85],
  ["DiggerShield Kit", 5318.19, 6, 6],
  ["KAJO Grease Gun", 4403.91, 63, 40],
  [null, 3663.00, 1, 1],
  ["Draw Bar Cover", 2711.75, 29, 31],
  ["Package Protection", 2670.99, 292, 291],
  ["Mini Loader Cover", 2476.34, 14, 14],
  ["Quick Release Grease Coupler", 2331.73, 101, 125],
  ["Universal / Engine Covers", 2082.00, 20, 26],
  ["Excavator Phone Cradle", 1555.44, 43, 50],
  ["Skid Steer Loader Cover", 1120.92, 3, 3],
  ["Hydraulic Coupling Cap Set", 783.36, 30, 76],
  ["Digger Wipes", 576.91, 38, 57],
  ["The Hauler Luggage Bag", 408.18, 1, 1],
  ["Drink/ Tool Caddy", 368.28, 11, 12],
  ["Micro Excavator Cover", 203.64, 1, 1],
  ["Excavator Boom Bottle Opener", 171.24, 15, 16],
  ["DIGHEAD  Beanie", 118.23, 5, 6],
  ["Trucker Cap", 98.19, 3, 3],
];

const cat = t => {
  if (t == null) return "other";
  if (tmap[t]) return tmap[t];
  const s = t.replace(/\s+/g, " ").trim();
  if (tmap[s]) return tmap[s];
  const l = s.toLowerCase();
  if (/grease|kajo|coupler/.test(l)) return "grease";
  if (/mat|hauler/.test(l)) return "mobile";
  if (/beanie|cap|opener/.test(l)) return "merch";
  return "other";
};

const out = rows
  .filter(r => r[1] > 0)
  .map(([t, net, o, u]) => `{t:${JSON.stringify(t == null ? "(untitled)" : t)},k:"${cat(t)}",net:${net},u:${u},o:${o}}`);

const total = rows.reduce((a, r) => a + r[1], 0);
console.error(`3-day window: ${out.length} products, net $${Math.round(total).toLocaleString()}`);
console.log('    "3": [\n      ' + out.join(',\n      ') + '\n    ],');
