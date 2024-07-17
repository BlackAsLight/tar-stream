/**
 * @module
 */

/**
 * The options that can go along with a file or directory.
 * @param mode An octal number in ASCII.
 * @param uid An octal number in ASCII.
 * @param gid An octal number in ASCII.
 * @param mtime A number of seconds since the start of epoch. Avoid negative
 * values.
 * @param uname An ASCII string. Should be used in preference of uid.
 * @param gname An ASCII string. Should be used in preference of gid.
 * @param devmajor The major number for character device.
 * @param devminor The minor number for block device entry.
 */
export interface TarOptions {
  mode: string
  uid: string
  gid: string
  mtime: number
  uname: string
  gname: string
  devmajor: string
  devminor: string
}

/**
 * The interface required to provide a file.
 */
export interface TarFile {
  pathname: string | [Uint8Array, Uint8Array]
  size: number
  iterable: Iterable<Uint8Array> | AsyncIterable<Uint8Array>
  options?: Partial<TarOptions>
}

/**
 * The interface required to provide a directory.
 */
export interface TarDir {
  pathname: string | [Uint8Array, Uint8Array]
  options?: Partial<TarOptions>
}

/**
 * A union type merging all the TarStream interfaces that can be piped into the
 * TarStream class.
 */
export type TarInput = TarFile | TarDir

/**
 * A TransformStream that creates a Tarball. Taking in a
 * ReadableStream<TarInput> and outputting a ReadableStream<Uint8Array>.
 *
 * To archive a file, the size must be known before the iterable can be
 * consumed. This TransformStream will throw an error if it doesn't match the
 * amount of bytes written.
 */
export class TarStream {
  #readable: ReadableStream<Uint8Array>
  #writable: WritableStream<TarInput>
  /**
   * Constructs a new instance.
   */
  constructor() {
    const { readable, writable } = new TransformStream<
      TarInput,
      TarInput & { pathname: [Uint8Array, Uint8Array] }
    >({
      transform(chunk, controller) {
        if (chunk.options && !validTarOptions(chunk.options)) {
          return controller.error('Invalid Options Provided!')
        }

        if (
          'size' in chunk &&
          (chunk.size < 0 || 8 ** 12 < chunk.size ||
            chunk.size.toString() === 'NaN')
        ) {
          return controller.error(
            'Invalid Size Provided! Size cannot exceed 64 Gibs.',
          )
        }

        const pathname = typeof chunk.pathname === 'string'
          ? parsePathname(chunk.pathname, !('size' in chunk))
          : function () {
            if ('size' in chunk === (chunk.pathname[1].slice(-1)[0] === 47)) {
              controller.error(
                `Pre-parsed pathname for ${
                  'size' in chunk ? 'directory' : 'file'
                } is not suffixed correctly. ${
                  'size' in chunk ? 'Directories' : 'Files'
                } should${
                  'size' in chunk ? '' : "n't"
                } end in a forward slash.`,
              )
            }
            return chunk.pathname
          }()

        controller.enqueue({ ...chunk, pathname })
      },
    })
    this.#writable = writable
    const gen = async function* () {
      const paths: string[] = []
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      for await (const chunk of readable) {
        const [prefix, name] = chunk.pathname
        {
          const pathname = prefix.length
            ? decoder.decode(prefix) + '/' + decoder.decode(name)
            : decoder.decode(name)
          if (paths.includes(pathname)) {
            continue
          }
          paths.push(pathname)
        }
        const typeflag = 'size' in chunk ? '0' : '5'
        const header = new Uint8Array(512)
        const size = 'size' in chunk ? chunk.size : 0
        const options: TarOptions = {
          mode: typeflag === '5' ? '755' : '644',
          uid: '',
          gid: '',
          mtime: Math.floor(new Date().getTime() / 1000),
          uname: '',
          gname: '',
          devmajor: '',
          devminor: '',
          ...chunk.options,
        }

        header.set(name) // name
        header.set(
          encoder.encode(
            options.mode.padStart(6, '0') + ' \0' + // mode
              options.uid.padStart(6, '0') + ' \0' + //uid
              options.gid.padStart(6, '0') + ' \0' + // gid
              size.toString(8).padStart(size < 8 ** 11 ? 11 : 12, '0') +
              (size < 8 ** 11 ? ' ' : '') + // size
              options.mtime.toString(8).padStart(11, '0') + ' ' + // mtime
              ' '.repeat(8) + // checksum | To be updated later
              typeflag + // typeflag
              '\0'.repeat(100) + // linkname
              'ustar\0' + // magic
              '00' + // version
              options.uname.padStart(32, '\0') + // uname
              options.gname.padStart(32, '\0') + // gname
              options.devmajor.padStart(8, '\0') + // devmajor
              options.devminor.padStart(8, '\0'), // devminor
          ),
          100,
        )
        header.set(prefix, 345) // prefix
        // Update Checksum
        header.set(
          encoder.encode(
            header.reduce((x, y) => x + y).toString(8).padStart(6, '0') + '\0',
          ),
          148,
        )
        yield header

        if ('size' in chunk) {
          let size = 0
          for await (const value of chunk.iterable) {
            size += value.length
            yield value
          }
          if (chunk.size !== size) {
            throw new Error(
              'Invalid Tarball! Provided size did not match bytes read from provided iterable.',
            )
          }
          if (chunk.size % 512) {
            yield new Uint8Array(512 - size % 512)
          }
        }
      }
      yield new Uint8Array(1024)
    }()
    this.#readable = new ReadableStream({
      type: 'bytes',
      async pull(controller) {
        const { done, value } = await gen.next()
        if (done) {
          controller.close()
          return controller.byobRequest?.respond(0)
        }
        if (controller.byobRequest?.view) {
          const buffer = new Uint8Array(controller.byobRequest.view.buffer)

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
      },
    })
  }

  /**
   * The ReadableStream
   */
  get readable(): ReadableStream<Uint8Array> {
    return this.#readable
  }

  /**
   * The WritableStream
   */
  get writable(): WritableStream<TarInput> {
    return this.#writable
  }
}

/**
 * parsePathname is a function that validates the correctness of the pathname
 * being provided.
 * Function will throw if invalid pathname is provided.
 * The result can be provided instead of the string version to TarStream,
 * or can just be used to check in advance of creating the Tar archive.
 */
export function parsePathname(
  pathname: string,
  isDirectory = false,
): [Uint8Array, Uint8Array] {
  pathname = pathname.split('/').filter((x) => x).join('/')
  if (pathname.startsWith('./')) {
    pathname = pathname.slice(2)
  }
  if (isDirectory) {
    pathname += '/'
  }

  const name = new TextEncoder().encode(pathname)
  if (name.length <= 100) {
    return [new Uint8Array(0), name]
  }

  if (name.length > 256) {
    throw new Error('Invalid Pathname! Pathname cannot exceed 256 bytes.')
  }

  let i = Math.max(0, name.lastIndexOf(47))
  if (pathname.slice(i + 1).length > 100) {
    throw new Error('Invalid Filename! Filename cannot exceed 100 bytes.')
  }

  for (; i > 0; --i) {
    i = name.lastIndexOf(47, i) + 1
    if (name.slice(i + 1).length > 100) {
      i = Math.max(0, name.indexOf(47, i + 1))
      break
    }
  }

  const prefix = name.slice(0, i)
  if (prefix.length > 155) {
    throw new Error(
      'Invalid Pathname! Pathname needs to be split-able on a forward slash separator into [155, 100] bytes respectively.',
    )
  }
  return [prefix, name.slice(i + 1)]
}

/**
 * validTarStreamOptions is a function that returns a true if all of the options
 * provided are in the correct format, otherwise returns false.
 */
export function validTarOptions(options: Partial<TarOptions>): boolean {
  if (
    options.mode && (options.mode.length > 6 || !/^[0-7]*$/.test(options.mode))
  ) return false
  if (
    options.uid && (options.uid.length > 6 || !/^[0-7]*$/.test(options.uid))
  ) return false
  if (
    options.gid && (options.gid.length > 6 || !/^[0-7]*$/.test(options.gid))
  ) return false
  if (
    options.mtime != undefined &&
    (options.mtime.toString(8).length > 11 ||
      options.mtime.toString() === 'NaN')
  ) return false
  if (
    options.uname &&
    // deno-lint-ignore no-control-regex
    (options.uname.length > 32 || !/^[\x00-\x7F]*$/.test(options.uname))
  ) return false
  if (
    options.gname &&
    // deno-lint-ignore no-control-regex
    (options.gname.length > 32 || !/^[\x00-\x7F]*$/.test(options.gname))
  ) return false
  if (
    options.devmajor &&
    (options.devmajor.length > 8 || !/^[0-7]*$/.test(options.devmajor))
  ) return false
  if (
    options.devminor &&
    (options.devminor.length > 8 || !/^[0-7]*$/.test(options.devminor))
  ) return false
  return true
}
