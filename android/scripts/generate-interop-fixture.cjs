// Run Catio's actual bundled WASM encoder; never handcraft protocol data.
// NODE_PATH may point to an existing Playwright installation.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const output = path.resolve(__dirname, '../app/src/androidTest/assets/interop');
(async () => {
  const browser = await chromium.launch({headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage();
    await page.goto(`${process.env.CATIO_URL || 'http://127.0.0.1:1420'}/vendor/cimbar/encoder.html`);
    await page.waitForFunction(() => window.initialized, {timeout: 30000});
    const payload = Buffer.alloc(32768);
    let seed = 0xcafecafe;
    for (let i = 0; i < payload.length; ++i) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; payload[i] = seed & 255;
    }
    const name = 'Catio-互通验证-🐈.bin';
    await page.evaluate(({bytes, name}) => {
      window.postMessage({channel: 'catio-cimbar', type: 'load', requestId: 'interop', name, buffer: new Uint8Array(bytes).buffer}, '*');
    }, {bytes: [...payload], name});
    await page.waitForFunction(() => window.loaded, {timeout: 30000});
    await page.evaluate(() => stop());
    fs.mkdirSync(output, {recursive: true});
    for (let i = 0; i < 12; ++i) {
      const png = await page.evaluate(() => {
        if (Module._cimbare_next_frame(0) < 0 || Module._cimbare_render() < 0) throw Error('Render failed');
        return Module.canvas.toDataURL('image/png').split(',')[1];
      });
      fs.writeFileSync(path.join(output, `frame-${String(i).padStart(2, '0')}.png`), Buffer.from(png, 'base64'));
    }
    fs.writeFileSync(path.join(output, 'expected.bin'), payload);
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({name, mode: 68, frames: 12, bytes: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex'), encoder: 'Catio bundled libcimbar v0.6.8'}, null, 2) + '\n');
    console.log(`Generated 12 real encoder frames in ${output}`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
