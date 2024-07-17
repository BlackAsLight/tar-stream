# Tar Stream

Tar Stream is an implementation made from scratch following the
[FreeBSD 15.0](https://man.freebsd.org/cgi/man.cgi?query=tar&apropos=0&sektion=5&manpath=FreeBSD+15.0-CURRENT&arch=default&format=html)
spec.

## File Format + Limitations

This implementation follows the ustar file format for creating and expanding
Tarballs. While this format is compatible with most tar implementations, the
format does have several limitations, including:

- Pathnames cannot exceed 256 characters.
  - If the pathname exceeds 100 characters, it must be split-able on a forward
    slash `/` so each side does not exceed 155 and 100 characters respectively.
- Files can't exceed a size of 64 GiBs.
  - If a file size exceeds 8 GiBs then the size extension will be automatically
    enabled allowing up to 64 GiBs per size, but this might exclude it from
    being expanded by older implementations of Tar that don't support the size
    extension.
- Spares files are not supported.

## Compression

Tar doesn't offer compression by default, so if you'd like to compress the
Tarball, you may do so by piping it through a compression stream.

## Example in creating a tarball.

```ts
import { type TarFile, TarStream } from '@doctor/tar-stream'

await ReadableStream.from(readDir('./'))
  .pipeThrough(
    new TransformStream<string, TarFile>({
      async transform(chunk, controller) {
        if (chunk.endsWith('.ts')) {
          controller.enqueue({
            pathname: chunk,
            size: (await Deno.stat(chunk)).size,
            iterable: (await Deno.open(chunk)).readable,
          })
        }
      },
    }),
  )
  .pipeThrough(new TarStream())
  .pipeThrough(new CompressionStream('gzip'))
  .pipeTo((await Deno.create('./archive.tar.gz')).writable)

async function* readDir(path: string): AsyncGenerator<string> {
  if (!path.endsWith('/')) {
    path += '/'
  }
  for await (const dirEntry of Deno.readDir(path)) {
    if (dirEntry.isFile) {
      yield path + dirEntry.name
    } else if (dirEntry.isDirectory) {
      for await (const filePath of readDir(path + dirEntry.name)) {
        yield filePath
      }
    }
  }
}
```
