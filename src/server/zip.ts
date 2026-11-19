// 拾念 SHINIAN · 最小 ZIP writer
// 只使用 Node 内置 zlib：deflateRawSync + 自实现 CRC32。
// 安全约束：拒绝绝对路径、盘符、..、反斜杠、控制字符、Windows 保留名与符号链接条目。
import { deflateRawSync } from 'node:zlib';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | 20; // UNIX + ZIP 2.0
const UTF8_FILE_NAME_FLAG = 0x0800;
const COMPRESSION_DEFLATE = 8;
const FILE_TYPE_MASK = 0o170000;
const FILE_TYPE_REGULAR = 0o100000;
const FILE_TYPE_SYMLINK = 0o120000;
const DEFAULT_FILE_MODE = 0o100644;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export class ZipPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipPathError';
  }
}

/** 计算 CRC32（IEEE 802.3，ZIP 使用的多项式）。 */
export function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    value = (CRC32_TABLE[(value ^ data[index]!) & 0xff]! ^ (value >>> 8)) >>> 0;
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * 校验 ZIP 内路径。返回原路径（POSIX 分隔符）。
 * 只允许相对路径；文件路径不能是目录（不能以 / 结尾）。
 */
export function assertSafeZipPath(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new ZipPathError('ZIP 路径不能为空。');
  }
  if (Buffer.byteLength(filePath, 'utf8') > 65535) {
    throw new ZipPathError('ZIP 路径过长。');
  }
  if (/[\u0000-\u001f\u007f]/u.test(filePath)) {
    throw new ZipPathError('ZIP 路径不能包含控制字符。');
  }
  if (filePath.includes('\\')) {
    throw new ZipPathError('ZIP 路径必须使用 POSIX 分隔符，禁止反斜杠。');
  }
  if (filePath.startsWith('/')) {
    throw new ZipPathError('ZIP 路径不能是绝对路径。');
  }
  if (/^[A-Za-z]:/u.test(filePath)) {
    throw new ZipPathError('ZIP 路径不能包含盘符。');
  }
  const segments = filePath.split('/');
  for (const segment of segments) {
    if (!segment) {
      throw new ZipPathError('ZIP 路径不能包含空目录段或以 / 结尾。');
    }
    if (segment === '.' || segment === '..') {
      throw new ZipPathError('ZIP 路径不能包含 . 或 .. 段。');
    }
    if (segment.length > 255) {
      throw new ZipPathError('ZIP 路径中的文件名过长。');
    }
    if (/[. ]$/u.test(segment)) {
      throw new ZipPathError('ZIP 文件名不能以点或空格结尾（Windows 兼容）。');
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      throw new ZipPathError('ZIP 文件名不能使用 Windows 保留名。');
    }
  }
  return filePath;
}

/** 只接受普通文件模式；显式拒绝符号链接（S_IFLNK）。 */
function assertRegularFileMode(mode: number | undefined): number {
  if (mode === undefined) return DEFAULT_FILE_MODE;
  const type = mode & FILE_TYPE_MASK;
  if (type === FILE_TYPE_SYMLINK) {
    throw new ZipPathError('ZIP 不允许符号链接条目。');
  }
  if (type !== 0 && type !== FILE_TYPE_REGULAR) {
    throw new ZipPathError('ZIP 条目必须是普通文件。');
  }
  return FILE_TYPE_REGULAR | (mode & 0o777);
}

export type ZipFileInput = {
  path: string;
  data: Buffer | string;
  mtime?: Date;
  /** 只允许普通文件模式；传入 S_IFLNK 会抛错。 */
  mode?: number;
};

type StagedEntry = {
  name: Buffer;
  data: Buffer;
  compressed: Buffer;
  crc: number;
  dosTime: number;
  dosDate: number;
  externalAttributes: number;
  offset: number;
};

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = Math.max(1, Math.min(12, date.getMonth() + 1));
  const day = Math.max(1, Math.min(31, date.getDate()));
  const hours = Math.max(0, Math.min(23, date.getHours()));
  const minutes = Math.max(0, Math.min(59, date.getMinutes()));
  const seconds = Math.max(0, Math.min(59, date.getSeconds()));
  return {
    dosTime: (hours << 11) | (minutes << 5) | (seconds >> 1),
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function allocate(size: number): Buffer {
  return Buffer.alloc(size);
}

/**
 * 生成一个 ZIP Buffer。所有条目用 UTF-8 文件名（通用标志位 bit 11）。
 * 不使用 data descriptor，大小与 CRC 写在前面的本地文件头里。
 */
export function createZip(files: ZipFileInput[], options?: { mtime?: Date }): Buffer {
  if (files.length > 0xffff) {
    throw new ZipPathError('ZIP 条目数超过 65535，无法生成。');
  }
  const seen = new Set<string>();
  const defaultMtime = options?.mtime ?? new Date();
  const staged: StagedEntry[] = [];
  const localParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const safePath = assertSafeZipPath(file.path);
    if (seen.has(safePath)) {
      throw new ZipPathError(`ZIP 路径重复：${safePath}`);
    }
    seen.add(safePath);
    const name = Buffer.from(safePath, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const { dosTime, dosDate } = toDosDateTime(file.mtime ?? defaultMtime);
    const mode = assertRegularFileMode(file.mode);
    const externalAttributes = (mode << 16) >>> 0;

    const localHeader = allocate(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(VERSION_NEEDED, 4);
    localHeader.writeUInt16LE(UTF8_FILE_NAME_FLAG, 6);
    localHeader.writeUInt16LE(COMPRESSION_DEFLATE, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    staged.push({
      name,
      data,
      compressed,
      crc: checksum,
      dosTime,
      dosDate,
      externalAttributes,
      offset,
    });
    localParts.push(localHeader, name, compressed);
    offset += localHeader.length + name.length + compressed.length;
  }

  const centralParts: Buffer[] = [];
  for (const entry of staged) {
    const centralHeader = allocate(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    centralHeader.writeUInt16LE(VERSION_MADE_BY, 4);
    centralHeader.writeUInt16LE(VERSION_NEEDED, 6);
    centralHeader.writeUInt16LE(UTF8_FILE_NAME_FLAG, 8);
    centralHeader.writeUInt16LE(COMPRESSION_DEFLATE, 10);
    centralHeader.writeUInt16LE(entry.dosTime, 12);
    centralHeader.writeUInt16LE(entry.dosDate, 14);
    centralHeader.writeUInt32LE(entry.crc, 16);
    centralHeader.writeUInt32LE(entry.compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(entry.name.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(entry.externalAttributes, 38);
    centralHeader.writeUInt32LE(entry.offset, 42);
    centralParts.push(centralHeader, entry.name);
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralOffset = offset;
  if (centralDirectory.length > 0xffffffff || centralOffset > 0xffffffff) {
    throw new ZipPathError('ZIP 超过 4 GiB，无法生成。');
  }
  const endRecord = allocate(22);
  endRecord.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(staged.length, 8);
  endRecord.writeUInt16LE(staged.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(centralOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}
