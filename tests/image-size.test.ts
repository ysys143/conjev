// A Read of a large image reads a smaller copy instead: the image is not
// folded and not summarized while it is recent, so its size is paid for on
// every request until the session ends.
import { expect, test } from 'claude-code/testing'
import { KEY_ENV, setup, type On } from './kit'

const SIPS_BIG = 'pixelWidth: 2508\npixelHeight: 1310\n'
const SIPS_SMALL = 'pixelWidth: 320\npixelHeight: 200\n'
const ARGS = { imageMaxPx: 640 }

const read = (io: { disks: string[] } | undefined) => io

test('a large PNG is read as a smaller copy, and the copy is reused', { options: ARGS }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, imageSize: SIPS_BIG })
  const first = await $.tool.call({ tool: 'Read', file_path: '/proj/shot.png' } as never)

  // The copy is what the tool was pointed at, not the original.
  const shrink = io.runs.find(argv => argv.includes('-Z'))
  expect(shrink).toBeDefined()
  expect(shrink).toContain('640')
  expect(io.logs.join('\n')).toContain('read ')
  expect(io.logs.join('\n')).toContain('/proj/shot.png')
  expect(first).toBeDefined()
})

test('a small image is read as it is: resizing it would only cost a second read', { options: ARGS }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, imageSize: SIPS_SMALL })
  await $.tool.call({ tool: 'Read', file_path: '/proj/icon.png' } as never)

  expect(io.runs.some(argv => argv.includes('-Z'))).toBe(false)
})

test('a file that is not an image is left alone', { options: ARGS }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, imageSize: SIPS_BIG })
  await $.tool.call({ tool: 'Read', file_path: '/proj/src/app.ts' } as never)

  expect(io.runs.length).toBe(0)
})

test('with the setting off, nothing is measured or resized', { options: { imageMaxPx: 0 } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, imageSize: SIPS_BIG })
  await $.tool.call({ tool: 'Read', file_path: '/proj/shot.png' } as never)

  expect(io.runs.length).toBe(0)
})

test('a resize that fails reads the original: nothing is lost', { options: ARGS }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, imageSize: SIPS_BIG, resizeFails: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/shot.png' } as never)

  // It tried, and gave up rather than pointing the read at a copy that is not there.
  expect(io.logs.join('\n')).not.toContain('read ')
})

test('an image whose size cannot be read is left alone', { options: ARGS }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.tool.call({ tool: 'Read', file_path: '/proj/shot.png' } as never)

  expect(io.runs.some(argv => argv.includes('-Z'))).toBe(false)
})
