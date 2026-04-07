const BG_COLOR = '#2a2a2a'
const TEXT_COLOR = '#e0e0e0'

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d')
  let dpr = window.devicePixelRatio || 1

  // Shared measurement context (avoids creating new canvases)
  const measureCtx = document.createElement('canvas').getContext('2d')

  function resize() {
    dpr = window.devicePixelRatio || 1
    canvas.width = canvas.clientWidth * dpr
    canvas.height = canvas.clientHeight * dpr
  }

  function clear() {
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = BG_COLOR
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    ctx.restore()
  }

  /**
   * Measure text width using the shared context.
   */
  function measureText(text, font) {
    measureCtx.font = font
    return measureCtx.measureText(text).width
  }

  /**
   * Draw a level's text. Supports X and Y offsets for 2D anchoring.
   */
  function drawLevel(measuredNodes, font, lineHeight, maxWidth, offsetX, offsetY, alpha) {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const baseLeftX = (w - maxWidth) / 2

    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalAlpha = alpha
    ctx.font = font
    ctx.fillStyle = TEXT_COLOR
    ctx.textBaseline = 'top'

    for (const node of measuredNodes) {
      for (let i = 0; i < node.lines.length; i++) {
        const x = baseLeftX + offsetX
        const y = node.y + i * lineHeight + offsetY
        if (y > h + lineHeight || y + lineHeight < -lineHeight) continue
        ctx.fillText(node.lines[i].text, x, y)
      }
    }

    ctx.globalAlpha = 1
    ctx.restore()
  }

  resize()

  return {
    resize,
    clear,
    drawLevel,
    measureText,
    get width() { return canvas.clientWidth },
    get height() { return canvas.clientHeight },
    get ctx() { return ctx },
    get dpr() { return dpr }
  }
}
