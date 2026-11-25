import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { Board } from '@returnpath/core';
import { parseEasyEdaPcb, type ParseOptions } from './parse.js';

/**
 * Load a board from an EasyEDA Pro project (.epro / .zip: PCB *.epcb + FOOTPRINT *.efoo + optional *.ecop)
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
  }
  if (!pcbs.length) throw new Error(`${file}: no .epcb document inside`);
  const chosen = opts.pcb ? pcbs.find(([n]) => n.includes(opts.pcb!)) : pcbs[0];
  if (!chosen) throw new Error(`${file}: no PCB matching "${opts.pcb}" (have ${pcbs.map(([n]) => n).join(', ')})`);
  const board = parseEasyEdaPcb({ pcb: chosen[1], footprints, poured }, opts);
  if (pcbs.length > 1) board.warnings.push(`Project has ${pcbs.length} PCBs; analysed ${chosen[0]} (use --pcb to pick).`);
  return board;
}
