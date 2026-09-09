// PostHog behavioural snapshot (project 475333, refreshed through 2026-07-05). Read-only.
// Daily site signals for the Daily Pulse page. Live /api/pulse extends this to yesterday.
// NOTE: tracking began 2026-06-18 (errors/dead-clicks 2026-06-25, rage-clicks 2026-06-20).
// null = not yet tracked that day (NOT zero) — keeps baselines honest.
window.DL_PULSE = {
  meta: { source:"PostHog · web analytics", asOf:"2026-07-05", trackedFrom:"2026-06-18",
    note:"Daily site events (UTC). Baselines lengthen automatically as history accrues." },
  days: ["2026-06-18","2026-06-19","2026-06-20","2026-06-21","2026-06-22","2026-06-23","2026-06-24","2026-06-25","2026-06-26","2026-06-27","2026-06-28","2026-06-29","2026-06-30","2026-07-01","2026-07-02","2026-07-03","2026-07-04","2026-07-05"],
  series: {
    sessions: [4097,4673,3131,2836,2883,2705,2972,2509,3038,2653,3223,4566,5912,3655,2601,2363,3170,3355],
    pageviews: [5112,4870,7485,8892,8572,7526,8636,7197,8437,7402,9986,13793,18589,8485,6157,4999,6283,6721],
    atc: [703,619,433,532,479,418,542,347,478,376,680,964,1161,233,172,124,125,136],
    checkoutStarted: [156,177,121,153,152,157,141,84,129,88,156,245,350,58,37,32,48,34],
    orders: [139,114,97,128,111,105,111,71,86,83,135,226,266,45,40,33,28,25],
    errors: [null,null,null,null,null,null,null,260,314,334,437,660,926,419,338,229,324,349],
    rageclicks: [null,null,228,295,262,251,270,261,254,245,381,444,616,252,182,110,132,166],
    deadclicks: [null,null,null,null,null,null,null,82,106,82,142,32,53,452,291,232,329,304]
  },
  channels: {
    "Organic Social": [1772,1618,1843,1786,1900,1742,1815,1552,2134,1845,2009,3001,3828,2497,1718,1583,2197,2407],
    "Direct": [560,790,584,552,464,444,593,475,400,377,676,818,1078,490,388,371,491,441],
    "Referral": [1445,1957,362,109,111,121,139,126,106,85,94,133,228,112,83,90,88,84],
    "Organic Search": [299,289,198,211,276,253,252,239,238,201,261,346,483,312,251,179,181,227],
    "Paid Social": [null,null,128,154,115,133,140,102,153,136,125,219,243,228,154,136,211,190],
    "Email": [11,14,12,22,13,9,32,10,6,6,57,41,50,14,3,2,1,0]
  }
};
if (typeof module !== 'undefined' && module.exports) module.exports = window.DL_PULSE;
