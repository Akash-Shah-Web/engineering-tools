// Records docs/loopforge-demo.gif: control room playback with a live tuning change.
// Every frame is the real page state (simulated loop of the fitted TCLab model).
'use strict';
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const outDir = path.join(__dirname, '..', 'docs');
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lfgif-'));
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  await p.route(/^https?:/, r => r.abort());
  await p.goto('file://' + path.join(__dirname, '..', 'index.html') + '?t=0');
  await p.waitForFunction(() => window.LoopForgeApp && window.LoopForgeApp.S.ready);
  await p.evaluate(() => { const A = window.LoopForgeApp; A.S.loop.aw = 'none'; document.getElementById('awSel').value = 'none'; A.S.loop.r1 = 65; A.recompute(); A.setTags(['aw']); });
  await p.waitForTimeout(400);
  const room = p.locator('#room');
  let n = 0;
  const shoot = async () => { await room.screenshot({ path: path.join(tmp, `f${String(n++).padStart(3, '0')}.png`) }); };
  const stepTo = async (t) => { await p.evaluate(t => { const A = window.LoopForgeApp; A.S.play.t = t; A.frame(true); }, t); await p.waitForTimeout(60); };
  await p.evaluate(() => window.LoopForgeApp.setPlaying(false));
  for (let t = 0; t <= 300; t += 10) { await stepTo(t); await shoot(); }
  // switch on back-calculation anti-windup and replay
  await p.evaluate(() => { const A = window.LoopForgeApp; A.S.loop.aw = 'backcalc'; document.getElementById('awSel').value = 'backcalc'; A.recompute(); });
  await p.waitForTimeout(300);
  for (let t = 0; t <= 300; t += 10) { await stepTo(t); await shoot(); }
  // sweep the sample time
  for (const pos of [560, 640, 720, 800, 720, 640, 560, 400]) {
    await p.evaluate(v => { const el = document.getElementById('sl-Ts'); el.value = v; el.dispatchEvent(new Event('input')); }, pos);
    await p.waitForTimeout(250); await stepTo(160); await shoot(); await shoot();
  }
  await b.close();
  const py = `
import glob, sys
from PIL import Image
fs = sorted(glob.glob(sys.argv[1] + '/f*.png'))
ims = []
for f in fs:
    im = Image.open(f).convert('RGB')
    w = 900; im = im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)
    ims.append(im.quantize(colors=128, method=Image.MEDIANCUT, dither=Image.NONE))
ims[0].save(sys.argv[2], save_all=True, append_images=ims[1:], duration=110, loop=0, optimize=True)
print(len(ims), 'frames')
`;
  fs.mkdirSync(outDir, { recursive: true });
  console.log(execFileSync('python3', ['-c', py, tmp, path.join(outDir, 'loopforge-demo.gif')]).toString().trim());
  fs.rmSync(tmp, { recursive: true, force: true });
})();
