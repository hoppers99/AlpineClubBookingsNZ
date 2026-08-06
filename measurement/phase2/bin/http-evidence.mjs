const fail = (message) => { throw new Error(message); };

export function parseStrictHttpHeaders(text, context = "captured headers") {
  if (typeof text !== "string" || text.trim() === "") fail(`${context} is empty`);
  const blocks = text.trim().split(/\r?\n\r?\n(?=HTTP\/)/i);
  const rows = blocks.at(-1).split(/\r?\n/);
  const match = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/i.exec(rows.shift() ?? "");
  if (!match) fail(`${context} has no valid HTTP status line`);
  const headers = {};
  const counts = {};
  for (const row of rows) {
    if (row === "") continue;
    if (/^[ \t]/.test(row)) fail(`${context} contains an obsolete folded header`);
    const colon = row.indexOf(":");
    if (colon < 1) fail(`${context} contains a malformed header line`);
    const name = row.slice(0, colon).trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) fail(`${context} contains an invalid header name`);
    const value = row.slice(colon + 1).trim();
    counts[name] = (counts[name] ?? 0) + 1;
    if (["x-nextjs-cache", "etag"].includes(name) && counts[name] !== 1) fail(`${context} contains duplicate ${name} headers`);
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return { status: Number(match[1]), headers, counts };
}
