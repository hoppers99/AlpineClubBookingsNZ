import { readFileSync } from "node:fs";
import { posix } from "node:path";

const fail = (message) => { throw new Error(message); };
const tarText = (buffer, offset, length) => {
  const zero = buffer.indexOf(0, offset);
  return buffer.subarray(offset, zero >= offset && zero < offset + length ? zero : offset + length).toString("utf8");
};
const canonical = (value, label) => {
  if (!value || value.includes("\\") || value.startsWith("/") || value === ".." || value.startsWith("../") || posix.normalize(value) !== value || /[\0\r\n\t]/.test(value)) fail(`${label} is not a canonical archive path`);
  return value.replace(/\/$/, "");
};
function paxRecords(bytes) {
  const text = bytes.toString("utf8");
  const records = {};
  for (let cursor = 0; cursor < text.length;) {
    const space = text.indexOf(" ", cursor);
    if (space < 0 || !/^[1-9][0-9]*$/.test(text.slice(cursor, space))) fail("source archive PAX record is invalid");
    const length = Number(text.slice(cursor, space));
    const end = cursor + length;
    const record = text.slice(space + 1, end);
    if (!Number.isSafeInteger(length) || end > text.length || !record.endsWith("\n")) fail("source archive PAX record is truncated");
    const equals = record.indexOf("=");
    if (equals > 0) {
      const key = record.slice(0, equals);
      if (Object.hasOwn(records, key)) fail(`source archive PAX record duplicates ${key}`);
      records[key] = record.slice(equals + 1, -1);
    }
    cursor = end;
  }
  return records;
}

export function readGitArchive(path) {
  const archive = readFileSync(path);
  const files = new Map();
  const globalPax = {};
  let sawGlobalPax = false;
  let nextPax = {};
  let longName = null;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const checksumText = tarText(header, 148, 8).trim();
    const sizeText = tarText(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(checksumText) || !/^[0-7]+$/.test(sizeText)) fail("source archive tar numeric field is invalid");
    const expectedChecksum = Number.parseInt(checksumText, 8);
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte), 0);
    if (actualChecksum !== expectedChecksum) fail("source archive tar checksum is invalid");
    const size = Number.parseInt(sizeText, 8);
    const dataOffset = offset + 512;
    if (!Number.isSafeInteger(size) || dataOffset + size > archive.length) fail("source archive is truncated");
    const data = archive.subarray(dataOffset, dataOffset + size);
    const type = String.fromCharCode(header[156] || 0);
    if (type === "g") {
      if (sawGlobalPax) fail("source archive contains multiple global PAX headers");
      Object.assign(globalPax, paxRecords(data)); sawGlobalPax = true;
    }
    else if (type === "x") nextPax = paxRecords(data);
    else if (type === "L") longName = data.subarray(0, data.indexOf(0) < 0 ? data.length : data.indexOf(0)).toString("utf8");
    else if (type === "0" || type === "\0") {
      const prefix = tarText(header, 345, 155);
      const headerName = `${prefix ? `${prefix}/` : ""}${tarText(header, 0, 100)}`;
      const name = canonical(nextPax.path ?? longName ?? headerName, "source archive member");
      if (files.has(name)) fail(`source archive contains duplicate member: ${name}`);
      files.set(name, Buffer.from(data));
      nextPax = {};
      longName = null;
    } else if (type === "5") {
      const prefix = tarText(header, 345, 155);
      const headerName = `${prefix ? `${prefix}/` : ""}${tarText(header, 0, 100)}`;
      canonical(nextPax.path ?? longName ?? headerName, "source archive directory");
      nextPax = {}; longName = null;
    } else fail(`unsupported source archive member type: ${type}`);
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  const revision = globalPax.comment;
  if (!/^[a-f0-9]{40,64}$/.test(revision ?? "")) fail("source archive must contain one valid git revision comment");
  return { revision, files };
}
