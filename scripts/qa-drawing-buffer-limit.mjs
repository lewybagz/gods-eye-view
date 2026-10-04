#!/usr/bin/env node
/**
 * Prove the viewer keeps rendering when the window exceeds the GPU's texture
 * limit (#905).
 *
 * The browser reports a 2048 px MAX_TEXTURE_SIZE, as the device in #905 did,
 * and the page is sized past it. Without the cap, Cesium's globe-depth
 * framebuffer throws "Width must be less than or equal to the maximum texture
 * size" and the render loop stops. With it, the viewer lowers its resolution
 * scale, keeps rendering, and restores the scale when the window shrinks. A
 * control page without the reduced limit must stay at full resolution.
 *
 * Needs a running dev server: npm run dev, then
 *   node scripts/qa-drawing-buffer-limit.mjs [--url http://localhost:4173]
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173';
const TEXTURE_LIMIT = 2048;

/** Report a reduced MAX_TEXTURE_SIZE from every WebGL context on the page. */
function reportTextureLimit(limit) {
  const MAX_TEXTURE_SIZE = 0x0d33;
  for (const Context of [WebGLRenderingContext, WebGL2RenderingContext]) {
    const getParameter = Context.prototype.getParameter;
    Context.prototype.getParameter = function (parameter) {
      const value = getParameter.call(this, parameter);
      return parameter === MAX_TEXTURE_SIZE ? Math.min(value, limit) : value;
    };
  }
}

async function openViewer(browser, { width, height, textureLimit }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  if (textureLimit)
    await page.evaluateOnNewDocument(reportTextureLimit, textureLimit);
  const warnings = [];
  const renderErrors = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('[Viewer]')) warnings.push(text);
    if (/Rendering has stopped/.test(text)) renderErrors.push(text);
  });
  await page.goto(`${url}/?welcome=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.viewer?.scene, {
    timeout: 60_000,
  });
  return { page, warnings, renderErrors };
}

/**
 * Wait for a few rendered frames at the current size, then read the sizes. A
 * stopped render loop never fires postRender, so each wait is bounded and the
 * result reports how many frames actually rendered.
 */
async function settledSizes(page) {
  return page.evaluate(async () => {
    const { viewer } = window.__godsEyeView;
    let framesRendered = 0;
    for (let frame = 0; frame < 5; frame += 1) {
      viewer.scene.requestRender();
      const rendered = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          remove();
          resolve(false);
        }, 10_000);
        const remove = viewer.scene.postRender.addEventListener(() => {
          clearTimeout(timer);
          remove();
          resolve(true);
        });
      });
      if (!rendered) break;
      framesRendered += 1;
    }
    return {
      framesRendered,
      resolutionScale: viewer.resolutionScale,
      canvas: [viewer.canvas.width, viewer.canvas.height],
      drawingBuffer: [
        viewer.scene.drawingBufferWidth,
        viewer.scene.drawingBufferHeight,
      ],
      rendering: viewer.useDefaultRenderLoop && !viewer.isDestroyed(),
    };
  });
}

function assertFits(sizes, label) {
  assert.equal(sizes.framesRendered, 5, `${label}: the render loop stopped`);
  for (const edge of [...sizes.canvas, ...sizes.drawingBuffer])
    assert.ok(edge <= TEXTURE_LIMIT, `${label}: ${edge} px exceeds the limit`);
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const limited = await openViewer(browser, {
    width: 2560,
    height: 1440,
    textureLimit: TEXTURE_LIMIT,
  });
  const fullscreen = await settledSizes(limited.page);
  assertFits(fullscreen, '2560×1440');
  assert.equal(fullscreen.resolutionScale, 0.8);
  assert.deepEqual(fullscreen.canvas, [2048, 1152]);
  assert.equal(fullscreen.rendering, true);
  console.log('PASS: 2560×1440 renders at 80% within a 2048 px limit');

  await limited.page.setViewport({ width: 1920, height: 1080 });
  const smaller = await settledSizes(limited.page);
  assert.equal(smaller.framesRendered, 5, '1920×1080: the render loop stopped');
  assert.equal(smaller.resolutionScale, 1);
  assert.deepEqual(smaller.canvas, [1920, 1080]);
  console.log('PASS: shrinking to 1920×1080 restores full resolution');

  await limited.page.setViewport({ width: 3840, height: 2160 });
  const uhd = await settledSizes(limited.page);
  assertFits(uhd, '3840×2160');
  assert.equal(uhd.canvas[0], 2048);
  console.log('PASS: growing to 3840×2160 is capped again');

  assert.deepEqual(limited.renderErrors, []);
  assert.equal(limited.warnings.length, 1);
  assert.match(limited.warnings[0], /2048 px/);
  console.log('PASS: no render error, one [Viewer] warning');
  await limited.page.close();

  const control = await openViewer(browser, { width: 2560, height: 1440 });
  const unlimited = await settledSizes(control.page);
  assert.equal(unlimited.framesRendered, 5, 'control: the render loop stopped');
  assert.equal(unlimited.resolutionScale, 1);
  assert.deepEqual(unlimited.canvas, [2560, 1440]);
  assert.deepEqual(control.warnings, []);
  assert.deepEqual(control.renderErrors, []);
  console.log('PASS: a GPU with room renders 2560×1440 at full resolution');
  await control.page.close();
} finally {
  await browser.close();
}
