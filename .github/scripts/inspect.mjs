// Разбор «сертификата предмета» (asset_properties, propertyid 6) из открытого инвентаря Steam.
// Это те же данные, что использует осмотр предмета в игре: байт 0 — ключ XOR, последние 4 байта — контрольная сумма,
// внутри — protobuf CEconItemPreviewDataBlock: 3 defindex, 4 paintindex, 7 paintwear, 8 paintseed, 12 наклейки, 20 брелки.

function varint(b, i) {
  let r = 0, s = 0, x;
  do { x = b[i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80 && i < b.length);
  return [r, i];
}

function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    let k; [k, i] = varint(b, i);
    const f = Math.floor(k / 8), t = k % 8;
    if (t === 0) { let v; [v, i] = varint(b, i); out.push({ f, v }); }
    else if (t === 2) { let l; [l, i] = varint(b, i); out.push({ f, b: b.subarray(i, i + l) }); i += l; }
    else if (t === 5) { out.push({ f, f32: b.readFloatLE(i) }); i += 4; }
    else if (t === 1) { i += 8; }
    else throw new Error('wire type ' + t);
  }
  return out;
}

const stickerOf = (b) => {
  const s = { slot: null, id: null, wear: null, pattern: null };
  for (const x of fields(b)) {
    if (x.f === 1) s.slot = x.v;
    else if (x.f === 2) s.id = x.v;
    else if (x.f === 3) s.wear = x.f32 ?? null;
    else if (x.f === 10) s.pattern = x.v; // у брелков — номер шаблона
  }
  return s;
};

/** → { defindex, paintindex, float, seed, stickers: [{id, wear}], charms: [{id, pattern}] } или null. */
export function decodeCertificate(hex) {
  if (typeof hex !== 'string' || hex.length < 12 || hex.length > 4000 || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
  const raw = Buffer.from(hex, 'hex');
  const key = raw[0];
  const body = Buffer.from(raw.subarray(1, raw.length - 4).map((c) => c ^ key));
  try {
    const r = { defindex: null, paintindex: null, float: null, seed: null, stickers: [], charms: [] };
    for (const x of fields(body)) {
      if (x.f === 3) r.defindex = x.v;
      else if (x.f === 4) r.paintindex = x.v;
      else if (x.f === 7 && x.v !== undefined) { const t = Buffer.alloc(4); t.writeUInt32LE(x.v >>> 0); r.float = t.readFloatLE(0); }
      else if (x.f === 8) r.seed = x.v;
      else if (x.f === 12 && x.b) r.stickers.push(stickerOf(x.b));
      else if (x.f === 20 && x.b) r.charms.push(stickerOf(x.b));
    }
    return r;
  } catch {
    return null;
  }
}
