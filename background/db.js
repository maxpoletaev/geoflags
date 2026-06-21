const DB_KEY = "mmdb_v1";

let mmdbReader = null;
const textDecoder = new TextDecoder();

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  const chunk = 1024;
  for (let i = 0; i < bytes.length; i += chunk) {
    str += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(str);
}

function base64ToBuffer(b64) {
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes.buffer;
}

// Maxmind DB format reader and lookup logic.
// Spec: https://maxmind.github.io/MaxMind-DB/

class MMDBReader {
  constructor(buffer) {
    this.buf = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.dataSectionStart = 0; // set after metadata
    this._parseMetadata();
  }

  _parseMetadata() {
    // Metadata follows the 14-byte separator: \xAB\xCD\xEF + "MaxMind.com"
    const SEP = [0xab, 0xcd, 0xef, 0x4d, 0x61, 0x78, 0x4d, 0x69, 0x6e, 0x64, 0x2e, 0x63, 0x6f, 0x6d];
    let metaOffset = -1;
    for (let i = this.buf.length - SEP.length; i >= 0; i--) {
      if (this.buf[i] === SEP[0]) {
        let ok = true;
        for (let j = 1; j < SEP.length; j++) {
          if (this.buf[i + j] !== SEP[j]) { ok = false; break; }
        }
        if (ok) { metaOffset = i + SEP.length; break; }
      }
    }
    if (metaOffset === -1) throw new Error("Not an MMDB file");

    const { value: meta } = this._decode(metaOffset);
    this.nodeCount  = meta.node_count;
    this.recordSize = meta.record_size; // 24, 28, or 32
    this.ipVersion  = meta.ip_version;
    this.nodeBytes  = (this.recordSize * 2) / 8;
    this.treeSize   = this.nodeCount * this.nodeBytes;
    // dataSectionStart is used for resolving pointers within the data section.
    // Data records from leaf nodes use treeSize directly (spec: file_offset = record_value - node_count + tree_size).
    this.dataSectionStart = this.treeSize + 16;

    // Cache the node to start IPv4 lookups from in an IPv6 tree (traverse 96 zero bits).
    this._ipv4StartNode = 0;
    if (this.ipVersion === 6) {
      let node = 0;
      for (let i = 0; i < 96 && node < this.nodeCount; i++) {
        node = this._child(node, 0);
      }
      this._ipv4StartNode = node;
    }
  }

  // Read a child record (bit = 0 -> left, 1 -> right) from a node.
  _child(nodeNum, bit) {
    const off = nodeNum * this.nodeBytes;
    const rs = this.recordSize;
    if (rs === 24) {
      if (bit === 0)
        return (this.buf[off] << 16) | (this.buf[off + 1] << 8) | this.buf[off + 2];
      return (this.buf[off + 3] << 16) | (this.buf[off + 4] << 8) | this.buf[off + 5];
    }
    if (rs === 28) {
      if (bit === 0)
        return (this.buf[off] << 20) | (this.buf[off + 1] << 12) | (this.buf[off + 2] << 4) | (this.buf[off + 3] >> 4);
      return ((this.buf[off + 3] & 0x0f) << 24) | (this.buf[off + 4] << 16) | (this.buf[off + 5] << 8) | this.buf[off + 6];
    }
    // rs === 32
    if (bit === 0) return this.view.getUint32(off, false);
    return this.view.getUint32(off + 4, false);
  }

  // Decode one data value at absolute offset; returns { value, nextOffset }.
  _decode(offset) {
    const ctrl = this.buf[offset++];
    let type = (ctrl >> 5) & 0x7;
    let size = ctrl & 0x1f;

    if (type === 0) { type = this.buf[offset++] + 7; }

    // Pointer - does NOT use extended size bytes.
    if (type === 1) {
      const psize = (size >> 3) & 0x3;
      const vbits = size & 0x7;
      let ptr;
      if (psize === 0) {
        ptr = (vbits << 8) | this.buf[offset++];
      } else if (psize === 1) {
        ptr = (vbits << 16) | (this.buf[offset] << 8) | this.buf[offset + 1];
        ptr += 2048; offset += 2;
      } else if (psize === 2) {
        ptr = (vbits << 24) | (this.buf[offset] << 16) | (this.buf[offset + 1] << 8) | this.buf[offset + 2];
        ptr += 526336; offset += 3;
      } else {
        ptr = this.view.getUint32(offset, false); offset += 4;
      }
      const { value } = this._decode(this.dataSectionStart + ptr);
      return { value, nextOffset: offset };
    }

    // Extended size.
    if (size === 29) { size = this.buf[offset++] + 29; }
    else if (size === 30) { size = ((this.buf[offset] << 8) | this.buf[offset + 1]) + 285; offset += 2; }
    else if (size === 31) { size = ((this.buf[offset] << 16) | (this.buf[offset + 1] << 8) | this.buf[offset + 2]) + 65821; offset += 3; }

    switch (type) {
      case 2: { // UTF-8 string
        const value = textDecoder.decode(this.buf.subarray(offset, offset + size));
        return { value, nextOffset: offset + size };
      }
      case 5: // uint16
      case 6: { // uint32
        let v = 0;
        for (let i = 0; i < size; i++) v = (v * 256 + this.buf[offset + i]) >>> 0;
        return { value: v, nextOffset: offset + size };
      }
      case 7: { // map
        const map = {};
        let cur = offset;
        for (let i = 0; i < size; i++) {
          const k = this._decode(cur); cur = k.nextOffset;
          const v = this._decode(cur); cur = v.nextOffset;
          map[k.value] = v.value;
        }
        return { value: map, nextOffset: cur };
      }
      case 11: { // array
        const arr = [];
        let cur = offset;
        for (let i = 0; i < size; i++) {
          const item = this._decode(cur); cur = item.nextOffset;
          arr.push(item.value);
        }
        return { value: arr, nextOffset: cur };
      }
      case 14: { // boolean
        return { value: size !== 0, nextOffset: offset };
      }
      default:
        return { value: null, nextOffset: offset + size };
    }
  }

  // Traverse the trie for a 32-bit IPv4 address integer.
  _traverseIPv4(addrInt) {
    let node = this._ipv4StartNode;
    for (let i = 31; i >= 0; i--) {
      if (node >= this.nodeCount) break;
      node = this._child(node, (addrInt >>> i) & 1);
    }
    return node;
  }

  // Traverse the trie for an IPv6 address as a Uint8Array[16].
  _traverseIPv6(bytes16) {
    let node = 0;
    for (let byteIdx = 0; byteIdx < 16; byteIdx++) {
      const b = bytes16[byteIdx];
      for (let bit = 7; bit >= 0; bit--) {
        if (node >= this.nodeCount) break;
        node = this._child(node, (b >>> bit) & 1);
      }
      if (node >= this.nodeCount) break;
    }
    return node;
  }

  // Public: returns decoded data record or null.
  lookup(ip) {
    let finalNode;
    if (ip.includes(":")) {
      finalNode = this._traverseIPv6(expandIPv6(ip));
    } else {
      finalNode = this._traverseIPv4(ipv4ToInt(ip));
    }
    if (finalNode <= this.nodeCount) return null;
    // spec: file_offset = (record_value - node_count) + search_tree_size  (no +16)
    const dataOffset = this.treeSize + (finalNode - this.nodeCount);
    return this._decode(dataOffset).value;
  }
}

function ipv4ToInt(addr) {
  const p = addr.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

const PRIVATE_RANGES_V4 = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xe0000000, 0xffffffff], // 224.0.0.0+ (multicast/reserved)
];

function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip.startsWith("::") || ip === "::1") return true;
  if (ip.startsWith("fe80") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (!ip.includes(":")) {
    try {
      const n = ipv4ToInt(ip);
      return PRIVATE_RANGES_V4.some(([lo, hi]) => n >= lo && n <= hi);
    } catch {
      return true;
    }
  }
  return false;
}

function expandIPv6(addr) {
  if (addr.includes("::")) {
    const [left, right] = addr.split("::");
    const l = left ? left.split(":") : [];
    const r = right ? right.split(":") : [];
    const pad = 8 - l.length - r.length;
    addr = [...l, ...Array(pad).fill("0"), ...r].join(":");
  }
  const groups = addr.split(":").map((g) => parseInt(g || "0", 16));
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (groups[i] >> 8) & 0xff;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  return out;
}

async function saveDB(buffer) {
  await browser.storage.local.set({ [DB_KEY]: bufferToBase64(buffer) });
}

async function loadFromStorage() {
  const result = await browser.storage.local.get(DB_KEY);
  return result[DB_KEY] ? base64ToBuffer(result[DB_KEY]) : null;
}

let downloadInProgress = false;

async function fetchAndBuildDB() {
  if (downloadInProgress) return { ok: false, error: "Already in progress" };
  downloadInProgress = true;
  try {
    const url = (await getSettings()).url;
    if (!url) throw new Error("No URL configured - open Settings to set one.");

    console.log("[geoflags] Fetching MMDB from", url);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const buffer = await resp.arrayBuffer();
    const reader = new MMDBReader(buffer); // validates format

    mmdbReader = reader;
    await saveDB(buffer);
    await browser.storage.local.set({ dbLastFetch: Date.now() });
    console.log(`[geoflags] MMDB ready: ${reader.nodeCount} nodes, IPv${reader.ipVersion}`);
    return { ok: true, nodeCount: reader.nodeCount };
  } catch (e) {
    console.error("[geoflags] DB fetch failed:", e);
    return { ok: false, error: e.message };
  } finally {
    downloadInProgress = false;
  }
}

function lookup(ip) {
  if (!mmdbReader || !ip) return null;
  try {
    const record = mmdbReader.lookup(ip);
    if (!record || typeof record !== "object") return null;
    return {
      countryCode: record.country_code || record.iso_code || null,
      country: record.country_name || null,
    };
  } catch (e) {
    console.error("[geoflags] lookup error for", ip, e);
    return null;
  }
}

function getReader() {
  return mmdbReader;
}

function isDBReady() {
  return mmdbReader !== null;
}

async function initDB() {
  const buffer = await loadFromStorage();
  if (buffer) {
    try {
      mmdbReader = new MMDBReader(buffer);
      console.log(`[geoflags] MMDB loaded from storage: ${mmdbReader.nodeCount} nodes`);
    } catch (e) {
      console.error("[geoflags] Stored MMDB invalid:", e);
    }
  }
}
