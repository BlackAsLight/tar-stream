/**
 * @module
 */

/**
 * The original tar archive header format.
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
  #lock = false
  #readable: ReadableStream<TarEntry>
  #writable: WritableStream<Uint8Array>
  #gen: AsyncGenerator<Uint8Array>
  constructor() {
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >()
    this.#readable = ReadableStream.from(this.#untar())
    this.#writable = writable

    this.#gen = async function* () {
      let push: Uint8Array | undefined
      const buffer: Uint8Array[] = []
      for await (let chunk of readable) {
        if (push) {
          const concat = new Uint8Array(push.length + chunk.length)
          concat.set(push)
          concat.set(chunk, push.length)
          chunk = concat
        }

        for (let i = 512; i <= chunk.length; i += 512) {
          buffer.push(chunk.slice(i - 512, i))
        }

        const remainder = -chunk.length % 512
        push = remainder ? chunk.slice(remainder) : undefined

        while (buffer.length > 2) {
          yield buffer.shift()!
        }
      }
      if (push) throw new Error('Tarball has an unexpected number of bytes.')
      if (buffer.length < 2) {
        throw new Error('Tarball was too small to be valid.')
      }
      if (!buffer.every((value) => value.every((x) => x === 0))) {
        throw new Error('Tarball has invalid ending.')
      }
    }()
  }

  async *#untar(): AsyncGenerator<TarEntry> {
    const decoder = new TextDecoder()
    while (true) {
      while (this.#lock) {
        await new Promise((a) => setTimeout(a, 0))
      }

      const { done, value } = await this.#gen.next()
      if (done) break

      // Validate Checksum
      const checksum = value.slice()
      checksum.set(new Uint8Array(8).fill(32), 148)
      if (
        checksum.reduce((x, y) => x + y) !==
          parseInt(decoder.decode(value.slice(148, 156 - 2)), 8)
      ) throw new Error('Invalid Tarball. Header failed to pass checksum.')

      // Decode Header
      let header: OldStyleFormat | PosixUstarFormat = {
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
      if (header.typeflag === '\0') header.typeflag = '0'
      // "ustar\u000000"
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

      yield {
        pathname: ('prefix' in header && header.prefix.length
          ? header.prefix + '/'
          : '') + header.name,
        header,
        readable: header.typeflag === '0'
          ? this.#readableFile(header.size)
          : undefined,
      }
    }
  }

  #readableFile(size: number): ReadableStream<Uint8Array> {
    const gen = this.#genFile(size)
    return new ReadableStream({
      type: 'bytes',
      async pull(controller) {
        const { done, value } = await gen.next()
        if (done) {
          controller.close()
          controller.byobRequest?.respond(0)
        } else if (controller.byobRequest?.view) {
          const buffer = new Uint8Array(controller.byobRequest.view.buffer)
          const size = buffer.length
          if (value.length > size) {
            buffer.set(value.slice(0, size))
            controller.byobRequest.respond(size)
            controller.enqueue(value.slice(size))
          } else {
            buffer.set(value)
            controller.byobRequest.respond(value.length)
          }
        } else controller.enqueue(value)
      },
      async cancel() {
        // deno-lint-ignore no-empty
        for await (const _ of gen) {}
      },
    })
  }

  async *#genFile(size: number): AsyncGenerator<Uint8Array> {
    this.#lock = true
    for (let i = Math.ceil(size / 512); i > 0; --i) {
      const { done, value } = await this.#gen.next()
      if (done) {
        this.#lock = false
        throw new Error('Unexpected end of Tarball.')
      }
      if (i === 1 && size % 512) yield value.slice(0, size % 512)
      else yield value
    }
    this.#lock = false
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
