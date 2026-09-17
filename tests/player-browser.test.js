const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const lessons = [1, 2].map(id => ({
  version: 1, id, number: String(id).padStart(4, '0'), title: `Lesson ${id}`,
  audio: `mp3/${id}.mp3`, duration: 30,
  segments: [
    { id: 1, start: 1, end: 3, en: `Intro ${id}`, zh: `开场 ${id}` },
    { id: 2, start: 7, end: 9, en: `Hello ${id}`, zh: `你好 ${id}` },
    { id: 3, start: 10, end: 12, en: `Bye ${id}`, zh: `再见 ${id}` },
    { id: 4, start: 20, end: 22, en: `Outro ${id}`, zh: `结尾 ${id}` }
  ],
  dialog: { start: 7, end: 12, segmentIds: [2, 3] }
}));
const manifest = lessons.map(l => ({ id: l.id, number: l.number, title: l.title, mp3: l.audio, md: `md/${l.number}.md` }));
function wav() {
  const data = Buffer.alloc(30 * 8000);
  const out = Buffer.alloc(44 + data.length);
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(8000, 24); out.writeUInt32LE(8000, 28); out.writeUInt16LE(1, 32);
  out.writeUInt16LE(8, 34); out.write('data', 36); out.writeUInt32LE(data.length, 40);
  data.fill(128); data.copy(out, 44); return out;
}
const audioBytes = wav();

async function pageWithFixtures(t, delayedNumber, certificateFiles = false) {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('https://player.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname.slice(1);
    requests.push(pathname);
    if (pathname === '' || pathname === 'index.html') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'index.html')) });
    if (pathname === 'player.js' || pathname === 'player-core.js' || pathname === 'desktop-subtitles.js') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, pathname)) });
    if (pathname === 'manifest.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(manifest) });
    if (pathname === 'certificate-setup.html' || pathname === 'assets/EnglishPod-RootCA.crt') return route.fulfill({ status: certificateFiles ? 200 : 404, body: '' });
    if (pathname.startsWith('lessons/')) {
      const item = lessons.find(l => pathname === `lessons/englishpod_${l.number}.json`);
      if (!item) return route.fulfill({ status: 404 });
      if (item.number === delayedNumber) await gate;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(item) });
    }
    if (pathname.startsWith('mp3/')) {
      const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
      if (!range) return route.fulfill({ contentType: 'audio/wav', body: audioBytes, headers: { 'Accept-Ranges': 'bytes' } });
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), audioBytes.length - 1) : audioBytes.length - 1;
      return route.fulfill({ status: 206, body: audioBytes.subarray(start, end + 1), headers: {
        'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${audioBytes.length}`,
        'Content-Length': String(end - start + 1)
      } });
    }
    if (pathname.startsWith('md/')) return route.fulfill({ contentType: 'text/markdown', body: '# Knowledge' });
    return route.fulfill({ status: 404 });
  });
  await page.goto('https://player.test/');
  return { page, requests, release };
}

test('both text views share bilingual sentences; dialog filters IDs and Chinese starts hidden', async t => {
  const { page, requests } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  assert.equal(await page.locator('#srtContainer .sentence').count(), 4);
  assert.equal(await page.locator('#txtContainer .sentence').count(), 4);
  assert.equal(await page.getByText('你好 1').first().isVisible(), false);
  await page.getByLabel('显示中文').check();
  assert.equal(await page.getByText('你好 1').first().isVisible(), true);
  await page.getByLabel('对话').check();
  assert.deepEqual(await page.locator('#srtContainer .sentence .en').allTextContents(), ['Hello 1', 'Bye 1']);
  assert.deepEqual(await page.locator('#txtContainer .sentence .en').allTextContents(), ['Hello 1', 'Bye 1']);
  assert.ok(requests.includes('lessons/englishpod_0001.json'));
});

test('sentence click seeks and plays; loop repeats selected sentence and a new click changes target', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().click();
  await page.waitForFunction(() => !document.getElementById('audio').paused);
  assert.equal(await page.locator('#audio').evaluate(a => Math.round(a.currentTime)), 7);
  await page.getByLabel('单句循环').check();
  await page.locator('#audio').evaluate(a => { a.currentTime = 9.1; a.dispatchEvent(new Event('timeupdate')); });
  await page.waitForFunction(() => Math.abs(document.getElementById('audio').currentTime - 7) < 0.5);
  await page.getByRole('button', { name: 'Bye 1' }).first().click();
  assert.equal(await page.locator('#audio').evaluate(a => Math.round(a.currentTime)), 10);
  await page.locator('#audio').evaluate(a => { a.currentTime = 12.1; a.dispatchEvent(new Event('timeupdate')); });
  await page.waitForFunction(() => Math.abs(document.getElementById('audio').currentTime - 10) < 0.5);
  assert.equal(await page.locator('.playlist-item.active').count(), 1);
  assert.match(await page.locator('.playlist-item.active').innerText(), /Lesson 1/);
});

test('dialog native seek clamps, sequential advances at boundary, loop restarts', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.getByLabel('对话').check();
  await page.locator('#audio').evaluate(a => { a.currentTime = 1; });
  await page.waitForFunction(() => Math.abs(document.getElementById('audio').currentTime - 7) < 0.5);
  assert.match(await page.locator('.playlist-item.active').innerText(), /Lesson 1/);
  await page.getByRole('button', { name: 'Hello 1' }).first().click();
  await page.locator('#audio').evaluate(a => { a.currentTime = 12.1; a.dispatchEvent(new Event('timeupdate')); });
  await page.waitForFunction(() => document.getElementById('playerInfo').textContent.includes('Lesson 2'));
  await page.getByLabel('单曲循环').check();
  await page.getByRole('button', { name: 'Hello 2' }).first().click();
  await page.locator('#audio').evaluate(a => { a.currentTime = 12.1; a.dispatchEvent(new Event('timeupdate')); });
  await page.waitForFunction(() => document.getElementById('audio').currentTime < 8);
  assert.match(await page.locator('.playlist-item.active').innerText(), /Lesson 2/);
});

test('late lesson response never replaces a newly selected lesson', async t => {
  const { page, release } = await pageWithFixtures(t, '0001');
  assert.equal(await page.getByLabel('显示中文').isDisabled(), true);
  assert.equal(await page.getByLabel('单曲循环').isDisabled(), true);
  assert.equal(await page.locator('#audio').evaluate(a => a.controls), false);
  await page.locator('.playlist-item').nth(1).click();
  await page.getByRole('button', { name: 'Hello 2' }).first().waitFor();
  assert.equal(await page.getByLabel('显示中文').isDisabled(), false);
  release();
  await page.waitForTimeout(100);
  assert.deepEqual(await page.locator('#srtContainer .sentence .en').allTextContents(), ['Intro 2', 'Hello 2', 'Bye 2', 'Outro 2']);
  assert.match(await page.locator('#playerInfo').innerText(), /Lesson 2/);
});

test('natural audio end advances even when the element is already paused', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.locator('#audio').evaluate(a => { a.pause(); a.dispatchEvent(new Event('ended')); });
  await page.waitForFunction(() => document.getElementById('playerInfo').textContent.includes('Lesson 2'));
});

test('natural audio end restarts the lesson in lesson-loop mode', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.getByLabel('单曲循环').check();
  await page.locator('#audio').evaluate(a => { a.pause(); a.dispatchEvent(new Event('ended')); });
  await page.waitForFunction(() => !document.getElementById('audio').paused);
  assert.match(await page.locator('#playerInfo').innerText(), /Lesson 1/);
});

test('switching into dialog clamps playback and a paused boundary never advances', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.locator('#audio').evaluate(a => { a.currentTime = 20; });
  await page.getByLabel('对话').check();
  await page.waitForFunction(() => Math.abs(document.getElementById('audio').currentTime - 7) < 0.5);
  await page.locator('#audio').evaluate(a => { a.pause(); a.currentTime = 12; a.dispatchEvent(new Event('timeupdate')); });
  assert.match(await page.locator('#playerInfo').innerText(), /Lesson 1/);
});

test('TXT sentence supports keyboard playback and shares language state', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.getByRole('button', { name: 'TXT 全文' }).click();
  await page.locator('#txtContainer .sentence').nth(1).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => Math.abs(document.getElementById('audio').currentTime - 7) < 0.5);
  await page.getByLabel('显示中文').check();
  assert.equal(await page.locator('#txtContainer .sentence .zh').nth(1).isVisible(), true);
  await page.getByLabel('显示中文').uncheck();
  assert.equal(await page.locator('#txtContainer .sentence .zh').nth(1).isVisible(), false);
});

test('rapid sentence clicks keep the latest sentence playing after older play settles', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 1);
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('#srtContainer .sentence');
    buttons[1].click();
    buttons[2].click();
  });
  await page.waitForTimeout(350);
  const state = await page.locator('#audio').evaluate(a => ({ paused: a.paused, time: a.currentTime }));
  assert.equal(state.paused, false);
  assert.ok(state.time >= 10 && state.time < 12, `unexpected playback time ${state.time}`);
});

test('an old episode play request cannot stop playback in a newly selected episode', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 1);
  await page.evaluate(() => {
    document.querySelectorAll('#srtContainer .sentence')[1].click();
    document.querySelectorAll('.playlist-item')[1].click();
  });
  await page.getByRole('button', { name: 'Hello 2' }).first().click();
  await page.waitForTimeout(350);
  const state = await page.locator('#audio').evaluate(a => ({ paused: a.paused, time: a.currentTime, src: a.currentSrc }));
  assert.equal(state.paused, false);
  assert.ok(state.time >= 7 && state.time < 9, `unexpected playback time ${state.time}`);
  assert.match(state.src, /mp3\/2\.mp3$/);
});

test('pausing after a sentence click is not undone by its pending play request', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 1);
  await page.evaluate(() => {
    document.querySelectorAll('#srtContainer .sentence')[1].click();
    document.getElementById('audio').pause();
  });
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#audio').evaluate(a => a.paused), true);
});

test('rounded-down audio position settles without repeated seeks at dialog start', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 2);
  await page.locator('#audio').evaluate(a => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    a.reviewSeekCount = 0;
    Object.defineProperty(a, 'currentTime', {
      configurable: true,
      get() { return Math.max(0, descriptor.get.call(this) - .000001); },
      set(time) { this.reviewSeekCount++; descriptor.set.call(this, time); }
    });
  });
  await page.getByLabel('对话').check();
  await page.waitForTimeout(200);
  await page.locator('#audio').evaluate(a => {
    for (let i = 0; i < 4; i++) {
      a.dispatchEvent(new Event('seeked'));
      a.dispatchEvent(new Event('timeupdate'));
    }
  });
  const result = await page.locator('#audio').evaluate(a => ({ time: a.currentTime, seeks: a.reviewSeekCount, seeking: a.seeking }));
  assert.ok(Math.abs(result.time - 7) < .00001);
  assert.ok(result.seeks <= 2, `expected a settled seek, got ${result.seeks} writes`);
  assert.equal(result.seeking, false);
});


test('ordinary playback leaves no old selection marker; only sentence looping marks its target', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Intro 1' }).first().click();
  await page.locator('#audio').evaluate(a => { a.pause(); a.currentTime = 10.5; a.dispatchEvent(new Event('timeupdate')); });
  await page.waitForFunction(() => document.querySelector('#srtContainer .sentence.active')?.dataset.id === '3');
  assert.equal(await page.locator('.sentence.selected').count(), 0);
  await page.getByLabel('单句循环').check();
  for (const pane of ['srtContainer', 'txtContainer']) {
    assert.equal(await page.locator(`#${pane} .sentence.selected`).count(), 1);
    assert.equal(await page.locator(`#${pane} .sentence.selected`).getAttribute('data-id'), '1');
  }
  await page.getByLabel('单句循环').uncheck();
  assert.equal(await page.locator('.sentence.selected').count(), 0);
});


test('gap highlight toggle updates both views immediately without seeking or changing selection', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  const toggle = page.getByLabel('空白间隔保留高亮');
  assert.equal(await toggle.isChecked(), true);
  await toggle.uncheck();
  await page.locator('#audio').evaluate(a => { a.pause(); a.currentTime = 5; a.dispatchEvent(new Event('timeupdate')); });
  assert.equal(await page.locator('.sentence.active').count(), 0);
  await toggle.check();
  for (const pane of ['srtContainer', 'txtContainer']) {
    assert.equal(await page.locator(`#${pane} .sentence.active`).getAttribute('data-id'), '1');
  }
  assert.equal(await page.locator('#audio').evaluate(a => a.currentTime), 5);
  assert.equal(await page.locator('.sentence.selected').count(), 0);
  await toggle.uncheck();
  assert.equal(await page.locator('.sentence.active').count(), 0);
  await toggle.check();
  await page.locator('#audio').evaluate(a => { a.currentTime = 7.5; a.dispatchEvent(new Event('timeupdate')); });
  await page.waitForFunction(() => document.querySelector('#srtContainer .active')?.dataset.id === '2');
  await page.locator('#audio').evaluate(a => { a.currentTime = 0; a.dispatchEvent(new Event('timeupdate')); });
  await page.waitForFunction(() => document.querySelectorAll('.sentence.active').length === 0);
  await page.locator('#audio').evaluate(a => { a.currentTime = 25; a.dispatchEvent(new Event('timeupdate')); });
  assert.equal(await page.locator('.sentence.active').count(), 0);
});


test('desktop subtitles share playback, translation, dialog navigation and reopen cleanly', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  await page.waitForFunction(() => !!window.documentPictureInPicture.window?.document.querySelector('#desktopEnglish'));
  const pip = () => page.evaluate(() => {
    const doc = window.documentPictureInPicture.window.document;
    return { en: doc.querySelector('#desktopEnglish').textContent, zhHidden: doc.querySelector('#desktopChinese').hidden };
  });
  await page.getByRole('button', { name: 'Hello 1' }).first().click();
  await page.locator('#audio').evaluate(a => a.pause());
  assert.equal((await pip()).en, 'Hello 1');
  assert.equal((await pip()).zhHidden, true);
  await page.getByLabel('显示中文').check();
  assert.equal((await pip()).zhHidden, false);
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="next"]').click());
  await page.waitForFunction(() => document.getElementById('audio').currentTime >= 10);
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="loop"]').click());
  assert.equal(await page.getByLabel('单句循环').isChecked(), true);
  await page.getByLabel('对话', { exact: true }).check();
  await page.locator('#audio').evaluate(a => a.pause());
  await page.waitForFunction(() => documentPictureInPicture.window.document.querySelector('#desktopEnglish').textContent === 'Hello 1');
  assert.equal(await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="next"]').disabled), false);
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="next"]').click());
  await page.waitForFunction(() => documentPictureInPicture.window.document.querySelector('#desktopEnglish').textContent === 'Bye 1');
  assert.equal(await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="next"]').disabled), true);
  await page.evaluate(() => documentPictureInPicture.window.close());
  await page.getByRole('button', { name: '桌面字幕', exact: true }).waitFor();
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  await page.waitForFunction(() => !!documentPictureInPicture.window?.document.querySelector('#desktopEnglish'));
  await page.locator('.playlist-item').nth(1).click();
  await page.getByRole('button', { name: 'Hello 2' }).first().waitFor();
  assert.ok(!(await pip()).en.includes('Bye 1'));
});

test('unsupported desktop subtitles explain the requirement without breaking playback', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.evaluate(() => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true }));
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  assert.match(await page.locator('#playerStatus').innerText(), /不支持/);
  await page.getByRole('button', { name: 'Hello 1' }).first().click();
  await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime >= 7);
});


test('desktop window drives subtitle updates when opener animation frames stop', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  await page.getByRole('button', { name: 'Hello 1' }).first().click();
  await page.waitForFunction(() => documentPictureInPicture.window.document.getElementById('desktopEnglish').textContent === 'Bye 1', { }, { polling: 100, timeout: 8000 });
  await page.locator('#audio').evaluate(a => { a.pause(); a.currentTime = 5; });
  await page.getByLabel('空白间隔保留高亮').check();
  await page.waitForFunction(() => documentPictureInPicture.window.document.getElementById('desktopEnglish').textContent === 'Intro 1', {}, { polling: 100 });
  await page.getByLabel('空白间隔保留高亮').uncheck();
  await page.waitForFunction(() => documentPictureInPicture.window.document.getElementById('desktopEnglish').textContent === '当前没有字幕', {}, { polling: 100 });
});

test('insecure desktop subtitle request explains localhost and HTTPS', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.evaluate(() => Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }));
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  assert.match(await page.locator('#playerStatus').innerText(), /localhost.*HTTPS/);
  assert.equal(await page.evaluate(() => !!documentPictureInPicture.window), false);
});


test('desktop lyrics show up to three fixed rows with top controls and automatic font', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().click();
  await page.locator('#audio').evaluate(a => a.pause());
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  const result = await page.evaluate(() => {
    const d = documentPictureInPicture.window.document;
    const select = d.querySelector('[aria-label="显示句数"]'); select.value = '3'; select.dispatchEvent(new Event('change'));

    return { rows: d.querySelectorAll('.lyric').length, active: d.querySelector('#desktopEnglish').textContent,
      top: d.defaultView.getComputedStyle(d.querySelector('header')).position === 'fixed',
      size: d.defaultView.getComputedStyle(d.querySelector('#desktopEnglish')).fontSize };
  });
  assert.equal(result.rows, 3);
  assert.equal(result.active, 'Hello 1');
  assert.equal(result.top, true);
  assert.ok(parseFloat(result.size) > 0);
  await page.getByLabel('对话', { exact: true }).check();
  assert.equal(await page.evaluate(() => documentPictureInPicture.window.document.querySelectorAll('.lyric').length), 2);
  await page.getByRole('button', { name: '关闭桌面字幕', exact: true }).click();
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  assert.equal(await page.evaluate(() => documentPictureInPicture.window.document.querySelector('input[type=range]')), null);
});


test('desktop compact toolbar and appearance controls persist across reopening', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().click();
  await page.locator('#audio').evaluate(a => a.pause());
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  const changed = await page.evaluate(() => {
    const d = documentPictureInPicture.window.document;
    const compact = d.querySelector('header nav') !== null && d.querySelector('#desktopSettings').hidden;
    d.querySelector('[aria-label="字幕设置"]').click();
    const align = d.querySelector('[aria-label="字幕对齐"]'); align.value = 'center'; align.dispatchEvent(new Event('change'));
    for (const [label, value] of [['背景颜色', '#ffffff'], ['字体颜色', '#112233']]) {
      const picker = d.querySelector(`[aria-label="${label}"]`); picker.value = value; picker.dispatchEvent(new Event('input'));
    }
    return { compact, align: d.defaultView.getComputedStyle(d.querySelector('main')).textAlign,
      background: d.defaultView.getComputedStyle(d.body).backgroundColor,
      foreground: d.defaultView.getComputedStyle(d.querySelector('.current')).color };
  });
  assert.deepEqual(changed, { compact: true, align: 'center', background: 'rgb(255, 255, 255)', foreground: 'rgb(17, 34, 51)' });
  await page.getByRole('button', { name: '关闭桌面字幕', exact: true }).click();
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  assert.equal(await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[aria-label="字幕对齐"]').value), 'center');
});


test('desktop lesson navigation and playback mode cycle including wrap at final lesson', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="nextLesson"]').click());
  await page.getByRole('button', { name: 'Hello 2' }).first().waitFor();
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="previousLesson"]').click());
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="mode"]').click());
  assert.equal(await page.getByLabel('单曲循环', {exact:true}).isChecked(), true);
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="mode"]').click());
  assert.equal(await page.getByLabel('列表循环', {exact:true}).isChecked(), true);
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="previousLesson"]').click());
  await page.getByRole('button', { name: 'Hello 2' }).first().waitFor();
  await page.locator('#audio').evaluate(a => { a.pause(); a.dispatchEvent(new Event('ended')); });
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
});


test('preferences survive reload locally without restoring a stale sentence or autoplaying', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  await page.getByLabel('显示中文').check();
  await page.getByLabel('空白间隔保留高亮').uncheck();
  await page.getByLabel('单句循环', { exact: true }).check();
  await page.getByLabel('对话', { exact: true }).check();
  await page.getByLabel('列表循环', { exact: true }).check();
  await page.reload();
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  for (const label of ['显示中文', '单句循环', '对话', '列表循环']) {
    assert.equal(await page.getByLabel(label, {exact:true}).isChecked(), true);
  }
  assert.equal(await page.getByLabel('空白间隔保留高亮').isChecked(), false);
  assert.equal(await page.locator('#audio').evaluate(a => a.paused), true);
  assert.equal(await page.locator('.sentence.selected').count(), 0);
  const other = await pageWithFixtures(t);
  await other.page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  assert.equal(await other.page.getByLabel('显示中文').isChecked(), false);
  assert.equal(await other.page.getByLabel('完整节目', {exact:true}).isChecked(), true);
});


test('uniform automatic font pans long bilingual sentences in two unwrapped rows', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().click();
  await page.locator('#audio').evaluate(a => a.pause());
  await page.getByLabel('显示中文').check();
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  const sizes = await page.evaluate(() => {
    const d = documentPictureInPicture.window.document;
    const select = d.querySelector('[aria-label="显示句数"]');
    select.value = '2'; select.dispatchEvent(new Event('change'));
    const area = d.querySelector('main');
    d.querySelector('.english').textContent = 'This is a long sentence that must stay on one visual line. '.repeat(5);
    d.querySelector('.chinese').textContent = '这是一段需要自动缩小字号且不能换行的中文翻译。'.repeat(3);
    area.style.flex = 'none'; area.style.width = '320px'; area.style.height = '100px';
    return { count: d.querySelectorAll('.lyric').length };
  });
  assert.equal(sizes.count, 2);
  await page.waitForTimeout(100);
  const small = await page.evaluate(() => {
    const d = documentPictureInPicture.window.document;
    return [...d.querySelectorAll('.lyric')].map(row => ({width:row.clientWidth, scroll:row.scrollWidth, height:row.clientHeight,
      textHeight:row.querySelector('.english').getBoundingClientRect().height,
      font:parseFloat(d.defaultView.getComputedStyle(row.querySelector('.english')).fontSize),
      animation:d.defaultView.getComputedStyle(row.querySelector('.line')).animationName, nowrap:d.defaultView.getComputedStyle(row.querySelector('.line')).whiteSpace}));
  });
  for (const row of small) { assert.equal(row.font, small[0].font); assert.ok(row.textHeight <= row.height); assert.equal(row.nowrap, 'nowrap'); }
  assert.equal(small[0].animation, 'none');
  await page.evaluate(() => { const a = documentPictureInPicture.window.document.querySelector('main'); a.style.width = '500px'; a.style.height = '180px'; });
  await page.waitForTimeout(100);
  const large = await page.evaluate(() => { const d=documentPictureInPicture.window.document; return parseFloat(d.defaultView.getComputedStyle(d.querySelector('.english')).fontSize); });
  assert.ok(large > small[0].font);
});


test('desktop scope toggle synchronizes dialog bounds, main controls and saved preference', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Intro 1' }).first().click();
  await page.locator('#audio').evaluate(a => a.pause());
  await page.getByRole('button', { name: '桌面字幕', exact: true }).click();
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="scope"]').click());
  assert.equal(await page.getByLabel('对话', {exact:true}).isChecked(), true);
  assert.equal(await page.locator('#srtContainer .sentence').count(), 2);
  await page.waitForFunction(() => Math.abs(document.getElementById('audio').currentTime - 7) < .1);
  assert.equal(await page.locator('#audio').evaluate(a => a.paused), true);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('englishPodPreferences')).scope), 'dialog');
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="scope"]').click());
  assert.equal(await page.getByLabel('完整节目', {exact:true}).isChecked(), true);
  assert.equal(await page.locator('#srtContainer .sentence').count(), 4);
  await page.getByLabel('对话', {exact:true}).check();
  assert.equal(await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="scope"]').getAttribute('aria-pressed')), 'true');
});


test('scope changes always seek first sentence and retarget sentence loop while preserving pause', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', {name:'Bye 1'}).first().click();
  await page.getByLabel('单句循环', {exact:true}).check();
  await page.locator('#audio').evaluate(a => a.pause());
  await page.getByLabel('对话', {exact:true}).check();
  await page.waitForFunction(() => Math.abs(document.getElementById('audio').currentTime - 7) < .1);
  assert.equal(await page.locator('#srtContainer .selected').getAttribute('data-id'), '2');
  await page.getByLabel('完整节目', {exact:true}).check();
  await page.waitForFunction(() => Math.abs(document.getElementById('audio').currentTime - 1) < .1);
  assert.equal(await page.locator('#audio').evaluate(a => a.paused), true);
  assert.equal(await page.locator('#srtContainer .selected').getAttribute('data-id'), '1');
});


test('desktop adjacent sentences reuse rows and animate scrolling without queued ghosts', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', {name:'Intro 1'}).first().click();
  await page.locator('#audio').evaluate(a => a.pause());
  await page.getByRole('button', {name:'桌面字幕',exact:true}).click();
  await page.evaluate(() => {
    const d = documentPictureInPicture.window.document;
    const select=d.querySelector('[aria-label="显示句数"]');select.value='3';select.dispatchEvent(new Event('change'));
    window.savedDesktopRow=d.querySelector('[data-id="2"]');
  });
  const animations = await page.evaluate(() => {
    document.querySelector('#srtContainer [data-id="2"]').click();
    return documentPictureInPicture.window.document.querySelector('[data-id="2"]').getAnimations().length;
  });
  assert.ok(animations > 0);
  await page.locator('#audio').evaluate(a => a.pause());
  assert.equal(await page.evaluate(() => savedDesktopRow === documentPictureInPicture.window.document.querySelector('[data-id="2"]')),true);
  await page.getByRole('button', {name:'Bye 1'}).first().click();
  await page.locator('#audio').evaluate(a => a.pause());
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => documentPictureInPicture.window.document.querySelectorAll('.departing').length),0);
  assert.equal(await page.evaluate(() => documentPictureInPicture.window.document.querySelector('#desktopEnglish').textContent),'Bye 1');
});


test('desktop speed updates audio, survives lesson changes and reload, and follows native control', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', {name:'Hello 1'}).first().waitFor();
  await page.getByRole('button', {name:'桌面字幕',exact:true}).click();
  await page.evaluate(() => { const s=documentPictureInPicture.window.document.querySelector('[aria-label="播放倍速"]');s.value='1.5';s.dispatchEvent(new Event('change')); });
  assert.equal(await page.locator('#audio').evaluate(a => a.playbackRate),1.5);
  await page.locator('.playlist-item').nth(1).click();
  await page.getByRole('button', {name:'Hello 2'}).first().waitFor();
  assert.equal(await page.locator('#audio').evaluate(a => a.playbackRate),1.5);
  await page.locator('#audio').evaluate(a => a.playbackRate=.75);
  await page.waitForFunction(() => documentPictureInPicture.window.document.querySelector('[aria-label="播放倍速"]').value === '0.75');
  await page.reload();
  await page.getByRole('button', {name:'Hello 2'}).first().waitFor();
  assert.equal(await page.locator('#audio').evaluate(a => a.playbackRate),.75);
});


test('last loaded lesson restores locally without autoplay and missing lesson falls back safely', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', {name:'Hello 1'}).first().waitFor();
  await page.locator('.playlist-item').nth(1).click();
  await page.getByRole('button', {name:'Hello 2'}).first().click();
  await page.reload();
  await page.getByRole('button', {name:'Hello 2'}).first().waitFor();
  assert.equal(await page.locator('#audio').evaluate(a => a.paused),true);
  assert.match(await page.locator('.playlist-item.active').innerText(),/Lesson 2/);
  await page.evaluate(() => localStorage.setItem('englishPodLastLesson','9999'));
  await page.reload();
  await page.getByRole('button', {name:'Hello 1'}).first().waitFor();
  assert.equal(await page.locator('#audio').evaluate(a => a.paused),true);
});


test('desktop toolbar floats without changing subtitle height and restores from hidden state', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', {name:'Hello 1'}).first().waitFor();
  await page.getByRole('button', {name:'桌面字幕',exact:true}).click();
  const result = await page.evaluate(() => {
    const d=documentPictureInPicture.window.document;
    const before=d.querySelector('main').clientHeight;
    d.querySelector('[aria-label="字幕设置"]').click();
    d.querySelector('[aria-label="隐藏标题和操作栏"]').click();
    return {before,after:d.querySelector('main').clientHeight,header:d.querySelector('header').getBoundingClientRect().height,
      settings:d.querySelector('#desktopSettings').getBoundingClientRect().height,restore:d.defaultView.getComputedStyle(d.querySelector('#restoreToolbar')).position};
  });
  assert.equal(result.after, result.before);
  assert.equal(result.header,0);assert.equal(result.settings,0);assert.equal(result.restore,'fixed');
  await page.getByRole('button', {name:'关闭桌面字幕',exact:true}).click();
  await page.getByRole('button', {name:'桌面字幕',exact:true}).click();
  assert.equal(await page.evaluate(() => documentPictureInPicture.window.document.querySelector('header').hidden),true);
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('#restoreToolbar').click());
  assert.equal(await page.evaluate(() => documentPictureInPicture.window.document.querySelector('header').hidden),false);
});


test('long sentence horizontal position follows audio time, pauses and seeks without autonomous animation', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', {name:'Hello 1'}).first().click();
  await page.locator('#audio').evaluate(a => a.pause());
  await page.getByRole('button', {name:'桌面字幕',exact:true}).click();
  await page.evaluate(() => {
    const d=documentPictureInPicture.window.document;
    d.querySelector('#desktopEnglish').textContent='Long sentence to verify timing. '.repeat(30);
    d.querySelector('main').style.width='300px';
  });
  await page.waitForTimeout(80);
  async function position(time) {
    await page.locator('#audio').evaluate((a,t) => {a.currentTime=t;},time);
    await page.waitForTimeout(80);
    return page.evaluate(() => {
      const d=documentPictureInPicture.window.document,l=d.querySelector('#desktopEnglish').parentElement;
      return { x:new DOMMatrix(d.defaultView.getComputedStyle(l).transform).m41, overflow:Number(l.dataset.overflow), animation:d.defaultView.getComputedStyle(l).animationName };
    });
  }
  const half=await position(8);
  assert.ok(half.overflow>0);
  assert.ok(Math.abs(half.x + half.overflow*.5)<1);
  assert.equal(half.animation,'none');
  await page.waitForTimeout(250);
  const paused=await position(8);
  assert.ok(Math.abs(paused.x-half.x)<1);
  const start=await position(7);
  assert.ok(Math.abs(start.x)<1);
  const nearEnd=await position(8.9);
  assert.ok(Math.abs(nearEnd.x + nearEnd.overflow*.95)<1);
});


test('transparent desktop controls overlay lyrics without consuming space', async t => {
  const {page}=await pageWithFixtures(t);
  await page.getByRole('button',{name:'Hello 1'}).first().waitFor();
  await page.getByRole('button',{name:'桌面字幕',exact:true}).click();
  const result=await page.evaluate(()=>{
    const d=documentPictureInPicture.window.document;
    const before=d.querySelector('main').getBoundingClientRect().height;
    d.querySelector('[aria-label="字幕设置"]').click();
    const h=d.querySelector('header'),s=d.querySelector('#desktopSettings'),m=d.querySelector('main');
    return {before,after:m.getBoundingClientRect().height,headerColor:d.defaultView.getComputedStyle(h).backgroundColor,settingsColor:d.defaultView.getComputedStyle(s).backgroundColor,
      bottom:s.getBoundingClientRect().bottom,top:m.getBoundingClientRect().top};
  });
  assert.equal(result.headerColor,'rgba(0, 0, 0, 0)');
  assert.equal(result.settingsColor,'rgba(0, 0, 0, 0)');
  assert.equal(result.top,0);
  assert.equal(result.before,result.after);
});


test('horizontal scroll off fits single row and wraps multiple rows with persistent preference', async t => {
  const {page}=await pageWithFixtures(t);
  await page.getByRole('button',{name:'Hello 1'}).first().click();
  await page.locator('#audio').evaluate(a=>a.pause());
  await page.getByRole('button',{name:'桌面字幕',exact:true}).click();
  await page.evaluate(()=>{
    const d=documentPictureInPicture.window.document;
    d.querySelector('[aria-label="横向滚动"]').click();
    d.querySelector('#desktopEnglish').textContent='A very long sentence for layout verification. '.repeat(12);
    d.querySelector('main').style.width='280px';
  });
  await page.waitForTimeout(100);
  const one=await page.evaluate(()=>{
    const d=documentPictureInPicture.window.document,r=d.querySelector('.lyric'),l=r.querySelector('.line');
    return {width:r.clientWidth,content:l.scrollWidth,transform:d.defaultView.getComputedStyle(l).transform};
  });
  assert.ok(one.content<=one.width+1);
  await page.evaluate(()=>{
    const d=documentPictureInPicture.window.document,s=d.querySelector('[aria-label="显示句数"]');
    s.value='2';s.dispatchEvent(new Event('change'));
    d.querySelector('#desktopEnglish').textContent='A very long sentence for layout verification. '.repeat(12);
    d.querySelector('main').style.width='290px';
  });
  await page.waitForTimeout(100);
  const multi=await page.evaluate(()=>{
    const d=documentPictureInPicture.window.document,r=d.querySelector('.current'),e=r.querySelector('.english');
    return {height:r.clientHeight,font:parseFloat(d.defaultView.getComputedStyle(e).fontSize),wrap:d.querySelector('main').classList.contains('wrap')};
  });
  assert.equal(multi.wrap,true);assert.ok(multi.height>multi.font*2);
  await page.getByRole('button',{name:'关闭桌面字幕',exact:true}).click();
  await page.getByRole('button',{name:'桌面字幕',exact:true}).click();
  assert.equal(await page.evaluate(()=>documentPictureInPicture.window.document.querySelector('[aria-label="横向滚动"]').checked),false);
});


test('wrapped current sentence consumes line budget and hides following sentence until next cue', async t => {
  const {page}=await pageWithFixtures(t);
  await page.getByRole('button',{name:'Hello 1'}).first().click();
  await page.locator('#audio').evaluate(a=>a.pause());
  await page.getByRole('button',{name:'桌面字幕',exact:true}).click();
  await page.evaluate(()=>{
    const d=documentPictureInPicture.window.document;
    const select=d.querySelector('[aria-label="显示句数"]');select.value='2';select.dispatchEvent(new Event('change'));
    d.querySelector('[aria-label="横向滚动"]').click();
    d.querySelector('#desktopEnglish').textContent='Well, in fact we are the most expensive in the market. '.repeat(2);
    d.querySelector('main').style.width='300px';
  });
  await page.waitForTimeout(100);
  const visible=await page.evaluate(()=>[...documentPictureInPicture.window.document.querySelectorAll('.lyric')].filter(r=>!r.hidden).map(r=>r.dataset.id));
  assert.deepEqual(visible,['2']);
  await page.getByRole('button',{name:'Bye 1'}).first().click();
  await page.locator('#audio').evaluate(a=>a.pause());
  assert.equal(await page.evaluate(()=>documentPictureInPicture.window.document.querySelector('.current').dataset.id),'3');
  assert.equal(await page.evaluate(()=>documentPictureInPicture.window.document.querySelector('.current').hidden),false);
});


test('public checkout hides unavailable local certificate links', async t => {
  const { page } = await pageWithFixtures(t);
  await page.getByRole('button', { name: 'Hello 1' }).first().waitFor();
  assert.equal(await page.locator('.local-certificate-link').count(), 2);
  assert.equal(await page.locator('.local-certificate-link:visible').count(), 0);
});

test('local deployment keeps certificate links when its private files exist', async t => {
  const { page } = await pageWithFixtures(t, undefined, true);
  await page.locator('.local-certificate-link').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('.local-certificate-link:visible').count(), 2);
});
