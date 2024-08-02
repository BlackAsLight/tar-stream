import { assertEquals, assertRejects } from '@std/assert'
import { type TarInput, TarStream, validTarOptions } from './tar.ts'
import { UnTarStream } from './untar.ts'

Deno.test('TarStream() with default stream', async () => {
  const text = new TextEncoder().encode('Hello World!')

  const reader = ReadableStream.from<TarInput>([
    {
      pathname: './potato',
    },
    {
      pathname: './text.txt',
      size: text.length,
      iterable: [text.slice()],
    },
  ])
    .pipeThrough(new TarStream())
    .getReader()

  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    size += value.length
  }
  assertEquals(size, 512 + 512 + Math.ceil(text.length / 512) * 512 + 1024)
})

Deno.test('TarStream() with byte stream', async () => {
  const text = new TextEncoder().encode('Hello World!')

  const reader = ReadableStream.from<TarInput>([
    {
      pathname: './potato',
    },
    {
      pathname: './text.txt',
      size: text.length,
      iterable: [text.slice()],
    },
  ])
    .pipeThrough(new TarStream())
    .getReader({ mode: 'byob' })

  let size = 0
  while (true) {
    const { done, value } = await reader.read(
      new Uint8Array(Math.ceil(Math.random() * 1024)),
    )
    if (done) {
      break
    }
    size += value.length
  }
  assertEquals(size, 512 + 512 + Math.ceil(text.length / 512) * 512 + 1024)
})

Deno.test('TarStream() with negative size', async () => {
  const text = new TextEncoder().encode('Hello World')

  const readable = ReadableStream.from<TarInput>([
    {
      pathname: 'name',
      size: -text.length,
      iterable: [text.slice()],
    },
  ])
    .pipeThrough(new TarStream())
  await assertRejects(
    async function () {
      await Array.fromAsync(readable)
    },
    'Invalid Size Provided! Size cannot exceed 8 GiBs by default or 64 GiBs with sizeExtension set to true.',
  )
})

Deno.test('TarStream() with 65 GiB size', async () => {
  const size = 1024 ** 3 * 65
  const step = 1024 // Size must equally be divisible by step
  const iterable = function* () {
    for (let i = 0; i < size; i += step) {
      yield new Uint8Array(step).map(() => Math.floor(Math.random() * 256))
    }
  }()

  const readable = ReadableStream.from<TarInput>([
    {
      pathname: 'name',
      size,
      iterable,
    },
  ])
    .pipeThrough(new TarStream())

  await assertRejects(
    async function () {
      for await (const _chunk of readable) {
        //
      }
    },
    'Invalid Size Provided! Size cannot exceed 8 GiBs by default or 64 GiBs with sizeExtension set to true.',
  )
})

Deno.test('TarStream() with NaN size', async () => {
  const size = NaN
  const step = 1024 // Size must equally be divisible by step
  const iterable = function* () {
    for (let i = 0; i < size; i += step) {
      yield new Uint8Array(step).map(() => Math.floor(Math.random() * 256))
    }
  }()

  const readable = ReadableStream.from<TarInput>([
    {
      pathname: 'name',
      size,
      iterable,
    },
  ])
    .pipeThrough(new TarStream())

  await assertRejects(
    async function () {
      await Array.fromAsync(readable)
    },
    'Invalid Size Provided! Size cannot exceed 8 GiBs by default or 64 GiBs with sizeExtension set to true.',
  )
})

Deno.test('validTarStreamOptions()', () => {
  assertEquals(validTarOptions({}), true)

  assertEquals(validTarOptions({ mode: '' }), true)
  assertEquals(validTarOptions({ mode: '000' }), true)
  assertEquals(validTarOptions({ mode: '008' }), false)
  assertEquals(validTarOptions({ mode: '0000000' }), false)

  assertEquals(validTarOptions({ uid: '' }), true)
  assertEquals(validTarOptions({ uid: '000' }), true)
  assertEquals(validTarOptions({ uid: '008' }), false)
  assertEquals(validTarOptions({ uid: '0000000' }), false)

  assertEquals(validTarOptions({ gid: '' }), true)
  assertEquals(validTarOptions({ gid: '000' }), true)
  assertEquals(validTarOptions({ gid: '008' }), false)
  assertEquals(validTarOptions({ gid: '0000000' }), false)

  assertEquals(validTarOptions({ mtime: 0 }), true)
  assertEquals(validTarOptions({ mtime: NaN }), false)
  assertEquals(
    validTarOptions({ mtime: Math.floor(new Date().getTime() / 1000) }),
    true,
  )
  assertEquals(validTarOptions({ mtime: new Date().getTime() }), false)

  assertEquals(validTarOptions({ uname: '' }), true)
  assertEquals(validTarOptions({ uname: 'abcdef' }), true)
  assertEquals(validTarOptions({ uname: 'å-abcdef' }), false)
  assertEquals(validTarOptions({ uname: 'a'.repeat(100) }), false)

  assertEquals(validTarOptions({ gname: '' }), true)
  assertEquals(validTarOptions({ gname: 'abcdef' }), true)
  assertEquals(validTarOptions({ gname: 'å-abcdef' }), false)
  assertEquals(validTarOptions({ gname: 'a'.repeat(100) }), false)

  assertEquals(validTarOptions({ devmajor: '' }), true)
  assertEquals(validTarOptions({ devmajor: '000' }), true)
  assertEquals(validTarOptions({ devmajor: '008' }), false)
  assertEquals(validTarOptions({ devmajor: '000000000' }), false)

  assertEquals(validTarOptions({ devminor: '' }), true)
  assertEquals(validTarOptions({ devminor: '000' }), true)
  assertEquals(validTarOptions({ devminor: '008' }), false)
  assertEquals(validTarOptions({ devminor: '000000000' }), false)
})

Deno.test('expandTarArchiveCheckingHeaders', async function () {
  const text = new TextEncoder().encode('Hello World!')

  const readable = ReadableStream.from([
    {
      pathname: './potato',
    },
    {
      pathname: './text.txt',
      size: text.length,
      iterable: [text],
    },
  ])
    .pipeThrough(new TarStream())
    .pipeThrough(new UnTarStream())

  const pathnames: string[] = []
  for await (const item of readable) {
    pathnames.push(item.pathname)
    item.readable?.cancel()
  }
  assertEquals(pathnames, ['potato/', 'text.txt'])
})

Deno.test('expandTarArchiveCheckingBodiesDefaultStream', async function () {
  const text = new TextEncoder().encode('Hello World!')

  const readable = ReadableStream.from([
    {
      pathname: './potato',
    },
    {
      pathname: './text.txt',
      size: text.length,
      iterable: [text.slice()],
    },
    {
      pathname: './text2.txt',
      size: text.length,
      iterable: [text.slice()],
    },
  ])
    .pipeThrough(new TarStream())
    .pipeThrough(new UnTarStream())

  for await (const item of readable) {
    if (item.readable) {
      const buffer = new Uint8Array(text.length)
      let offset = 0
      const reader = item.readable.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer.set(value, offset)
        offset += value.length
      }
      assertEquals(buffer, text)
    }
  }
})

Deno.test('expandTarArchiveCheckingBodiesByteStream', async function () {
  const text = new TextEncoder().encode('Hello World!')

  const readable = ReadableStream.from([
    {
      pathname: './potato',
    },
    {
      pathname: './text.txt',
      size: text.length,
      iterable: [text.slice()],
    },
  ])
    .pipeThrough(new TarStream())
    .pipeThrough(new UnTarStream())

  for await (const item of readable) {
    if (item.readable) {
      const buffer = new Uint8Array(text.length)
      let offset = 0
      const reader = item.readable.getReader({ mode: 'byob' })

      while (true) {
        const { done, value } = await reader.read(
          new Uint8Array(1024),
        )
        if (done) {
          break
        }
        buffer.set(value, offset)
        offset += value.length
      }
      assertEquals(buffer, text)
    }
  }
})

Deno.test('UnTarStream() with size equals to multiple of 512', async () => {
  const size = 512 * 3
  const data = Uint8Array.from({ length: size }, () => Math.floor(Math.random() * 256))

  const readable = ReadableStream.from<TarInput>([
    {
      pathname: 'name',
      size,
      iterable: [data.slice()],
    },
  ])
    .pipeThrough(new TarStream())
    .pipeThrough(new UnTarStream())

  for await (const item of readable) {
    if (item.readable) {
      assertEquals(
        Uint8Array.from(
          (await Array.fromAsync(item.readable)).map((x) => [...x]).flat()
        ),
        data
      )
    }
  }
})
