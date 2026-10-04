/**
 * Keep Cesium's drawing buffer inside the GPU's texture limits.
 *
 * Cesium sizes its full-screen framebuffers (globe depth, OIT, picking) to the
 * drawing buffer and never clamps them. A GPU or browser that reports a small
 * `MAX_TEXTURE_SIZE` therefore stops the render loop as soon as the canvas is
 * wider or taller than that limit:
 *
 *   DeveloperError: Width must be less than or equal to the maximum texture
 *   size (2048).  Check maximumTextureSize.
 *     at new Texture
 *     at FramebufferManager.update
 *     at GlobeDepth.update
 *
 * With `useBrowserRecommendedResolution` (Cesium's default) the drawing buffer
 * is the canvas's CSS size times `resolutionScale`, so a 2560×1440 fullscreen
 * window trips a 2048 limit while 1920×1080 does not (#905).
 *
 * The fix lowers `resolutionScale` just enough for the longest edge to fit,
 * immediately before Cesium sizes the canvas. A limited device renders a
 * little softer instead of halting; every other device is untouched. The
 * scale someone else requested (a quality preset, say) is remembered, so the
 * cap only ever lowers it and lifts again when the window shrinks.
 *
 * @module app/drawingBufferLimit
 */

/**
 * Largest drawing-buffer edge, in device pixels, that every Cesium
 * framebuffer attachment can hold: the smaller of the texture and
 * renderbuffer limits. `Infinity` when neither limit is known yet.
 */
export function drawingBufferEdgeLimit(limits) {
  const sizes = [
    limits?.maximumTextureSize,
    limits?.maximumRenderbufferSize,
  ].filter((size) => Number.isFinite(size) && size > 0);
  return sizes.length > 0 ? Math.min(...sizes) : Infinity;
}

/**
 * The highest resolution scale, no greater than `requestedScale`, whose
 * drawing buffer fits within `edgeLimit` device pixels on its longest edge.
 *
 * Returns `requestedScale` unchanged when it already fits, when the canvas has
 * no size (hidden or not laid out yet) or when the limit is unknown.
 */
export function limitResolutionScale({
  requestedScale,
  clientWidth,
  clientHeight,
  basePixelRatio = 1,
  edgeLimit,
}) {
  const longestEdge = Math.max(clientWidth, clientHeight) * basePixelRatio;
  if (
    !(requestedScale > 0) ||
    !(longestEdge > 0) ||
    !Number.isFinite(longestEdge) ||
    !Number.isFinite(edgeLimit)
  )
    return requestedScale;
  return Math.min(requestedScale, edgeLimit / longestEdge);
}

/**
 * Cap the viewer's resolution scale to the device's framebuffer limits.
 *
 * Wraps the widget's `resize`, which Cesium's render loop and `Viewer.resize`
 * both call before sizing the canvas, so the cap is in place before any
 * framebuffer is allocated at the new size. The widget constructor has
 * already sized the canvas uncapped, so the cap is also applied once on
 * install. Returns a disposer that restores the original `resize` and the
 * requested scale; the viewer itself never needs it, since destroying the
 * viewer discards the widget.
 */
export function installDrawingBufferLimit(
  viewer,
  {
    limits,
    devicePixelRatio = () => globalThis.window?.devicePixelRatio ?? 1,
    warn = (message) => console.warn(message),
  } = {},
) {
  const widget = viewer?.cesiumWidget;
  const canvas = viewer?.canvas;
  if (!limits || !canvas || typeof widget?.resize !== 'function')
    throw new TypeError('A complete Cesium viewer and its limits are required');

  const hadOwnResize = Object.hasOwn(widget, 'resize');
  const originalResize = widget.resize;
  let requestedScale = viewer.resolutionScale;
  let appliedScale = requestedScale;
  let warned = false;

  const limitedResize = function (...args) {
    // A different value means someone else set the scale since our last
    // pass; that becomes the scale to honour.
    if (viewer.resolutionScale !== appliedScale)
      requestedScale = viewer.resolutionScale;
    const edgeLimit = drawingBufferEdgeLimit(limits);
    const nextScale = limitResolutionScale({
      requestedScale,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      basePixelRatio: viewer.useBrowserRecommendedResolution
        ? 1
        : devicePixelRatio(),
      edgeLimit,
    });
    if (nextScale !== viewer.resolutionScale)
      viewer.resolutionScale = nextScale;
    appliedScale = nextScale;
    if (nextScale < requestedScale && !warned) {
      warned = true;
      warn(
        `[Viewer] This GPU allows framebuffers up to ${edgeLimit} px; ` +
          `rendering at ${Math.round(nextScale * 100)}% resolution to fit.`,
      );
    }
    return originalResize.apply(this, args);
  };
  widget.resize = limitedResize;
  // Cesium sized the canvas in its constructor, before this wrapper existed;
  // re-size now so nothing renders or picks at the uncapped size first.
  widget.resize();

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (widget.resize === limitedResize) {
      if (hadOwnResize) widget.resize = originalResize;
      else delete widget.resize;
    }
    if (
      !viewer.isDestroyed?.() &&
      viewer.resolutionScale === appliedScale &&
      appliedScale !== requestedScale
    )
      viewer.resolutionScale = requestedScale;
  };
}
