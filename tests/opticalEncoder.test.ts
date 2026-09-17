import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

describe('offline encoder scheduling', () => {
  function encoder() {
    const draw = vi.fn(() => 0)
    const ctx: Record<string, any> = {
      document: { getElementById: () => ({ addEventListener() {} }), addEventListener() {} },
      window: { addEventListener() {} }, parent: { postMessage() {} },
      requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    }
    runInNewContext(readFileSync('public/vendor/cimbar/bridge.js', 'utf8'), ctx)
    ctx.Module._cimbare_next_frame = () => 0; ctx.Module._cimbare_render = draw
    ctx.loaded = true; ctx.play()
    return { ctx, draw }
  }
  it('renders 30 frames per second without drifting to a slower display divisor', () => {
    const { ctx, draw } = encoder()
    for (let tick = 0; tick < 120; tick++) ctx.renderFrame(tick * 1000 / 60)
    expect(draw).toHaveBeenCalledTimes(60)
  })
  it('does not encode while paused and resumes after a long suspension', () => {
    const { ctx, draw } = encoder()
    ctx.stop(); ctx.renderFrame(40000); expect(draw).not.toHaveBeenCalled()
    ctx.play(); ctx.renderFrame(41000); expect(draw).toHaveBeenCalledTimes(1)
  })
})
