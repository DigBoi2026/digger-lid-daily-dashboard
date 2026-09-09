/* Unit tests for the Pace vs Forecast row in app.js.
   Run: node source/test_pace.js   (exit 0 = all pass)

   Two faults this pins:

   1. `projSpend` was matched with /^Projected Spend/i while the sheet's row is
      "PROJECTED MEDIA SPEND". Nothing ever matched, so the field was null on
      every day and the Meta Spend row read "no forecast" — not because there was
      no forecast, but because nothing looked in the right place.

   2. paceRow() required `forecast > 0`. September's profit plan is -$233/day, so
      a planned LOSS was reported as "no forecast" while actual profit sat $8.5K
      ahead of it. Good news, hidden by a sign test. A percentage of a negative
      target is meaningless, so those rows state the gap instead.

   paceRow lives inside app.js, which is a browser script with no exports, so the
   function is extracted by source and evaluated here. That keeps the assertions
   against the shipped code rather than a copy that can drift. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const grab = name => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} not found in app.js`);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`${name} not closed`);
};

const PACE_LINE = 66.7;
const money = n => (n == null || isNaN(n)) ? '—'
  : (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-AU');
eval(grab('paceRow'));

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) pass++;
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `\n      got: ${got}` : '')); }
};
const row = (a, f, low) => paceRow('X', a, f, money, low);
const widthOf = html => { const m = /width:([\d.]+)%/.exec(html); return m ? +m[1] : null; };

/* ---------------- a genuinely absent forecast ---------------- */
const none = row(117000, null);
ok('null forecast says "no forecast"', /no forecast/.test(none), none.match(/pr-sub">([^<]*)/)?.[1]);
ok('null forecast draws no fill', widthOf(none) === 0, widthOf(none));
ok('null forecast uses the muted bar', /var\(--muted\)/.test(none));

/* ---------------- a positive target: unchanged behaviour ---------------- */
const pos = row(116813, 68558);   // the live 7-day figures behind the screenshot
ok('positive target shows attainment %', /170% of \$68,558 target/.test(pos), pos);
ok('ahead of a positive target fills past the mark', widthOf(pos) > PACE_LINE, widthOf(pos));
ok('ahead of target is good-coloured', /var\(--good\)/.test(pos));
ok('running off the scale shows the overflow marker', /ovf/.test(pos));

const behind = row(30000, 68558);
ok('behind a positive target is warn-coloured', /var\(--warn\)/.test(behind));
ok('behind target fills below the mark', widthOf(behind) < PACE_LINE, widthOf(behind));
ok('behind target shows its own %', /44% of/.test(behind), behind);

/* ---------------- a NEGATIVE target — the September profit case ---------------- */
// 7-day profit +$6.9K against a plan of 7 x -$233 = -$1,631.
const neg = row(6930, -1631);
ok('a negative target is NOT reported as "no forecast"', !/no forecast/.test(neg), neg);
ok('a negative target states the gap, not a percentage',
   /ahead of a -\$1,631 target/.test(neg) && !/% of/.test(neg), neg.match(/pr-sub">(.*?)<\/div>/s)?.[1]);
ok('the gap is the absolute distance', /\$8,561 ahead of/.test(neg), neg);
ok('beating a negative target is good-coloured', /var\(--good\)/.test(neg));
ok('beating it by 5x runs off the scale', widthOf(neg) === 100 && /ovf/.test(neg), widthOf(neg));

const negBehind = row(-5000, -1631);
ok('missing a negative target is warn-coloured', /var\(--warn\)/.test(negBehind));
ok('missing it reads "behind"', /behind a -\$1,631 target/.test(negBehind), negBehind);
ok('missing it fills below the mark', widthOf(negBehind) < PACE_LINE, widthOf(negBehind));
ok('fill never goes negative', widthOf(row(-99999, -1631)) === 0, widthOf(row(-99999, -1631)));

const negExact = row(-1631, -1631);
ok('exactly on a negative target lands on the mark',
   Math.abs(widthOf(negExact) - PACE_LINE) < 0.01, widthOf(negExact));

/* ---------------- a target of exactly zero ---------------- */
ok('zero target, positive actual → ahead, no division by zero',
   /ahead of a \$0 target/.test(row(500, 0)), row(500, 0));
ok('zero target, negative actual → behind', /behind a \$0 target/.test(row(-500, 0)), row(-500, 0));
ok('zero target, zero actual → on the mark',
   Math.abs(widthOf(row(0, 0)) - PACE_LINE) < 0.01, widthOf(row(0, 0)));

/* ---------------- spend rows invert "good" ---------------- */
ok('under budget is good for spend', /var\(--good\)/.test(row(20000, 29000, true)));
ok('over budget is warn for spend', /var\(--warn\)/.test(row(40000, 29000, true)));
ok('spend rows say "budget", not "target"', /budget/.test(row(20000, 29000, true)));

/* ---------------- the label the sheet actually uses ---------------- */
const D = require('../api/data.js');
const projRe = /^Projected\b.*\bSpend/i;
ok('the sheet\'s real row label matches', projRe.test('PROJECTED MEDIA SPEND'));
ok('the old shorter label still matches', projRe.test('Projected Spend'));
ok('it does not swallow the actual spend row', !projRe.test('Total Meta Ad Spend'));
ok('it does not swallow the forecast rows',
   !projRe.test('FORECAST REVENUE') && !projRe.test('FORECAST PROFIT'));

console.log(`\npace: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
