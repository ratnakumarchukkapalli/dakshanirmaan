import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

// A streaming ZIP writer for the year archive (change 25, part C). Files are added one after another;
// nothing is written to disk and no file is held whole in memory: each chunk goes through the compressor
// into the response stream, and the SHA-256 of what was put in (the bytes of the file as it will look
// when unpacked) is taken as the chunk passes. The manifest of those hashes is the last file.
//
// Library: fflate 0.8.3 — MIT, no dependencies, no install scripts. Its synchronous streaming `Zip`
// is used (not the worker-backed Async classes, which need worker threads under Node).

export interface ManifestEntry { path: string; sha256: string; bytes: number }

export interface AddOptions {
  /** Deflate (text) or store (files that are already compressed: PDF, xlsx). Default deflate. */
  store?: boolean;
}

type Chunk = Uint8Array | string;
const utf8 = (c: Chunk): Uint8Array => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c);

export class ZipStream {
  /** The zip bytes. Hand it to the response; destroy it with an error to make the download fail. */
  readonly out = new PassThrough();
  readonly manifest: ManifestEntry[] = [];
  private readonly zip: Zip;
  private closed = false;

  constructor() {
    this.zip = new Zip((error, chunk, final) => {
      if (error) {
        this.out.destroy(error);
        return;
      }
      if (this.out.destroyed) return;
      this.out.write(chunk);
      if (final) this.out.end();
    });
  }

  /** Waits while the reader is behind; throws when the reader has gone away. */
  private async drain(): Promise<void> {
    if (this.out.destroyed) throw new Error('the download was closed');
    if (!this.out.writableNeedDrain) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const gone = () => { cleanup(); reject(new Error('the download was closed')); };
      const cleanup = () => { this.out.off('drain', done); this.out.off('close', gone); };
      this.out.once('drain', done);
      this.out.once('close', gone);
    });
  }

  private begin(path: string, options: AddOptions) {
    if (this.closed) throw new Error('zip: already finished');
    if (this.manifest.some((m) => m.path === path)) throw new Error(`zip: ${path} is already in the archive`);
    const file = options.store ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
    this.zip.add(file);
    return file;
  }

  /** Adds a file from chunks (text is UTF-8). Returns the number of bytes put in. */
  async add(path: string, source: Iterable<Chunk> | AsyncIterable<Chunk>, options: AddOptions = {}): Promise<number> {
    const file = this.begin(path, options);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const piece of source as AsyncIterable<Chunk>) {
      const data = utf8(piece);
      if (data.length === 0) continue;
      hash.update(data);
      bytes += data.length;
      file.push(data, false);
      await this.drain();
    }
    file.push(new Uint8Array(0), true);
    await this.drain();
    this.manifest.push({ path, sha256: hash.digest('hex'), bytes });
    return bytes;
  }

  /** A file produced by something that writes to a Node stream (the Excel workbook). Resolves with the bytes when the stream has ended. */
  async addFromWriter(path: string, produce: (out: Writable) => Promise<void>, options: AddOptions = {}): Promise<number> {
    const file = this.begin(path, options);
    const hash = createHash('sha256');
    let bytes = 0;
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        hash.update(chunk);
        bytes += chunk.length;
        file.push(new Uint8Array(chunk), false);
        this.drain().then(() => callback(), callback);
      },
      final: (callback) => {
        file.push(new Uint8Array(0), true);
        this.drain().then(() => callback(), callback);
      },
    });
    const ended = new Promise<void>((resolve, reject) => {
      sink.once('finish', resolve);
      sink.once('error', reject);
    });
    try {
      await produce(sink);
      if (!sink.writableEnded) sink.end();
      await ended;
    } catch (e) {
      sink.destroy();
      throw e;
    }
    this.manifest.push({ path, sha256: hash.digest('hex'), bytes });
    return bytes;
  }

  /** The `sha256sum -c` file: `<hash>  <path>` per line, for every file added so far. */
  manifestText(): string {
    return this.manifest.map((m) => `${m.sha256}  ${m.path}\n`).join('');
  }

  /** Ends the archive. Call after the last file; the manifest, if wanted, must be added before. */
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.zip.end();
  }

  /** Makes the download fail instead of ending as a file that looks complete. */
  abort(error: Error): void {
    this.closed = true;
    this.out.destroy(error);
  }
}
