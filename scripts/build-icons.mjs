// Renders the SVG masters in branding/ into the PNG, ICO and ICNS files under branding/out/. Run with `npm run icons`;
// the outputs are regenerated, never edited by hand.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const here = fileURLToPath(new URL('../branding/', import.meta.url))
const master = join(here, 'icon.svg')
// The flat, thicker-stroked variant: the master's gradient, gloss and thin face ring turn to mush below 48 px.
const small = join(here, 'icon-small.svg')
const out = join(here, 'out')
const smallMax = 32

// Rasterised at twice the target size (density is per 72 dpi of the SVG's own viewBox), then scaled down.
const render = async (size) => {
  const [src, viewBox] = size <= smallMax ? [small, 64] : [master, 512]
  return sharp(await readFile(src), { density: Math.max(72, (size / viewBox) * 72 * 2) })
    .resize(size, size)
    .png()
    .toBuffer()
}

// ICNS is a header and a list of (type, length, PNG data) entries, so it can be written anywhere, macOS or not.
// Retina types (ic11–ic14, ic10) are the same pixels as the next size up.
const icns = (entries) => {
  const chunks = entries.map(([type, png]) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4)
  return Buffer.concat([head, ...chunks])
}

await mkdir(out, { recursive: true })

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const png = {}
for (const size of sizes) png[size] = await render(size)

for (const size of [16, 24, 32, 48, 64, 128, 256]) await writeFile(join(out, `icon-${size}.png`), png[size])
await writeFile(join(out, 'icon.png'), png[512])
await writeFile(join(out, 'icon.ico'), await pngToIco([16, 24, 32, 48, 64, 128, 256].map((s) => png[s])))
await writeFile(
  join(out, 'icon.icns'),
  icns([
    ['icp4', png[16]],
    ['icp5', png[32]],
    ['ic11', png[32]],
    ['ic12', png[64]],
    ['ic07', png[128]],
    ['ic13', png[256]],
    ['ic08', png[256]],
    ['ic14', png[512]],
    ['ic09', png[512]],
    ['ic10', png[1024]]
  ])
)
// The desktop app's notification-area icon, as Hive's: its own master (the small icon filling its square, with heavier
// strokes), at 16 px and 32 px for 100 % and 200 % scaling. The violet disc reads on light and dark taskbars alike.
const tray = join(here, 'tray.svg')
for (const size of [16, 32]) {
  await writeFile(join(out, `tray-${size}.png`), await sharp(await readFile(tray), { density: Math.max(72, (size / 64) * 72 * 2) }).resize(size, size).png().toBuffer())
}
console.log('Icons written to branding/out/')
