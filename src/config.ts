import { ImmutableObject } from 'seamless-immutable'

/** Sentinel value for a layer dropdown meaning "exclude this category entirely". */
export const LINE_LAYER_NONE = '__none__'

/** Sentinel in selectedLayerIds meaning "no layers selected" (vs. empty = all). */
export const LAYER_SELECT_NONE = '__no_layers__'

/** Administrative levels used for the dash-dot division boundary walls. */
export type AdminLevelKey = 'village' | 'district' | 'city' | 'province' | 'country'

/** Per-level dash-dot wall block dimensions (m). */
export interface AdminLevelWallConfig {
  /** Whether this admin level is exported. */
  enabled: boolean
  /** Layer id to use for this level. Empty = auto-detect from title among selected layers. */
  layerId: string
/** Height of the dash and dot blocks (mm on plate). */
  height: number
  /** Half-width of the dash and dot blocks (mm on plate). */
  halfWidth: number
  /** Length of each dash block (mm on plate). */
  dashLength: number
  /** Length of each dot block (mm on plate). */
  dotLength: number
  /** Gap between a dash and the following dot(s) and between dots (mm on plate). */
  gap: number
}

/** Default dash-dot block dimensions for each admin level. */
export const DEFAULT_ADMIN_LEVELS: Record<AdminLevelKey, AdminLevelWallConfig> = {
  village: { enabled: true, layerId: '', height: 0.6, halfWidth: 0.3, dashLength: 1.8, dotLength: 0.6, gap: 0.4 },
  district: { enabled: true, layerId: '', height: 0.6, halfWidth: 0.3, dashLength: 1.8, dotLength: 0.6, gap: 0.4 },
  city: { enabled: true, layerId: '', height: 0.6, halfWidth: 0.3, dashLength: 1.8, dotLength: 0.6, gap: 0.4 },
  province: { enabled: true, layerId: '', height: 0.6, halfWidth: 0.3, dashLength: 1.8, dotLength: 0.6, gap: 0.4 },
  country: { enabled: true, layerId: '', height: 0.6, halfWidth: 0.3, dashLength: 1.8, dotLength: 0.6, gap: 0.4 }
}

export interface Config {
  includeTerrain: boolean
  includeLayers: boolean
  extrudeBase: boolean
  extrusionDepth: number
  /** Export administrative division polygons as raised boundary walls. */
  includePolygons: boolean
/** Height of the raised division boundary walls (mm on plate). */
  polygonWallHeight: number
  /** Half-width of the raised division boundary walls (mm on plate). */
  polygonWallHalfWidth: number
  /** Dash-dot block dimensions per admin level (village..country). */
  adminLevels: Record<AdminLevelKey, AdminLevelWallConfig>
/** Master switch for all Braille labels (layer labels + furniture labels). */
  includeLabels: boolean
/** Export admin division names as raised Braille labels at polygon centroids. */
  includeLayerLabels: boolean
  /** Height of each Braille dome above the terrain for layer labels (mm on plate). */
  labelDomeHeight: number
  /** Braille font size for layer labels, i.e. the dot pitch (mm on plate). Dot radius,
   *  dot pitch and cell spacing all derive from this single value. */
  labelFontSize: number
  /** Minimum clearance between an admin-name label and the AOI edge (mm on plate). */
  labelEdgeGap: number
  /** Export map furniture Braille text (title, scale bar label, print scale). */
  includeFurnitureLabels: boolean
  /** Height of each Braille dome above the frame for furniture labels (mm on plate). */
  furnitureLabelDomeHeight: number
  /** Braille font size for furniture labels, i.e. the dot pitch (mm on plate). */
  furnitureLabelFontSize: number
  /** Gap between the furniture Braille text and the adjacent block (mm on plate). */
  furnitureLabelEdgeGap: number
/** Export disaster related layers (raster contour bands, polygon/polyline/point features). */
  includeRaster: boolean
  /** Layer id designated as the hazard raster layer. Empty/'__none__' = excluded. */
  hazardLayerId: string
  /** Layer id designated as the disaster (polygon) layer. Empty/'__none__' = excluded. */
  disasterPolygonLayerId: string
  /** Layer id designated as the disaster (polyline) layer. Empty/'__none__' = excluded. */
  disasterPolylineLayerId: string
  /** Layer id designated as the disaster (point) layer. Empty/'__none__' = excluded. */
  disasterPointLayerId: string
  /** Height of the raised disaster polygon areas (mm on plate). */
  disasterPolygonHeight: number
  /** Height of the raised disaster polyline walls (mm on plate). */
  disasterWallHeight: number
  /** Half-width of the raised disaster polyline walls (mm on plate). */
  disasterWallHalfWidth: number
  /** Radius of the disaster point domes (mm on plate). */
  disasterPointRadius: number
  /** Height of the disaster point domes (mm on plate). */
  disasterPointHeight: number
  /** Attribute field whose distinct values form the disaster polygon height classes. Empty = single height. */
  disasterPolygonClassField: string
  /** Per-class heights (mm on plate) for the disaster polygon layer, keyed by class field value. */
  disasterPolygonClassHeights: Record<string, number>
  /** Attribute field whose distinct values form the disaster polyline height classes. Empty = single height. */
  disasterPolylineClassField: string
  /** Per-class heights (mm on plate) for the disaster polyline walls, keyed by class field value. */
  disasterPolylineClassHeights: Record<string, number>
  /** Attribute field whose distinct values form the disaster point height classes. Empty = single height. */
  disasterPointClassField: string
  /** Per-class heights (mm on plate) for the disaster point domes, keyed by class field value. */
  disasterPointClassHeights: Record<string, number>
  /** Per-band heights (mm on plate) for the raster contour bands. Empty = linear scaling from rasterMaxHeight. */
  rasterBandHeights: number[]
/** Export line feature layers (e.g. roads, rivers) as raised wall lines. */
  includeLines: boolean
  /** Export the designated roads layers (polyline walls and/or polygon areas). */
  includeRoads: boolean
  /** Export the designated rivers layers (polyline walls and/or polygon areas). */
  includeRivers: boolean
/** Height of the raised road walls (mm on plate). */
  roadsWallHeight: number
  /** Half-width of the raised road walls (mm on plate). */
  roadsWallHalfWidth: number
  /** Height of the raised river walls (mm on plate). */
  riversWallHeight: number
  /** Half-width of the raised river walls (mm on plate). */
  riversWallHalfWidth: number
  /** Height of the filled river polygon areas (mm on plate). */
  riversPolygonHeight: number
  /** Height of the filled roads polygon areas (mm on plate). */
  roadsPolygonHeight: number
  /** Layer id designated as the roads (polyline) layer. Empty = automatic from selection. */
  roadsLayerId: string
  /** Layer id designated as the roads (polygon) layer. Empty = automatic from selection. */
  roadsPolygonLayerId: string
  /** Layer id designated as the rivers (polyline) layer. Empty = automatic from selection. */
  riversLayerId: string
  /** Layer id designated as the rivers (polygon) layer. Empty = automatic from selection. */
  riversPolygonLayerId: string
  /** Simplify dense building meshes (vertex clustering) to shrink STL size. */
  simplifyMeshes: boolean
/** Cell size (mm on plate) used for vertex clustering when simplifying meshes. */
  simplifyCell: number
  /** Number of contour bands the raster is classified into. */
  rasterBands: number
  /** Sampling grid cells per side used to read raster values. */
  rasterGrid: number
/** Height reached by the top contour band (mm on plate). */
  rasterMaxHeight: number
  /** Absolute Z where raised polygon/raster geometry starts. */
  baseZ0: number
  /** Add dome-shaped dots on top of the tsunami hazard contour bands. */
  hazardDots: boolean
  /** Number of dots along one edge of each raster cell. */
  hazardDotsPerCell: number
  /** Radius of a dot in hazard band 1 (mm on plate). */
  hazardDotRadius: number
  /** Height of a dot in hazard band 1 (mm on plate). */
  hazardDotHeight: number
  /** Ids of layers to export. Empty array means export all relevant layers. */
  selectedLayerIds: string[]
  /** Add a flat base plate spanning the whole rectangle (no terrain needed). */
  flatBase: boolean
/** Thickness of the flat base plate below the surface (mm on plate). */
  flatBaseThickness: number
  /** Build a flat offset margin around the AOI for the title/scale/north arrow. */
  includeMargin: boolean
  /** Thickness of the flat offset frame below the surface (m). */
  marginThickness: number
  /** Top (north) offset width around the AOI (m). */
  marginTop: number
  /** Left (west) offset width around the AOI (m). */
  marginLeft: number
  /** Right (east) offset width around the AOI (m). */
  marginRight: number
  /** Bottom (south) offset width around the AOI (m). */
  marginBottom: number
/** Render a custom map title as raised Braille on the top margin. */
  includeTitle: boolean
  /** Custom map title text (rendered as Braille). */
  mapTitle: string
  /** Alternating-block scale bar on the bottom margin. */
  includeScaleBar: boolean
  /** Total scale bar length (mm on plate). */
  scaleBarLength: number
  /** Scale bar full width (mm on plate). */
  scaleBarWidth: number
  /** Raised block height (mm on plate). */
  scaleBarHeight: number
  /** Print scale (1:X) as Braille on the bottom-right margin. */
  includePrintScale: boolean
  /** 3D north arrow on the top-right margin. */
  includeNorthArrow: boolean
  /** North arrow total length (mm on plate). */
  northArrowLength: number
  /** North arrow shaft width (mm on plate). */
  northArrowWidth: number
  /** North arrow height above the frame (mm on plate). */
  northArrowHeight: number
  /** Clearance between the north arrow and the margin edge (mm on plate). */
  northArrowGap: number
  /** Use the layout mode (plate size + scale) to drive margins & furniture. */
  useLayout: boolean
  /** Plate preset key: 'A4-L' | 'A3-L' | 'A2-L' | 'CUSTOM'. */
  layoutPlatePreset: string
  /** Plate width (mm) when custom, or synced to the preset. */
  layoutPlateWidth: number
  /** Plate height (mm) when custom, or synced to the preset. */
  layoutPlateHeight: number
  /** Print scale denominator (1:this). */
  layoutScaleDenom: number
  /** Top (north) margin on the plate (mm). */
  layoutMarginTop: number
  /** Left (west) margin on the plate (mm). */
  layoutMarginLeft: number
  /** Right (east) margin on the plate (mm). */
  layoutMarginRight: number
  /** Bottom (south) margin on the plate (mm). */
  layoutMarginBottom: number
  /** Auto-scale so the AOI fits the plate map frame. */
  layoutFitToPlate: boolean
}

export type IMConfig = ImmutableObject<Config>

/** Landscape plate presets (mm) for the layout view. */
export const PLATE_PRESETS: Record<string, { width: number, height: number, label: string }> = {
  'A4-L': { width: 297, height: 210, label: 'A4 landscape' },
  'A3-L': { width: 420, height: 297, label: 'A3 landscape' },
  'A2-L': { width: 594, height: 420, label: 'A2 landscape' },
  'CUSTOM': { width: 400, height: 300, label: 'Custom' }
}

/** Returns the plate size (mm) for the configured preset. */
export function plateSizeMm(config: { layoutPlatePreset?: string, layoutPlateWidth?: number, layoutPlateHeight?: number }): { width: number, height: number } {
  const preset = PLATE_PRESETS[config.layoutPlatePreset ?? 'A4-L'] ?? PLATE_PRESETS['A4-L']
  if ((config.layoutPlatePreset ?? 'A4-L') === 'CUSTOM') {
    return {
      width: config.layoutPlateWidth ?? preset.width,
      height: config.layoutPlateHeight ?? preset.height
    }
  }
  return { width: preset.width, height: preset.height }
}




