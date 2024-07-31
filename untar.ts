/**
 * @module
 */

/**
 * The original tar  archive  header format.
 */
export interface OldStyleFormat {
  name: string
  mode: string
  uid: string
  gid: string
  size: number
  mtime: number
  checksum: string
  typeflag: string
  linkname: string
  pad: Uint8Array
}

/**
 * The POSIX ustar archive header format.
 */
export interface PosixUstarFormat {
  name: string
  mode: string
  uid: string
  gid: string
  size: number
  mtime: number
  checksum: string
  typeflag: string
  linkname: string
  magic: string
  version: string
  uname: string
  gname: string
  devmajor: string
  devminor: string
  prefix: string
  pad: Uint8Array
}

/**
 * The interface extracted from the archive.
 */
export interface TarEntry {
  pathname: string
  header: OldStyleFormat | PosixUstarFormat
  readable?: ReadableStream<Uint8Array>
}

/**
 * A TransformStream that expands a Tarball. Taking in a
 * ReadableStream<Uint8Array> and outputting a ReadableStream<TarEntry>.
 *
 * If `TarEntry` has a `readable` property, then it must either be consumed
 * entirely or cancelled before the next TarEntry will resolve.
 */
export class UnTarStream {
  #readable: ReadableStream<TarEntry>
  #writable: WritableStream<Uint8Array>
  /**
   * Constructs a new instance.
   */
  constructor() {
    const { readable, writable } = function () {
      let push: Uint8Array | undefined
      const array: Uint8Array[] = []
      return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (push) {
            const concat = new Uint8Array(push.length + chunk.length)
            concat.set(push)
            concat.set(chunk, push.length)
            chunk = concat
          }
          push = chunk.length % 512
            ? chunk.slice(-chunk.length % 512)
            : undefined

          for (let i = 512; i <= chunk.length; i += 512) {
            array.push(chunk.slice(i - 512, i))
          }
          while (array.length > 2) {
            controller.enqueue(array.shift()!)
          }
        },
        flush(controller) {
          if (push) {
            return controller.error(
              'Tarball has an unexpected number of bytes.',
            )
          }
          if (array.length < 2) {
            return controller.error('Tarball was too small to be valid.')
          }
          if (!array.every((x) => x.every((x) => x === 0))) {
            controller.error('Tarball has invalid ending.')
          }
        },
      })
    }()
    this.#writable = writable
    const decoder = new TextDecoder()
    const reader = readable.getReader()
    let header: OldStyleFormat | PosixUstarFormat | undefined
    let cancelled = false
    let reason: unknown
    this.#readable = new ReadableStream<TarEntry>({
      async pull(controller) {
        while (header != undefined) {
          await new Promise((a) => setTimeout(a, 0))
        }

        const { done, value } = await reader.read()
        if (done) {
          return controller.close()
        }

        // Validate Checksum
        const checksum = value.slice()
        checksum.set(new Uint8Array(8).fill(32), 148)
        if (
          checksum.reduce((x, y) => x + y) !==
            parseInt(decoder.decode(value.slice(148, 156 - 2)), 8)
        ) {
          return controller.error(
            'Invalid Tarball. Header failed to pass checksum.',
          )
        }

        // Decode Header
        header = {
          name: decoder.decode(value.slice(0, 100)).replaceAll('\0', ''),
          mode: decoder.decode(value.slice(100, 108 - 2)),
          uid: decoder.decode(value.slice(108, 116 - 2)),
          gid: decoder.decode(value.slice(116, 124 - 2)),
          size: parseInt(decoder.decode(value.slice(124, 136)).trimEnd(), 8),
          mtime: parseInt(decoder.decode(value.slice(136, 148 - 1)), 8),
          checksum: decoder.decode(value.slice(148, 156 - 2)),
          typeflag: decoder.decode(value.slice(156, 157)),
          linkname: decoder.decode(value.slice(157, 257)).replaceAll(
            '\0',
            '',
          ),
          pad: value.slice(257),
        }
        if (header.typeflag === '\0') {
          header.typeflag = '0'
        }
        if (
          [117, 115, 116, 97, 114, 0, 48, 48].every((byte, i) =>
            value[i + 257] === byte
          )
        ) {
          header = {
            ...header,
            magic: decoder.decode(value.slice(257, 263)),
            version: decoder.decode(value.slice(263, 265)),
            uname: decoder.decode(value.slice(265, 297)).replaceAll('\0', ''),
            gname: decoder.decode(value.slice(297, 329)).replaceAll('\0', ''),
            devmajor: decoder.decode(value.slice(329, 337)).replaceAll(
              '\0',
              '',
            ),
            devminor: decoder.decode(value.slice(337, 345)).replaceAll(
              '\0',
              '',
            ),
            prefix: decoder.decode(value.slice(345, 500)).replaceAll(
              '\0',
              '',
            ),
            pad: value.slice(500),
          }
        }

        if (header.typeflag === '0') {
          const size = header.size
          let i = Math.ceil(size / 512)
          let lock = false
          controller.enqueue({
            pathname: ('prefix' in header && header.prefix.length
              ? header.prefix + '/'
              : '') + header.name,
            header,
            readable: new ReadableStream({
              type: 'bytes',
              async pull(controller) {
                if (i > 0) {
                  lock = true
                  const { done, value } = await async function () {
                    const x = await reader.read()
                    if (!x.done && i-- === 1) {
                      x.value = x.value.slice(0, size % 512) // Slice off suffix padding.
                    }
                    return x
                  }()
                  if (done) {
                    header = undefined
                    lock = false
                    throw new Error('Tarball ended unexpectedly.')
                  }
                  if (controller.byobRequest?.view) {
                    const buffer = new Uint8Array(
                      controller.byobRequest.view.buffer,
                    )
                    const size = buffer.length
                    if (size < value.length) {
                      buffer.set(value.slice(0, size))
                      controller.byobRequest.respond(size)
                      controller.enqueue(value.slice(size))
                    } else {
                      buffer.set(value)
                      controller.byobRequest.respond(value.length)
                    }
                  } else {
                    controller.enqueue(value)
                  }
                  lock = false
                } else {
                  header = undefined
                  if (cancelled) {
                    reader.cancel(reason)
                  }
                  controller.close()
                  controller.byobRequest?.respond(0)
                }
              },
              async cancel(r) {
                reason = r
                while (lock) {
                  await new Promise((a) =>
                    setTimeout(a, 0)
                  )
                }
                try {
                  while (i-- > 0) {
                    if ((await reader.read()).done) {
                      throw new Error('Tarball ended unexpectedly.')
                    }
                  }
                } catch (error) {
                  throw error
                } finally {
                  header = undefined
                }
              },
            }),
          })
        } else {
          controller.enqueue({
            pathname: ('prefix' in header && header.prefix.length
              ? header.prefix + '/'
              : '') + header.name,
            header,
          })
          header = undefined
        }
      },
      cancel(r) {
        reason = r
        cancelled = true
      },
    })
  }

  /**
   * The ReadableStream
   */
  get readable(): ReadableStream<TarEntry> {
    return this.#readable
  }

  /**
   * The WritableStream
   */
  get writable(): WritableStream<Uint8Array> {
    return this.#writable
  }
}
