import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawingBufferEdgeLimit,
  limitResolutionScale,
  installDrawingBufferLimit,
} from './drawingBufferLimit.js';

/**
 * Minimal viewer double. `resize` lives on the widget's prototype, as it does
 * on Cesium's CesiumWidget, and records the scale it sized the canvas with.
 */
function fakeViewer({
  clientWidth = 2560,
  clientHeight = 1440,
  resolutionScale = 1,
  useBrowserRecommendedResolution = true,
} = {}) {
  const sized = [];
  const widgetPrototype = {
    resize() {
      sized.push(viewer.resolutionScale);
    },
  };
  const widget = Object.create(widgetPrototype);
  let destroyed = false;
  const viewer = {
    cesiumWidget: widget,
    canvas: { clientWidth, clientHeight },
    resolutionScale,
    useBrowserRecommendedResolution,
    isDestroyed: () => destroyed,
    destroy: () => (destroyed = true),
  };
  return { viewer, widget, widgetPrototype, sized };
}

const LIMITED = { maximumTextureSize: 2048, maximumRenderbufferSize: 16384 };
const silent = () => {};

test('the edge limit is the smaller of the texture and renderbuffer limits', () => {
  assert.equal(drawingBufferEdgeLimit(LIMITED), 2048);
  assert.equal(
    drawingBufferEdgeLimit({
      maximumTextureSize: 16384,
      maximumRenderbufferSize: 4096,
    }),
    4096,
  );
  // ContextLimits reads 0 until a context exists: unknown, not "zero pixels".
  assert.equal(
    drawingBufferEdgeLimit({
      maximumTextureSize: 0,
      maximumRenderbufferSize: 0,
    }),
    Infinity,
  );
  assert.equal(drawingBufferEdgeLimit(undefined), Infinity);
});

test('a 1440p canvas is scaled to fit a 2048 limit on its longest edge', () => {
  const scale = limitResolutionScale({
    requestedScale: 1,
    clientWidth: 2560,
    clientHeight: 1440,
    edgeLimit: 2048,
  });
  assert.equal(scale, 0.8);
  assert.ok(Math.floor(2560 * scale) <= 2048);
});

test('portrait canvases are limited by height', () => {
  const scale = limitResolutionScale({
    requestedScale: 1,
    clientWidth: 1440,
    clientHeight: 2560,
    edgeLimit: 2048,
  });
  assert.equal(scale, 0.8);
});

test('a canvas that already fits keeps the requested scale', () => {
  for (const requestedScale of [1, 0.6]) {
    assert.equal(
      limitResolutionScale({
        requestedScale,
        clientWidth: 1920,
        clientHeight: 1080,
        edgeLimit: 2048,
      }),
      requestedScale,
    );
  }
});

test('a lower requested scale is never raised to the limit', () => {
  // 2560 * 0.6 = 1536 already fits under 2048.
  assert.equal(
    limitResolutionScale({
      requestedScale: 0.6,
      clientWidth: 2560,
      clientHeight: 1440,
      edgeLimit: 2048,
    }),
    0.6,
  );
});

test('device pixels count when the browser resolution is not used', () => {
  // 1920 CSS px at devicePixelRatio 1.5 is 2880 device px.
  const scale = limitResolutionScale({
    requestedScale: 1,
    clientWidth: 1920,
    clientHeight: 1080,
    basePixelRatio: 1.5,
    edgeLimit: 2048,
  });
  assert.ok(Math.floor(1920 * 1.5 * scale) <= 2048);
  assert.ok(scale < 1);
});

test('unsized canvases and unknown limits leave the scale alone', () => {
  const base = { requestedScale: 1, clientWidth: 2560, clientHeight: 1440 };
  assert.equal(limitResolutionScale({ ...base, edgeLimit: Infinity }), 1);
  assert.equal(
    limitResolutionScale({
      ...base,
      clientWidth: 0,
      clientHeight: 0,
      edgeLimit: 2048,
    }),
    1,
  );
});

test('installing re-sizes the canvas with the cap applied', () => {
  // Cesium's constructor sized the canvas before the wrapper existed.
  const { viewer, sized } = fakeViewer();
  installDrawingBufferLimit(viewer, { limits: LIMITED, warn: silent });
  assert.deepEqual(sized, [0.8]);
  assert.equal(viewer.resolutionScale, 0.8);
});

test('devices with room are untouched', () => {
  const { viewer, sized } = fakeViewer();
  installDrawingBufferLimit(viewer, {
    limits: { maximumTextureSize: 16384, maximumRenderbufferSize: 16384 },
    warn: silent,
  });
  assert.deepEqual(sized, [1]);
});

test('the requested scale returns when the window shrinks', () => {
  const { viewer, sized } = fakeViewer();
  installDrawingBufferLimit(viewer, { limits: LIMITED, warn: silent });
  viewer.canvas.clientWidth = 1920;
  viewer.canvas.clientHeight = 1080;
  viewer.cesiumWidget.resize();
  assert.deepEqual(sized, [0.8, 1]);
});

test('a scale set by someone else becomes the new request', () => {
  const { viewer, sized } = fakeViewer();
  installDrawingBufferLimit(viewer, { limits: LIMITED, warn: silent });
  // A quality preset lowers the scale below the cap: it is honoured as is.
  viewer.resolutionScale = 0.5;
  viewer.cesiumWidget.resize();
  // Shrinking the window must not lift it back to 1.
  viewer.canvas.clientWidth = 1920;
  viewer.canvas.clientHeight = 1080;
  viewer.cesiumWidget.resize();
  assert.deepEqual(sized, [0.8, 0.5, 0.5]);
});

test('limits are read on every resize, after the context exists', () => {
  const limits = { maximumTextureSize: 0, maximumRenderbufferSize: 0 };
  const { viewer, sized } = fakeViewer();
  installDrawingBufferLimit(viewer, { limits, warn: silent });
  Object.assign(limits, LIMITED);
  viewer.cesiumWidget.resize();
  assert.deepEqual(sized, [1, 0.8]);
});

test('warns once, naming the limit and the resulting resolution', () => {
  const messages = [];
  const { viewer } = fakeViewer();
  installDrawingBufferLimit(viewer, {
    limits: LIMITED,
    warn: (message) => messages.push(message),
  });
  viewer.cesiumWidget.resize();
  viewer.cesiumWidget.resize();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /2048 px/);
  assert.match(messages[0], /80% resolution/);
});

test('the disposer restores the prototype resize and the requested scale', () => {
  const { viewer, widget, widgetPrototype } = fakeViewer();
  const dispose = installDrawingBufferLimit(viewer, {
    limits: LIMITED,
    warn: silent,
  });
  assert.ok(Object.hasOwn(widget, 'resize'));
  widget.resize();
  dispose();
  dispose();
  assert.equal(Object.hasOwn(widget, 'resize'), false);
  assert.equal(widget.resize, widgetPrototype.resize);
  assert.equal(viewer.resolutionScale, 1);
});

test('the disposer leaves a destroyed viewer alone', () => {
  const { viewer } = fakeViewer();
  const dispose = installDrawingBufferLimit(viewer, {
    limits: LIMITED,
    warn: silent,
  });
  viewer.cesiumWidget.resize();
  viewer.destroy();
  dispose();
  assert.equal(viewer.resolutionScale, 0.8);
});

test('rejects incomplete viewers', () => {
  assert.throws(
    () => installDrawingBufferLimit({}, { limits: LIMITED }),
    TypeError,
  );
  assert.throws(
    () => installDrawingBufferLimit(fakeViewer().viewer),
    TypeError,
  );
});
