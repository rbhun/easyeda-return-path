// EasyEDA Pro document lines → uniform records.
// Two encodings exist:
//   array form (older .epcb/.efoo):   ["LINE","e1",0,"CLK",1,100,200,400,200,10,0]
//   object form (current source):     {"type":"LINE","id":"e1","ticket":1}||{"netName":"CLK",...}|
// Array lines are mapped onto the object form's field names so one builder handles both.

export type Rec = { type: string; id: string; [k: string]: unknown };

export const ARRAY_FIELDS: Record<string, string[]> = {
  DOCTYPE: ['docType'],
  LAYER: ['id', 'layerType', 'layerName', 'status'],
  LAYER_PHYS: ['id', 'material', 'thickness', 'permittivity', 'lossTangent'],
  NET: ['id', 'netType'],
  LINE: ['id', 'groupId', 'netName', 'layerId', 'startX', 'startY', 'endX', 'endY', 'width'],
  ARC: ['id', 'groupId', 'netName', 'layerId', 'startX', 'startY', 'endX', 'endY', 'angle', 'width'],
  VIA: ['id', 'groupId', 'netName', 'ruleName', 'centerX', 'centerY', 'holeDiameter', 'viaDiameter', 'viaType'],
  PAD: ['id', 'groupId', 'netName', 'layerId', 'num', 'centerX', 'centerY', 'padAngle', 'hole', 'defaultPad', 'specialPad', 'padOffsetX', 'padOffsetY', 'relativeAngle', 'plated'],
  POUR: ['id', 'groupId', 'netName', 'layerId', 'width', 'name', 'order', 'path', 'pourType', 'keepIsland'],
  POURED: ['id', 'targetId', 'strokeWidth', 'fill', 'path'],
  FILL: ['id', 'groupId', 'netName', 'layerId', 'width', 'fillStyle', 'path'],
  REGION: ['id', 'groupId', 'layerId', 'width', 'prohibitType', 'path'],
  POLY: ['id', 'groupId', 'netName', 'layerId', 'width', 'path'],
  COMPONENT: ['id', 'groupId', 'layerId', 'positionX', 'positionY', 'angle', 'attrs'],
  PAD_NET: ['id', 'padNum', 'padNet', 'padId'],
};

function fromArray(arr: unknown[]): Rec | null {
  const type = arr[0];
  if (typeof type !== 'string') return null;
  const rest = arr.slice(1);
  if (type === 'ATTR') {
    // Seen both as [id, group, parent, layer, x, y, key, value, ...] and [id, group, parent, layer, key, value, ...].
    const withPos = typeof rest[4] !== 'string';
    return { type, id: String(rest[0]), parentId: rest[2], layerId: rest[3], key: withPos ? rest[6] : rest[4], value: withPos ? rest[7] : rest[5] };
  }
  if (type === 'HEAD') return { type, id: '', ...(rest[0] as object) };
  const fields = ARRAY_FIELDS[type];
  if (!fields) return { type, id: String(rest[0] ?? ''), raw: rest };
  const rec: Rec = { type, id: '' };
  fields.forEach((f, i) => (rec[f] = rest[i]));
  rec.id = String(rec.id ?? '');
  if (type === 'POUR' && typeof rec.netName !== 'string') return pourFallback(rest);
  return rec;
}

/** Tolerate POUR variants that carry extra leading fields (partition, zIndex, locked). */
function pourFallback(rest: unknown[]): Rec {
  const netIdx = rest.findIndex((v, i) => i > 0 && typeof v === 'string');
  const pathIdx = rest.findIndex((v) => Array.isArray(v) && (Array.isArray(v[0]) || typeof v[0] === 'number'));
  return {
    type: 'POUR',
    id: String(rest[0]),
    netName: rest[netIdx],
    layerId: rest[netIdx + 1],
    name: rest.slice(netIdx + 1).find((v) => typeof v === 'string') ?? '',
    order: rest[pathIdx - 1],
    path: rest[pathIdx],
  };
}

function parseLoose(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    // Documentation samples (and some exports) leave trailing commas in objects.
    return JSON.parse(json.replace(/,\s*([}\]])/g, '$1'));
  }
}

export function parseRecords(text: string): Rec[] {
  const out: Rec[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      const r = fromArray(parseLoose(line) as unknown[]);
      if (r) out.push(r);
    } else if (line.startsWith('{')) {
      const sep = line.indexOf('||');
      const head = parseLoose(sep >= 0 ? line.slice(0, sep) : line) as { type: string; id?: unknown };
      let body = sep >= 0 ? line.slice(sep + 2).trim() : '';
      if (body.endsWith('|')) body = body.slice(0, -1);
      const payload = body ? (parseLoose(body) as object) : {};
      out.push({ ...payload, type: head.type, id: String(head.id ?? '') });
    }
  }
  return out;
}
