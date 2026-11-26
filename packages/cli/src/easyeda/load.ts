import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { Board } from '@returnpath/core';
import { parseEasyEdaPcb, type ParseOptions } from './parse.js';

/**
 * Load a board from an EasyEDA Pro project (.epro / .zip: PCB *.epcb + FOOTPRINT *.efoo + optional *.ecop;
 * .epro2: one *.epru holding all documents)
 * or a bare PCB document (.epcb / saved getDocumentSource() text).
 */
export function loadBoard(file: string, opts: ParseOptions & { pcb?: string } = {}): Board {
  const ext = extname(file).toLowerCase();
  const buf = readFileSync(file);
  if (ext !== '.epro' && ext !== '.zip' && ext !== '.epro2') return parseEasyEdaPcb({ pcb: buf.toString('utf8') }, opts);

  const entries = unzipSync(new Uint8Array(buf));
  const pcbs: [string, string][] = [];
  const footprints = new Map<string, string>();
  const poured: string[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const text = () => strFromU8(data);
    const stem = basename(name).split('.')[0];
    if (name.endsWith('.epcb')) pcbs.push([name, text()]);
    else if (name.endsWith('.efoo')) footprints.set(stem, text());
    else if (name.endsWith('.ecop')) poured.push(text());
    else if (name.endsWith('.epru')) {
      for (const doc of splitEpru(text())) {
        if (doc.type === 'PCB') pcbs.push([`${name}#${doc.uuid}`, doc.text]);
        else if (doc.type === 'FOOTPRINT') footprints.set(doc.uuid, doc.text);
      }
    }
  }
  if (!pcbs.length) throw new Error(`${file}: no .epcb document inside`);
  const parse = ([, pcb]: [string, string]) => parseEasyEdaPcb({ pcb, footprints, poured }, opts);
  if (opts.pcb) {
    const chosen = pcbs.find(([n]) => n.includes(opts.pcb!));
    if (!chosen) throw new Error(`${file}: no PCB matching "${opts.pcb}" (have ${pcbs.map(([n]) => n).join(', ')})`);
    return parse(chosen);
  }
  if (pcbs.length === 1) return parse(pcbs[0]);
  // Projects keep old copies and part-routed variants; the most routed PCB is the likely one.
  const parsed = pcbs.map((p) => ({ name: p[0], board: parse(p) }));
  const best = parsed.reduce((a, b) => (b.board.tracks.length > a.board.tracks.length ? b : a));
  const others = parsed.filter((p) => p !== best).map((p) => `${p.name} (${p.board.tracks.length} tracks)`);
  best.board.warnings.push(`Project has ${pcbs.length} PCBs; analysed ${best.name}, the one with the most tracks (${best.board.tracks.length}). Others: ${others.join(', ')}. Use --pcb to pick.`);
  return best.board;
}

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
