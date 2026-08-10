import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const fail = (message) => { throw new Error(`git-tar: ${message}`); };
const text = (buffer, offset, length) => {
  const zero = buffer.indexOf(0, offset);
  return buffer.subarray(offset, zero >= offset && zero < offset + length ? zero : offset + length).toString("utf8");
};
const parsePax = (payload) => {
  const fields = {};
  for (let cursor = 0; cursor < payload.length;) {
    const space = payload.indexOf(0x20, cursor);
    if (space < 0) fail("PAX record is invalid");
    const length = Number.parseInt(payload.subarray(cursor, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > payload.length) fail("PAX length is invalid");
    const record = payload.subarray(space + 1, cursor + length);
    if (record.at(-1) !== 0x0a) fail("PAX record is truncated");
    const equals = record.indexOf(0x3d);
    if (equals > 0) fields[record.subarray(0, equals).toString("ascii")] = record.subarray(equals + 1, -1).toString("utf8");
    cursor += length;
  }
  return fields;
};
const memberName = (raw, directory = false) => {
  const name = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const segments = name.split("/");
  if (!name || name.startsWith("/") || name.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`member path is invalid: ${raw}`);
  }
  return name;
};

export function readGitTarArchive(inputPath, expectedRevision = null) {
  const path = resolve(inputPath);
  const stat = lstatSync(path);
  const real = realpathSync(path);
  const same = process.platform === "win32" ? real.toLowerCase() === path.toLowerCase() : real === path;
  if (!stat.isFile() || stat.isSymbolicLink() || !same) fail("archive is not a canonical regular file");
  const archive = readFileSync(path);
  if (archive.length % 512 !== 0) fail("archive length is not block aligned");
  const members = new Map();
  const revisions = new Set();
  let localPax = {}, longName = null;
  let terminated = false;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (archive.length - offset < 1024 || !archive.subarray(offset).every((byte) => byte === 0)) fail("archive terminator is invalid");
      terminated = true;
      break;
    }
    const checksumText = text(header, 148, 8).trim();
    if (!/^[0-7]+$/.test(checksumText)) fail("tar checksum field is invalid");
    const expectedChecksum = Number.parseInt(checksumText, 8);
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte), 0);
    if (actualChecksum !== expectedChecksum) fail("tar checksum mismatch");
    const sizeText = text(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) fail("tar size field is invalid");
    const size = Number.parseInt(sizeText, 8);
    const dataOffset = offset + 512;
    if (!Number.isSafeInteger(size) || dataOffset + size > archive.length) fail("archive is truncated");
    const payload = archive.subarray(dataOffset, dataOffset + size);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = text(header, 345, 155);
    const headerName = [prefix, text(header, 0, 100)].filter(Boolean).join("/");
    if (type === "g") {
      if (Object.keys(localPax).length > 0 || longName !== null) fail("global PAX header follows pending local metadata");
      const fields = parsePax(payload);
      if (fields.comment) revisions.add(fields.comment);
    } else if (type === "x") {
      if (Object.keys(localPax).length > 0 || longName !== null) fail("duplicate local archive metadata");
      localPax = parsePax(payload);
    } else if (type === "L") {
      if (Object.keys(localPax).length > 0 || longName !== null) fail("duplicate local archive metadata");
      longName = payload.toString("utf8").replace(/\0.*$/s, "");
    }
    else if (type === "0" || type === "\0") {
      const name = memberName(localPax.path ?? longName ?? headerName);
      if (members.has(name)) fail(`member path is duplicated: ${name}`);
      const bytes = Buffer.from(payload);
      members.set(name, { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length });
      localPax = {}; longName = null;
    } else if (type === "5") {
      memberName(localPax.path ?? longName ?? headerName, true);
      localPax = {}; longName = null;
    } else {
      fail(`unsupported archive member type: ${JSON.stringify(type)}`);
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  if (!terminated || Object.keys(localPax).length > 0 || longName !== null) fail("archive is unterminated or has dangling local metadata");
  if (members.size === 0 || revisions.size !== 1) fail(`archive must contain regular members and one Git revision, got members=${members.size} revisions=${revisions.size}`);
  const revision = [...revisions][0];
  if (!/^[a-f0-9]{40,64}$/.test(revision)) fail("Git revision is invalid");
  if (expectedRevision !== null && revision !== expectedRevision) fail("Git revision does not match expected revision");
  return { path, archive_sha256: createHash("sha256").update(archive).digest("hex"), revision, members };
}
