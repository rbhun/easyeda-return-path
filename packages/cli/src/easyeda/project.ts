// Pin names from an EasyEDA Pro project: each device names its symbol, and each symbol pin carries
// "Pin Number" and "Pin Name". No Node APIs, so the extension uses it on the project file too.
import { strFromU8 } from 'fflate';
import { parseRecords } from './records.js';

/** An `.epru` (inside `.epro2`) holds every document of the project in one file, each starting with a DOCHEAD line. */
export function splitEpru(text: string): { type: string; uuid: string; text: string }[] {
  const docs: { type: string; uuid: string; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('{"type":"DOCHEAD"')) {
      const body = line.slice(line.indexOf('||') + 2).replace(/\|\s*$/, '');
      const head = JSON.parse(body) as { docType?: string; uuid?: string };
      docs.push({ type: head.docType ?? '', uuid: head.uuid ?? '', lines: [] });
    } else if (docs.length) docs[docs.length - 1].lines.push(line);
  }
  return docs.map((d) => ({ type: d.type, uuid: d.uuid, text: d.lines.join('\n') }));
}

/** Pin number → pin name of a SYMBOL document (each PIN carries "Pin Number" and "Pin Name" ATTRs). */
export function symbolPinNames(text: string): Map<string, string> {
  const byPin = new Map<string, { number?: string; name?: string }>();
  for (const r of parseRecords(text)) {
    if (r.type !== 'ATTR' || !r.parentId) continue;
    const key = String(r.key);
    if (key !== 'Pin Number' && key !== 'Pin Name') continue;
    const id = String(r.parentId);
    const p = byPin.get(id) ?? {};
    if (key === 'Pin Number') p.number = String(r.value);
    else p.name = String(r.value);
    byPin.set(id, p);
  }
  const out = new Map<string, string>();
  for (const p of byPin.values()) if (p.number && p.name && p.name !== p.number) out.set(p.number, p.name);
  return out;
}

export interface ProjectPinNames {
  /** Device UUID → pin number → pin name. */
  byDevice: Map<string, Map<string, string>>;
  /** Designator → pin number → pin name, through the device of each component on the project's PCBs. */
  byDesignator: Map<string, Map<string, string>>;
}

/** Pin names of an unzipped `.epro2` (its `.epru` documents). */
export function projectPinNames(entries: Record<string, Uint8Array>): ProjectPinNames {
  const deviceSymbol = new Map<string, string>();
  const symbolPins = new Map<string, Map<string, string>>();
  const pcbs: string[] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (!name.endsWith('.epru')) continue;
    for (const doc of splitEpru(strFromU8(data))) {
      if (doc.type === 'DEVICE') {
        const symbol = /"Symbol":"([^"]+)"/.exec(doc.text)?.[1];
        if (symbol) deviceSymbol.set(doc.uuid, symbol);
      } else if (doc.type === 'SYMBOL') symbolPins.set(doc.uuid, symbolPinNames(doc.text));
      else if (doc.type === 'PCB') pcbs.push(doc.text);
    }
  }
  const byDevice = new Map([...deviceSymbol].flatMap(([device, symbol]) => (symbolPins.get(symbol)?.size ? [[device, symbolPins.get(symbol)!] as const] : [])));
  const byDesignator = new Map<string, Map<string, string>>();
  for (const pcb of pcbs) {
    // Only components and their attributes are needed; pour and track lines are most of a PCB.
    const recs = parseRecords(pcb.split(/\r?\n/).filter((l) => /^\s*(\{"type":"(COMPONENT|ATTR)"|\["(COMPONENT|ATTR)")/.test(l)).join('\n'));
    const attrs = new Map<string, Map<string, string>>();
    for (const r of recs) {
      if (r.type !== 'ATTR' || r.parentId == null) continue;
      const parent = String(r.parentId);
      if (!attrs.has(parent)) attrs.set(parent, new Map());
      attrs.get(parent)!.set(String(r.key).toLowerCase(), String(r.value ?? ''));
    }
    for (const r of recs) {
      if (r.type !== 'COMPONENT') continue;
      const a = attrs.get(r.id);
      const own = (r.attrs ?? {}) as Record<string, unknown>;
      const designator = a?.get('designator') || (typeof own.Designator === 'string' ? own.Designator : '');
      const names = byDevice.get(a?.get('device') || (typeof own.Device === 'string' ? own.Device : ''));
      if (designator && names && !byDesignator.has(designator)) byDesignator.set(designator, names);
    }
  }
  return { byDevice, byDesignator };
}
