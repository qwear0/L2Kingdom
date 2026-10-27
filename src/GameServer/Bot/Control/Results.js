'use strict';

const { limits } = require('../../../Mcp/Contracts');
const entries = new Map();
let bytes = 0;
function remove(key) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
}
function remember(key, value) {
    remove(key);
    const size = Buffer.byteLength(JSON.stringify(value));
    while (entries.size && (entries.size >= limits.terminalReceipts || bytes + size > limits.receiptBytes)) remove(entries.keys().next().value);
    const entry = { value, bytes: size, at: Date.now() };
    if (size <= limits.receiptBytes) { entries.set(key, entry); bytes += size; }
    return entry;
}
function prune(now = Date.now()) {
    for (const [key, entry] of entries) if (now - entry.at >= limits.requestTtlMs) remove(key);
}
module.exports = { entries, remember, prune };
