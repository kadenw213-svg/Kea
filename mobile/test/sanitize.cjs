// The document viewer's sanitizer (mobile/src/sanitize.ts) against known XSS and mutation-XSS payloads, in Electron's
// Chromium (the same engine as Android's WebView): each payload is cleaned, the nodes inserted the way the Viewer does,
// and nothing may run, link to a script, or survive that shouldn't.
//   npx electron mobile/test/sanitize.cjs        (exit code 0: all passed)
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const esbuild = require('esbuild');

const bundle = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'sanitize.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'KeaSanitize',
  platform: 'browser',
  write: false
}).outputFiles[0].text;

const cases = {
  mxssMath: '<math><mtext><table><mglyph><style><img src=x onerror=window.__pwn=1>',
  mxssMathAlt: '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=window.__pwn=1&gt;">',
  noscript: '<noscript><p title="</noscript><img src=x onerror=window.__pwn=2>"></p></noscript>',
  svgStyle: '<svg><style><img src=x onerror=window.__pwn=3></style></svg>',
  svgLink: '<svg><a href="javascript:window.__pwn=4"><text y=20>x</text></a></svg>',
  svgXlink: '<svg><a xlink:href="javascript:window.__pwn=4"><text y=20>x</text></a></svg>',
  foreignObject: '<svg><foreignObject><iframe srcdoc="<script>parent.__pwn=5</script>"></iframe></foreignObject></svg>',
  textarea: '<textarea><p title="</textarea><img src=x onerror=window.__pwn=6>"></textarea>',
  script: '<script>window.__pwn=7</script><p>hi</p>',
  handler: '<img src=x onerror="window.__pwn=8"><div onmouseover="window.__pwn=8">x</div>',
  jsLinkTab: '<a href="java&#9;script:window.__pwn=9">click</a>',
  dataHtmlLink: '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  form: '<form action="https://evil.example/"><input name=x><button formaction="javascript:window.__pwn=10">go</button></form>',
  iframe: '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">',
  animate: '<svg><animate attributeName="href" to="javascript:window.__pwn=11"/><set attributeName="onload" to="window.__pwn=11"/></svg>',
  metaRefresh: '<meta http-equiv="refresh" content="0;url=javascript:window.__pwn=12"><base href="javascript:/">',
  overlay: '<a href="https://example.invalid" style="position:fixed;inset:0;z-index:9999">overlay</a>',
  cssUrl: '<p style="background:url(https://evil.example/t.png)">x</p>',
  // The same two in CSS escapes, comments and other spellings the browser still reads as the real thing.
  escFixed: '<a id="e1" href="https://example.invalid" style="position:fi\\78 ed;inset:0;z-index:9999">a</a>',
  escFixed2: '<a id="e2" href="https://example.invalid" style="position:fixe\\64 ;top:0">a</a>',
  escFixed3: '<a id="e3" href="https://example.invalid" style="position:\\000066ixed;top:0">a</a>',
  escName: '<a id="e4" href="https://example.invalid" style="p\\6Fsition:fixed;top:0">a</a>',
  escNewline: '<a id="e5" href="https://example.invalid" style="position:fi\\78\ned;top:0">a</a>',
  comment: '<a id="e6" href="https://example.invalid" style="position:/**/fixed;top:0">a</a>',
  commentName: '<a id="e7" href="https://example.invalid" style="position/*x*/:fixed;top:0">a</a>',
  important: '<a id="e8" href="https://example.invalid" style="POSITION:FIXED!important;top:0">a</a>',
  sticky: '<a id="e9" href="https://example.invalid" style="position:sticky;top:0">a</a>',
  escUrl: '<p id="e10" style="background:\\75 rl(https://evil.example/t.png)">x</p>',
  escUrl2: '<p id="e11" style="background-image:u\\72l(https://evil.example/t.png)">x</p>',
  colorUrl: '<p id="e12" style="background-color:var(--x);color:expression(alert(1))">x</p>',
  transform: '<p id="e13" style="transform:translate(0,0);z-index:9;inset:0;top:0;width:100vw">x</p>',
  negative: '<p id="e14" style="margin-top:-9999px;margin-left:-100px;padding:calc(1px + 1px)">x</p>',
  safeStyles: '<p id="s1" style="color:#f00;background-color:rgb(1, 2, 3);font-weight:700;font-style:italic;text-decoration:underline;text-align:center;margin:1px 2em;padding:4px;position:fixed">x</p>',
  fileImg: '<img src="/_capacitor_file_/data/user/0/com.kea.scholar/shared_prefs/kea.xml">',
  dataSvgImg: '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
  svgShapes: '<svg viewBox="0 0 10 10"><rect x="1" y="2" width="3" height="4" fill="red"/><text x="1" y="20">t</text></svg>',
  keep: '<h1>Title</h1><p style="color:red"><b>Bold</b> <a href="https://example.com/x">web</a> <a href="mailto:a@b.c">m</a></p><img src="data:image/png;base64,iVBORw0KGgo=" alt="p"><img src="blob:https://localhost/1234"><table><tr><td>1</td></tr></table>'
};

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const tmp = path.join(os.tmpdir(), 'kea-sanitize-test.html');
  fs.writeFileSync(tmp, '<!doctype html><body></body>');
  await w.loadFile(tmp);
  await w.webContents.executeJavaScript(bundle);
  const out = await w.webContents.executeJavaScript(`(async () => {
    const cases = ${JSON.stringify(cases)};
    const out = {};
    for (const [k, v] of Object.entries(cases)) {
      window.__pwn = 0;
      const host = document.createElement('article');
      document.body.appendChild(host);
      host.replaceChildren(KeaSanitize.safeFragment(v).cloneNode(true));
      await new Promise((r) => setTimeout(r, 200));
      out[k] = { html: host.innerHTML, fired: window.__pwn };
      host.remove();
    }
    return out;
  })()`);
  const fails = [];
  for (const [k, r] of Object.entries(out)) {
    const h = r.html.toLowerCase();
    if (r.fired) fails.push(`${k}: script ran`);
    if (/javascript:|data:text|vbscript:/.test(h)) fails.push(`${k}: script address kept`);
    if (/\son[a-z]+=/.test(h)) fails.push(`${k}: event handler kept`);
    if (/<(script|iframe|object|embed|form|input|button|textarea|style|math|mglyph|foreignobject|animate|set|meta|base|noscript)\b/.test(h)) fails.push(`${k}: forbidden element kept: ${h.slice(0, 120)}`);
    if (/position:\s*fixed|url\(/.test(h)) fails.push(`${k}: unsafe style kept`);
    if (/_capacitor_file_|data:image\/svg/.test(h)) fails.push(`${k}: unsafe picture kept`);
  }
  const keep = out.keep.html;
  for (const want of ['<h1>Title</h1>', '<b>Bold</b>', 'href="https://example.com/x"', 'href="mailto:a@b.c"', 'style="color: red"', 'src="data:image/png;base64,', 'src="blob:https://localhost/1234"', '<td>1</td>'])
    if (!keep.includes(want)) fails.push(`keep: lost ${want} (${keep})`);
  // Whatever the spelling, nothing of a page's layout or addresses survives; the browser's computed position says so.
  for (const k of ['escFixed', 'escFixed2', 'escFixed3', 'escName', 'escNewline', 'comment', 'commentName', 'important', 'sticky', 'escUrl', 'escUrl2', 'colorUrl', 'transform', 'negative'])
    if (/\sstyle=/.test(out[k].html)) fails.push(`${k}: style kept: ${out[k].html}`);
  const safe = out.safeStyles.html;
  for (const want of ['color: rgb(255, 0, 0)', 'background-color: rgb(1, 2, 3)', 'font-weight: 700', 'font-style: italic', 'text-decoration-line: underline', 'text-align: center', 'margin-top: 1px', 'margin-left: 2em', 'padding-top: 4px'])
    if (!safe.includes(want)) fails.push(`safeStyles: lost ${want} (${safe})`);
  if (/position/.test(safe)) fails.push(`safeStyles: position kept (${safe})`);
  // (Drawings keep their shapes.)
  if (!out.svgShapes.html.includes('<rect x="1" y="2" width="3" height="4" fill="red"></rect>') || !out.svgShapes.html.includes('viewBox="0 0 10 10"')) fails.push(`svgShapes: lost attributes (${out.svgShapes.html})`);
  for (const [k, r] of Object.entries(out)) console.log(`${r.fired || fails.some((f) => f.startsWith(k + ':')) ? 'FAIL' : 'ok  '} ${k}: ${r.html.slice(0, 110)}`);
  if (fails.length) console.log('\n' + fails.join('\n'));
  console.log(fails.length ? `\n${fails.length} failure(s)` : '\nAll sanitizer checks passed.');
  app.exit(fails.length ? 1 : 0);
});
setTimeout(() => process.exit(3), 60000);
