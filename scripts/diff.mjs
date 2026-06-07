// Usage: node scripts/diff.mjs <baselinePng> <actualPng> [outDiffPng]
// Prints diff pixel count + ratio; writes a diff image. Exit 0 if ratio < 0.01, else 1.
import fs from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
const [, , aPath, bPath, outPath = 'diff.png'] = process.argv
if (!aPath || !bPath) { console.error('usage: node scripts/diff.mjs <baseline> <actual> [outDiff]'); process.exit(2) }
const a = PNG.sync.read(fs.readFileSync(aPath))
const b = PNG.sync.read(fs.readFileSync(bPath))
const width = Math.min(a.width, b.width), height = Math.min(a.height, b.height)
if (a.width !== b.width || a.height !== b.height) {
  console.warn(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height} — comparing overlap ${width}x${height}`)
}
const diff = new PNG({ width, height })
// crop both to common size if needed
function crop(src){ if(src.width===width && src.height===height) return src; const d=new PNG({width,height}); PNG.bitblt(src,d,0,0,width,height,0,0); return d }
const ca = crop(a), cb = crop(b)
const mismatch = pixelmatch(ca.data, cb.data, diff.data, width, height, { threshold: 0.1 })
fs.writeFileSync(outPath, PNG.sync.write(diff))
const total = width * height
const ratio = mismatch / total
console.log(`diff pixels: ${mismatch} / ${total} = ${(ratio*100).toFixed(3)}%  -> ${outPath}`)
process.exit(ratio < 0.01 ? 0 : 1)
