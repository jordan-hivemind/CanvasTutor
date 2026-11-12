// Renders public/icon.svg to the PNG sizes iOS/Android home screens need.
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync } from 'node:fs'

const svg = readFileSync('public/icon.svg', 'utf8')
for (const size of [180, 192, 512]) {
  // iOS adds its own rounded corners, so the 180px apple-touch-icon gets a square background
  const src = size === 180 ? svg.replace('rx="112"', 'rx="0"') : svg
  const png = new Resvg(src, { fitTo: { mode: 'width', value: size } }).render().asPng()
  writeFileSync(`public/icon-${size}.png`, png)
  console.log(`public/icon-${size}.png`, png.length, 'bytes')
}
