// Format-independent board model. All lengths in mm, Y axis up.
// The EasyEDA file parser (packages/cli) and the extension (packages/extension, from the EDA API) fill it.

export interface Pt {
  x: number;
  y: number;
}
export type Path = Pt[];
/** Region as Clipper-style paths: outers counter-clockwise, holes clockwise. */
export type Paths = Path[];

export interface CopperLayer {
  id: number;
  name: string;
  /** 0 = top, increasing downwards. */
  index: number;
  /** Depth of the layer from the top copper surface, mm (dielectrics only). */
  z: number;
}

export interface Dielectric {
  name: string;
  thicknessMm: number;
  er?: number;
  lossTangent?: number;
}

export interface Stackup {
  copper: CopperLayer[];
  /** dielectrics[i] lies between copper[i] and copper[i + 1]. */
  dielectrics: Dielectric[];
}

export interface Track {
  id: string;
  net: string;
  layer: number;
  a: Pt;
  b: Pt;
  width: number;
}

export interface Via {
  id: string;
  net: string;
  at: Pt;
  drill: number;
  diameter: number;
  /** True for EasyEDA "stitching via" type. Any via of a reference net can carry return current. */
  stitching: boolean;
}

export const MULTI_LAYER = -1;

export interface Pad {
  id: string;
  net: string;
  /** Copper layer id, or MULTI_LAYER for through-hole pads. */
  layer: number;
  number: string;
  at: Pt;
  /** Absolute copper outline. */
  shape: Paths;
  holeDiameter: number;
  componentId?: string;
}

export interface Component {
  id: string;
  designator: string;
  at: Pt;
  rotation: number;
  layer: number;
  padIds: string[];
}

export interface Pour {
  id: string;
  net: string;
  layer: number;
  name: string;
  /** Lower number = poured first = wins over later pours. */
  priority: number;
  outline: Paths;
  /** Pre-computed fill from the file (POURED), already including clearances. */
  poured?: Paths;
}

/** Area where no pour copper may exist on a layer (EasyEDA REGION keepouts, board slots). */
export interface Keepout {
  id: string;
  /** Layer id, or MULTI_LAYER for all copper layers. */
  layer: number;
  outline: Paths;
}

export interface Board {
  outline: Paths;
  stackup: Stackup;
  nets: string[];
  tracks: Track[];
  vias: Via[];
  pads: Pad[];
  components: Component[];
  pours: Pour[];
  keepouts: Keepout[];
  warnings: string[];
}
