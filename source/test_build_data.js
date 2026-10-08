/* Credential handling in source/build_data.py — the one thing that stands
   between the nightly job and a 401.

   The bug this exists to stop coming back: `os.environ.get(KEY, DEFAULT)`
   returns DEFAULT only when the key is ABSENT. GitHub Actions never leaves a
   mapped secret absent — `DASHBOARD_USER: ${{ secrets.DASHBOARD_USER }}` with no
   such secret is set to the EMPTY STRING — so the script authenticated as
   `:password` and the gate answered 401. build_snapshots.js used `||` and was
   unaffected, which is why region and pulse refreshed on the very run where
   data.js failed. One builder's convention silently differed from the other's.

   Tested against a real local gate rather than by reading the source, so it
   checks the bytes that actually reach the wire. */
const http = require('http');
const { execFileSync, execFile } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, g) => { if (c) pass++; else { fail++; console.log(`  ✗ ${n}` + (g !== undefined ? `  (got ${JSON.stringify(g)})` : '')); } };

/* python3 is how data.js is built; if it is not on this machine there is
   nothing to test rather than something to fail. */
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); }
catch (e) {
  console.log('build_data credentials: skipped — no python3 on this machine');
  process.exit(0);
}

/* A gate that refuses everything and reports WHO knocked, so the test can see
   the username and password the script actually sent. */
let seen = null;
const server = http.createServer((req, res) => {
  const h = req.headers.authorization || '';
  const raw = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString('utf8') : '';
  const i = raw.indexOf(':');
  seen = i < 0 ? { user: raw, pass: '' } : { user: raw.slice(0, i), pass: raw.slice(i + 1) };
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end('{"error":"nope"}');
});

/* ASYNC on purpose. execFileSync blocks node's event loop, so the server below
   could never answer the python this test had just launched: every request sat
   until urllib's own timeout. The subprocess has to run while the loop is free
   to serve it. */
function run(env) {
  seen = null;
  const url = `http://127.0.0.1:${server.address().port}/api/data`;
  return new Promise(resolve => {
    execFile('python3', [path.join(__dirname, 'build_data.py'), '--dry-run', '--url', url],
      { env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 20000 },
      (err, stdout, stderr) => resolve({ out: String(stdout || '') + String(stderr || ''), seen }));
  });
}

server.listen(0, '127.0.0.1', async () => {
  /* The exact shape of the live failure: the secret is mapped but does not
     exist, so the variable is present and empty. */
  let r = await run({ DASHBOARD_USER: '', DASHBOARD_PASSWORD: 'secret' });
  ok('an empty DASHBOARD_USER falls back to the default, not to ""',
     r.seen && r.seen.user === 'diggerlid', r.seen);
  ok('and the 401 message names the user it actually tried',
     /rejected user "diggerlid"/.test(r.out), r.out.slice(0, 120));

  r = await run({ DASHBOARD_PASSWORD: 'secret' });
  ok('an absent DASHBOARD_USER behaves the same as an empty one',
     r.seen && r.seen.user === 'diggerlid', r.seen);

  r = await run({ DASHBOARD_USER: '   ', DASHBOARD_PASSWORD: 'secret' });
  ok('a whitespace-only DASHBOARD_USER is not a username',
     r.seen && r.seen.user === 'diggerlid', r.seen);

  r = await run({ DASHBOARD_USER: 'someoneelse', DASHBOARD_PASSWORD: 'secret' });
  ok('a real DASHBOARD_USER is still honoured', r.seen && r.seen.user === 'someoneelse', r.seen);

  /* A secret pasted into GitHub's box keeps whatever came with it, and a
     trailing newline off a copied password is a 401 with nothing to see. */
  r = await run({ DASHBOARD_PASSWORD: '  hunter2\n' });
  ok('the password is trimmed at both ends before it is sent',
     r.seen && r.seen.pass === 'hunter2', r.seen && r.seen.pass);

  /* Trimming the ENDS only: a password may legitimately contain a space. */
  r = await run({ DASHBOARD_PASSWORD: 'two words' });
  ok('a space inside the password survives', r.seen && r.seen.pass === 'two words', r.seen && r.seen.pass);

  r = await run({ DASHBOARD_PASSWORD: '   ' });
  ok('a whitespace-only password is treated as no password at all',
     /Set DASHBOARD_PASSWORD/.test(r.out) && r.seen === null, [r.out.slice(0, 80), r.seen]);

  server.close();
  console.log(`\nbuild_data credentials: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
