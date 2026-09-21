#!/usr/bin/env node
/* RETIRED — this script never pulled anything.

   It was 149 lines with the months, country totals and AU state totals typed in
   as literals, down to `asOf:"2026-07-02"` as a string. Running it re-emitted
   that same July file, so region_data.js sat eighty-one days out of date while
   the page rendered it as current and nothing anywhere noticed.

   Its replacement pulls from the deployed API and stamps a real date:

       export DASHBOARD_PASSWORD='...'        # the SITE_PASSWORD gate
       node source/build_snapshots.js region

   Freshness of every committed snapshot is checked by:

       node source/check_snapshots.js

   The old figures are not lost — they are in this file's git history, and the
   snapshot it produced is region_data.js. */
console.error(`source/build_region.js is retired: it emitted hard-coded July 2026 figures.

  Use:  node source/build_snapshots.js region     (needs DASHBOARD_PASSWORD)
  Check: node source/check_snapshots.js
`);
process.exit(1);
