import { React, type AllWidgetProps } from 'jimu-core'
import { JimuMapViewComponent, type JimuMapView } from 'jimu-arcgis'
import { Switch, NumericInput } from 'jimu-ui'
import type SceneView from 'esri/views/SceneView'
import Point from 'esri/geometry/Point'
import Polygon from 'esri/geometry/Polygon'
import Query from 'esri/rest/support/Query'
import reactiveUtils from 'esri/core/reactiveUtils'
import { exportScene, type PreviewGeometry, computeLayoutPreviewData, type LayoutPreviewData } from './lib/exportScene'
import { downloadBlob } from './lib/writeStl'
import { Preview3D } from './lib/preview3d'
import type { Config, AdminLevelKey, AdminLevelWallConfig } from '../config'
import { LAYER_SELECT_NONE, LINE_LAYER_NONE, DEFAULT_ADMIN_LEVELS, PLATE_PRESETS, plateSizeMm } from '../config'

const { useState, useRef, useEffect } = React

interface DrawState {
  start: { x: number, y: number }
  last: { x: number, y: number } | null
}

function buildRectangle(p1: Point, p2: Point, sr: any): Polygon {
  const xmin = Math.min(p1.x, p2.x)
  const xmax = Math.max(p1.x, p2.x)
  const ymin = Math.min(p1.y, p2.y)
  const ymax = Math.max(p1.y, p2.y)
  return new Polygon({
    spatialReference: sr,
    hasZ: false,
    rings: [
      [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax], [xmin, ymin]]
    ]
  })
}

/**
 * Builds the ground AOI rectangle from the drawn screen rectangle.
 *
 * In a tilted 3D view, `view.toMap` of two screen corners produces a ground
 * rectangle that is foreshortened: a square on screen maps to a taller-than-wide
 * ground box because the far edge spans more ground per pixel than the near edge.
 * To keep the exported AOI matching what the user drew, we anchor on the ground
 * point of the screen centre and re-scale the box so its ground aspect ratio
 * equals the drawn on-screen aspect ratio (square draw => square AOI).
 */
function buildRectangleFromScreen(
  view: any,
  start: { x: number, y: number },
  end: { x: number, y: number },
  sr: any
): Polygon {
  const cx = (start.x + end.x) / 2
  const cy = (start.y + end.y) / 2
  const sw = Math.abs(end.x - start.x)
  const sh = Math.abs(end.y - start.y)
  if (sw <= 0 || sh <= 0) {
    return buildRectangle(view.toMap({ x: start.x, y: start.y } as any), view.toMap({ x: end.x, y: end.y } as any), sr)
  }

  const centerMap = view.toMap({ x: cx, y: cy } as any)
  if (!centerMap) {
    return buildRectangle(view.toMap({ x: start.x, y: start.y } as any), view.toMap({ x: end.x, y: end.y } as any), sr)
  }

  // Ground metres per screen pixel measured along the screen's horizontal axis
  // at the anchor point. The vertical dimension is then derived from this same
  // scale so the AOI keeps the on-screen aspect ratio (fixing the tilted-camera
  // foreshortening that would otherwise make a square draw vertically wide).
  let mpp: number
  try {
    const px = view.toMap({ x: cx + sw, y: cy } as any)
    mpp = px ? Math.abs(px.x - centerMap.x) / sw : 0
  } catch (e) {
    mpp = 0
  }
  if (mpp <= 0) {
    return buildRectangle(view.toMap({ x: start.x, y: start.y } as any), view.toMap({ x: end.x, y: end.y } as any), sr)
  }

  const halfW = (sw / 2) * mpp
  const halfH = halfW * (sh / sw)
  const xmin = centerMap.x - halfW
  const xmax = centerMap.x + halfW
  const ymin = centerMap.y - halfH
  const ymax = centerMap.y + halfH
  return new Polygon({
    spatialReference: sr,
    hasZ: false,
    rings: [
      [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax], [xmin, ymin]]
    ]
  })
}

const Widget = (props: AllWidgetProps<Config>) => {
  const [isScene, setIsScene] = useState(false)
  const [drawMode, setDrawMode] = useState(false)
  const [rectangle, setRectangle] = useState<Polygon | null>(null)
  const [exporting, setExporting] = useState(false)
  const [status, setStatus] = useState('Select a 3D map in the widget settings.')
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>(props.config?.selectedLayerIds ?? [])
  const [layerList, setLayerList] = useState<Array<{ id: string, title: string, type: string }>>([])
  const [sceneLayerList, setSceneLayerList] = useState<Array<{ id: string, title: string }>>([])
  const [rasterLayerList, setRasterLayerList] = useState<Array<{ id: string, title: string }>>([])
  const [lineLayerList, setLineLayerList] = useState<Array<{ id: string, title: string }>>([])
  const [polylineLayerList, setPolylineLayerList] = useState<Array<{ id: string, title: string, fields: string[] }>>([])
  const [polygonLayerList, setPolygonLayerList] = useState<Array<{ id: string, title: string, fields: string[] }>>([])
  const [pointLayerList, setPointLayerList] = useState<Array<{ id: string, title: string, fields: string[] }>>([])
  const [divisionPolygonList, setDivisionPolygonList] = useState<Array<{ id: string, title: string }>>([])
  const [riverPolygonList, setRiverPolygonList] = useState<Array<{ id: string, title: string }>>([])
  const [part, setPart] = useState(1)
  const maxPart = 5
  const [pvZoom, setPvZoom] = useState(1)
  const [pvPan, setPvPan] = useState<{ x: number, y: number }>({ x: 0, y: 0 })
  const [previewGeom, setPreviewGeom] = useState<PreviewGeometry | null>(null)
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null)
  const [previewTriangles, setPreviewTriangles] = useState(0)
  const [previewLayers, setPreviewLayers] = useState(0)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [layoutPreviewData, setLayoutPreviewData] = useState<LayoutPreviewData | null>(null)
  const [options, setOptions] = useState<Config>({
    includeTerrain: props.config?.includeTerrain !== false,
    includeLayers: props.config?.includeLayers !== false,
    extrudeBase: props.config?.extrudeBase !== false,
    extrusionDepth: props.config?.extrusionDepth ?? 2,
    includePolygons: props.config?.includePolygons !== false,
    polygonWallHeight: props.config?.polygonWallHeight ?? 0.8,
    polygonWallHalfWidth: props.config?.polygonWallHalfWidth ?? 0.3,
    adminLevels: {
      ...DEFAULT_ADMIN_LEVELS,
      ...(props.config?.adminLevels ?? {})
    },
    includeLabels: props.config?.includeLabels !== false,
    includeLayerLabels: props.config?.includeLayerLabels !== false,
    labelDomeHeight: props.config?.labelDomeHeight ?? 0.5,
    labelFontSize: props.config?.labelFontSize ?? 2.5,
    labelEdgeGap: props.config?.labelEdgeGap ?? 5,
    includeFurnitureLabels: props.config?.includeFurnitureLabels !== false,
    furnitureLabelDomeHeight: props.config?.furnitureLabelDomeHeight ?? 0.5,
    furnitureLabelFontSize: props.config?.furnitureLabelFontSize ?? 2.5,
    furnitureLabelEdgeGap: props.config?.furnitureLabelEdgeGap ?? 4,
    includeRaster: props.config?.includeRaster !== false,
    hazardLayerId: props.config?.hazardLayerId ?? LINE_LAYER_NONE,
    disasterPolygonLayerId: props.config?.disasterPolygonLayerId ?? LINE_LAYER_NONE,
    disasterPolylineLayerId: props.config?.disasterPolylineLayerId ?? LINE_LAYER_NONE,
    disasterPointLayerId: props.config?.disasterPointLayerId ?? LINE_LAYER_NONE,
    disasterPolygonHeight: props.config?.disasterPolygonHeight ?? 0.6,
    disasterWallHeight: props.config?.disasterWallHeight ?? 0.6,
    disasterWallHalfWidth: props.config?.disasterWallHalfWidth ?? 0.1,
    disasterPointRadius: props.config?.disasterPointRadius ?? 0.3,
    disasterPointHeight: props.config?.disasterPointHeight ?? 0.5,
    disasterPolygonClassField: props.config?.disasterPolygonClassField ?? '',
    disasterPolygonClassHeights: props.config?.disasterPolygonClassHeights ?? {},
    disasterPolylineClassField: props.config?.disasterPolylineClassField ?? '',
    disasterPolylineClassHeights: props.config?.disasterPolylineClassHeights ?? {},
    disasterPointClassField: props.config?.disasterPointClassField ?? '',
    disasterPointClassHeights: props.config?.disasterPointClassHeights ?? {},
    rasterBandHeights: props.config?.rasterBandHeights ?? [],
    rasterBands: props.config?.rasterBands ?? 4,
    rasterGrid: props.config?.rasterGrid ?? 24,
    rasterMaxHeight: props.config?.rasterMaxHeight ?? 1.6,
    baseZ0: props.config?.baseZ0 ?? 0,
    includeLines: props.config?.includeLines !== false,
    includeRoads: props.config?.includeRoads !== false,
    includeRivers: props.config?.includeRivers !== false,
    roadsWallHeight: props.config?.roadsWallHeight ?? 0.6,
    roadsWallHalfWidth: props.config?.roadsWallHalfWidth ?? 0.1,
    roadsPolygonHeight: props.config?.roadsPolygonHeight ?? 0.6,
    riversWallHeight: props.config?.riversWallHeight ?? 0.6,
    riversWallHalfWidth: props.config?.riversWallHalfWidth ?? 0.1,
    riversPolygonHeight: props.config?.riversPolygonHeight ?? 0.6,
    roadsLayerId: props.config?.roadsLayerId ?? LINE_LAYER_NONE,
    roadsPolygonLayerId: props.config?.roadsPolygonLayerId ?? LINE_LAYER_NONE,
    riversLayerId: props.config?.riversLayerId ?? LINE_LAYER_NONE,
    riversPolygonLayerId: props.config?.riversPolygonLayerId ?? LINE_LAYER_NONE,
    simplifyMeshes: props.config?.simplifyMeshes !== false,
    simplifyCell: props.config?.simplifyCell ?? 0.1,
    hazardDots: props.config?.hazardDots !== false,
    hazardDotsPerCell: props.config?.hazardDotsPerCell ?? 3,
    hazardDotRadius: props.config?.hazardDotRadius ?? 0.2,
    hazardDotHeight: props.config?.hazardDotHeight ?? 0.24,
    selectedLayerIds: [],
    flatBase: props.config?.flatBase === true,
    flatBaseThickness: props.config?.flatBaseThickness ?? 0.4,
    includeMargin: props.config?.includeMargin !== false,
    marginThickness: props.config?.marginThickness ?? 2,
    marginTop: props.config?.marginTop ?? 25,
    marginLeft: props.config?.marginLeft ?? 8,
    marginRight: props.config?.marginRight ?? 8,
    marginBottom: props.config?.marginBottom ?? 12,
    includeTitle: props.config?.includeTitle !== false,
    mapTitle: props.config?.mapTitle ?? '',
    includeScaleBar: props.config?.includeScaleBar !== false,
    scaleBarLength: props.config?.scaleBarLength ?? 40,
    scaleBarWidth: props.config?.scaleBarWidth ?? 3,
    scaleBarHeight: props.config?.scaleBarHeight ?? 0.8,
    includePrintScale: props.config?.includePrintScale !== false,
    includeNorthArrow: props.config?.includeNorthArrow !== false,
    northArrowLength: props.config?.northArrowLength ?? 12,
    northArrowWidth: props.config?.northArrowWidth ?? 6,
    northArrowHeight: props.config?.northArrowHeight ?? 1.2,
    northArrowGap: props.config?.northArrowGap ?? 8,
    useLayout: props.config?.useLayout === true,
    layoutPlatePreset: props.config?.layoutPlatePreset ?? 'A4-L',
    layoutPlateWidth: props.config?.layoutPlateWidth ?? 400,
    layoutPlateHeight: props.config?.layoutPlateHeight ?? 300,
    layoutScaleDenom: props.config?.layoutScaleDenom ?? 5000,
    layoutMarginTop: props.config?.layoutMarginTop ?? 25,
    layoutMarginLeft: props.config?.layoutMarginLeft ?? 10,
    layoutMarginRight: props.config?.layoutMarginRight ?? 10,
    layoutMarginBottom: props.config?.layoutMarginBottom ?? 10,
    layoutFitToPlate: props.config?.layoutFitToPlate !== false
  })

  const setOpt = <K extends keyof Config>(key: K, value: Config[K]) => {
    setOptions((prev) => ({ ...prev, [key]: value }))
  }

  const setAdminLevel = (level: AdminLevelKey, patch: Partial<AdminLevelWallConfig>) => {
    setOptions((prev) => ({
      ...prev,
      adminLevels: {
        ...prev.adminLevels,
        [level]: {
          ...prev.adminLevels[level],
          ...patch
        }
      }
    }))
  }

  const setClassHeight = (
    key: 'disasterPolygonClassHeights' | 'disasterPolylineClassHeights' | 'disasterPointClassHeights',
    classValue: string,
    height: number
  ) => {
    setOptions((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? {}), [classValue]: height }
    }))
  }

  const removeClassHeight = (
    key: 'disasterPolygonClassHeights' | 'disasterPolylineClassHeights' | 'disasterPointClassHeights',
    classValue: string
  ) => {
    setOptions((prev) => {
      const next = { ...(prev[key] ?? {}) }
      delete next[classValue]
      return { ...prev, [key]: next }
    })
  }

  const detectClassValues = async (layerId: string, field: string): Promise<string[]> => {
    const view = viewRef.current
    if (!view || !rectangle || !field) return []
    const layer = view.map.allLayers.find((l: any) => l.id === layerId)
    if (!layer || typeof (layer as any).queryFeatures !== 'function') return []
    try {
      const layerView = await view.whenLayerView(layer)
      const query = new Query({
        geometry: rectangle,
        spatialRelationship: 'intersects',
        returnGeometry: false,
        outFields: [field]
      })
      const result = await layerView.queryFeatures(query)
      const values = new Set<string>()
      for (const feature of result.features) {
        const v = (feature as any).attributes?.[field]
        if (v !== null && v !== undefined && String(v).trim() !== '') values.add(String(v))
      }
      return [...values].sort()
    } catch (e) {
      console.warn('[stl-export] detect class values failed', e)
      return []
    }
  }

  const detectAndAddClasses = async (
    key: 'disasterPolygonClassHeights' | 'disasterPolylineClassHeights' | 'disasterPointClassHeights',
    layerId: string,
    field: string,
    defaultHeight: number
  ): Promise<string[]> => {
    const vals = await detectClassValues(layerId, field)
    if (vals.length > 0) {
      setOptions((prev) => {
        const cur = { ...(prev[key] ?? {}) }
        let changed = false
        for (const v of vals) {
          if (cur[v] === undefined) {
            cur[v] = defaultHeight
            changed = true
          }
        }
        return changed ? { ...prev, [key]: cur } : prev
      })
    }
    return vals
  }

  const toggleLayerId = (id: string) => {
    setSelectedLayerIds((prev) => {
      if (prev.indexOf(LAYER_SELECT_NONE) !== -1) {
        return [id]
      }
      const allIds = layerList.map((l) => l.id).filter((x) => x)
      if (prev.length === 0) {
        return allIds.filter((x) => x !== id)
      }
      if (prev.indexOf(id) !== -1) return prev.filter((x) => x !== id)
      return [...prev, id]
    })
  }

  const viewRef = useRef<SceneView | null>(null)
  const drawModeRef = useRef(false)
  const drawingRef = useRef<DrawState | null>(null)
  const screenRectRef = useRef<{ a: { x: number, y: number }, b: { x: number, y: number } } | null>(null)
  const rectRef = useRef<Polygon | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const handlesRef = useRef<Array<{ remove: () => void }>>([])

  const clearViewHandlers = () => {
    handlesRef.current.forEach((h) => h.remove())
    handlesRef.current = []
  }

  const removeOverlay = () => {
    if (overlayRef.current) {
      try {
        overlayRef.current.parentElement?.removeChild(overlayRef.current)
      } catch (e) {
        console.warn('[stl-export] overlay removal failed', e)
      }
      overlayRef.current = null
    }
  }

  const renderOverlayScreen = (a: { x: number, y: number } | null, b: { x: number, y: number } | null) => {
    const overlay = overlayRef.current
    if (!overlay) return
    try {
      if (!a || !b) {
        overlay.style.display = 'none'
        return
      }
      const xmin = Math.min(a.x, b.x)
      const xmax = Math.max(a.x, b.x)
      const ymin = Math.min(a.y, b.y)
      const ymax = Math.max(a.y, b.y)
      overlay.style.left = xmin + 'px'
      overlay.style.top = ymin + 'px'
      overlay.style.width = (xmax - xmin) + 'px'
      overlay.style.height = (ymax - ymin) + 'px'
      overlay.style.display = 'block'
    } catch (e) {
      console.warn('[stl-export] renderOverlayScreen error', e)
    }
  }

  const setViewCursor = (cursor: string) => {
    const view = viewRef.current
    if (view) {
      const container = view.container as HTMLElement | null
      if (container) container.style.cursor = cursor
    }
  }

  const setNavigationEnabled = (enabled: boolean) => {
    const view = viewRef.current
    if (view) {
      try {
        view.navigation.enabled = enabled
      } catch (e) {
        console.warn('[stl-export] navigation set failed', e)
      }
    }
  }

  const cancelDraw = () => {
    drawingRef.current = null
    drawModeRef.current = false
    screenRectRef.current = null
    setDrawMode(false)
    setViewCursor('')
    setNavigationEnabled(true)
    renderOverlayScreen(null, null)
    setStatus('Drawing cancelled. Click "Draw rectangle" to try again.')
  }

  const startDrawing = () => {
    const view = viewRef.current
    if (!view) return
    setRectangle(null)
    rectRef.current = null
    drawingRef.current = null
    screenRectRef.current = null
    drawModeRef.current = true
    setDrawMode(true)
    setViewCursor('crosshair')
    setNavigationEnabled(false)
    setStatus('Drag on the scene to draw a rectangle. Right-click or press Esc to cancel.')
  }

  useEffect(() => {
    return () => {
      clearViewHandlers()
      removeOverlay()
      setNavigationEnabled(true)
    }
  }, [])

  const collectEligibleLayers = (view: SceneView) => {
    const list: Array<{ id: string, title: string, type: string }> = []
    const sceneLayerListAcc: Array<{ id: string, title: string }> = []
    const rasterLayerListAcc: Array<{ id: string, title: string }> = []
    const lineLayerListAcc: Array<{ id: string, title: string }> = []
    const polylineLayerListAcc: Array<{ id: string, title: string, fields: string[] }> = []
    const polygonLayerListAcc: Array<{ id: string, title: string, fields: string[] }> = []
    const pointLayerListAcc: Array<{ id: string, title: string, fields: string[] }> = []
    const divisionPolygonListAcc: Array<{ id: string, title: string }> = []
    const riverPolygonListAcc: Array<{ id: string, title: string }> = []
    const visit = (layer: any) => {
      const lyr = layer as any
      const eligible = lyr.type === 'scene' || lyr.type === 'building' || lyr.type === 'point-cloud' ||
        typeof lyr.queryFeatures === 'function' || typeof lyr.getSamples === 'function'
      if (eligible && lyr.id) {
        list.push({ id: (lyr.id as string) || '', title: (lyr.title as string) || lyr.type, type: lyr.type })
      }
      if (lyr.id && (lyr.type === 'scene' || lyr.type === 'building' || lyr.type === 'point-cloud')) {
        sceneLayerListAcc.push({ id: lyr.id, title: (lyr.title as string) || lyr.type })
      }
      const isRasterLayer = lyr.id && (
        typeof lyr.getSamples === 'function' ||
        typeof lyr.queryRasterCellValues === 'function' ||
        lyr.type === 'raster' ||
        lyr.type === 'imagery' ||
        lyr.type === 'imagery-tile' ||
        lyr.type === 'raster-data-layer' ||
        lyr.layerType === 'raster' ||
        lyr.layerType === 'imagery' ||
        lyr.layerType === 'raster-data-layer' ||
        /imagery|raster/i.test(lyr.declaredClass || '') ||
        lyr.isRaster === true ||
        /imagery|raster/i.test(lyr.capabilities?.samples?.supports || '') ||
        /ImageServer/i.test(lyr.url || '') ||
        /imagery|raster/i.test(lyr.title || '')
      )
      if (isRasterLayer && !rasterLayerListAcc.some((l) => l.id === lyr.id)) {
        rasterLayerListAcc.push({ id: lyr.id, title: (lyr.title as string) || lyr.type })
      }
      const gType = (lyr.geometryType || '').toLowerCase()
      const fields = (lyr.fields && lyr.fields.length ? lyr.fields.map((f: any) => f.name as string) : [])
        .filter((n: string) => !!n)
      if ((gType === 'polyline' || gType === 'polygon') && typeof lyr.queryFeatures === 'function' && lyr.id) {
        lineLayerListAcc.push({ id: lyr.id, title: (lyr.title as string) || lyr.type })
        if (gType === 'polyline') {
          polylineLayerListAcc.push({ id: lyr.id, title: (lyr.title as string) || lyr.type, fields })
        } else {
          polygonLayerListAcc.push({ id: lyr.id, title: (lyr.title as string) || lyr.type, fields })
          const title = (lyr.title as string) || lyr.type
          const isRiver = /sungai|river|water/i.test(title)
          if (isRiver) {
            riverPolygonListAcc.push({ id: lyr.id, title })
          } else {
            divisionPolygonListAcc.push({ id: lyr.id, title })
          }
        }
      }
      if ((gType === 'point' || gType === 'multipoint') && typeof lyr.queryFeatures === 'function' && lyr.id) {
        pointLayerListAcc.push({ id: lyr.id, title: (lyr.title as string) || lyr.type, fields })
      }
      // Recurse into sublayers (MapImageLayer / GroupLayer / KMLLayer sublayers)
      // so raster-data-layer entries are found even when not in map.allLayers.
      const subs = (lyr as any).sublayers
      if (subs && typeof subs.forEach === 'function') {
        subs.forEach(visit)
      } else if (subs && Array.isArray(subs)) {
        subs.forEach(visit)
      }
    }
    for (const layer of view.map.allLayers) {
      visit(layer)
    }
    setLayerList(list)
    setSceneLayerList(sceneLayerListAcc)
    setRasterLayerList(rasterLayerListAcc)
    setLineLayerList(lineLayerListAcc)
    setPolylineLayerList(polylineLayerListAcc)
    setPolygonLayerList(polygonLayerListAcc)
    setPointLayerList(pointLayerListAcc)
    setDivisionPolygonList(divisionPolygonListAcc)
    setRiverPolygonList(riverPolygonListAcc)
    setSelectedLayerIds((prev) => {
      const ids = list.map((l) => l.id)
      if (prev.length === 0) return []
      if (prev.indexOf(LAYER_SELECT_NONE) !== -1) return [LAYER_SELECT_NONE]
      return prev.filter((id) => ids.indexOf(id) !== -1)
    })
    return { list, rasterLayerListAcc }
  }

  const layerCollectTimer = useRef<number | null>(null)

  const scheduleCollect = (view: SceneView, delay = 2500) => {
    if (layerCollectTimer.current !== null) {
      window.clearTimeout(layerCollectTimer.current)
    }
    layerCollectTimer.current = window.setTimeout(() => {
      layerCollectTimer.current = null
      try {
        collectEligibleLayers(view)
      } catch (e) {
        console.warn('[stl-export] delayed layer collect failed', e)
      }
    }, delay)
  }

  const activeViewChangeHandler = (activeJmv: JimuMapView) => {
    clearViewHandlers()
    removeOverlay()
    setNavigationEnabled(true)
    setRectangle(null)
    rectRef.current = null
    drawingRef.current = null
    screenRectRef.current = null
    drawModeRef.current = false
    setDrawMode(false)
    setViewCursor('')

    if (!activeJmv) {
      setIsScene(false)
      viewRef.current = null
      return
    }

    if (activeJmv.view.type === '3d') {
      const view = activeJmv.view as SceneView
      viewRef.current = view
      setIsScene(true)
      collectEligibleLayers(view)

      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:absolute;pointer-events:none;z-index:1000;border:3px solid #00ffff;background:rgba(0,255,255,0.3);display:none;'
      view.container.appendChild(overlay)
      overlayRef.current = overlay

      const altitude = view.camera?.position?.z ?? 0
      const tip = altitude > 1000000
        ? ' Zoom in closer to your area of interest first.'
        : ''
      setStatus('You can pan and tilt the scene normally. Click "Draw rectangle" and drag to choose the export area.' + tip)

      const container = view.container as HTMLElement
      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative'
      }

      const screenPoint = (ev: PointerEvent) => {
        const rect = container.getBoundingClientRect()
        return { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
      }

      const handleDown = (event: PointerEvent) => {
        try {
          if (!drawModeRef.current) return
          if (event.button === 2) {
            cancelDraw()
            return
          }
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          try {
            container.setPointerCapture(event.pointerId)
          } catch (e) {
            console.warn('[stl-export] setPointerCapture failed', e)
          }
          const pt = screenPoint(event)
          drawingRef.current = { start: pt, last: pt }
          screenRectRef.current = { a: pt, b: pt }
          renderOverlayScreen(pt, pt)
          setStatus('Drawing started - drag to size the rectangle.')
        } catch (e) {
          console.error('[stl-export] pointer-down error', e)
        }
      }

      const handleMove = (event: PointerEvent) => {
        try {
          if (!drawingRef.current) return
          event.preventDefault()
          event.stopPropagation()
          const pt = screenPoint(event)
          drawingRef.current.last = pt
          screenRectRef.current = { a: drawingRef.current.start, b: pt }
          renderOverlayScreen(drawingRef.current.start, pt)
        } catch (e) {
          console.error('[stl-export] pointer-move error', e)
        }
      }

      const handleUp = (event: PointerEvent) => {
        try {
          console.log('[stl-export] pointer-up fired, drawingRef =', !!drawingRef.current)
          if (!drawingRef.current) return
          const { start } = drawingRef.current
          drawingRef.current = null
          event.preventDefault()
          event.stopPropagation()
          setViewCursor('')

          const end = screenPoint(event)
          let startMap: any = null
          let endMap: any = null
          try {
            startMap = view.toMap({ x: start.x, y: start.y } as any)
            endMap = view.toMap({ x: end.x, y: end.y } as any)
          } catch (e) {
            console.warn('[stl-export] toMap threw', e)
          }
          if (!startMap || !endMap) {
            drawModeRef.current = false
            setDrawMode(false)
            setNavigationEnabled(true)
            screenRectRef.current = null
            renderOverlayScreen(null, null)
            setStatus(`Could not map the pointer to the ground (toMap ${startMap ? 'ok' : 'null'} / ${endMap ? 'ok' : 'null'}). Try zooming in.`)
            return
          }

          const polygon = buildRectangleFromScreen(view, start, end, view.spatialReference)
          const ext = polygon.extent
          if (ext.width <= 0 || ext.height <= 0) {
            drawModeRef.current = false
            setDrawMode(false)
            setNavigationEnabled(true)
            screenRectRef.current = null
            renderOverlayScreen(null, null)
            setStatus('Rectangle too small. Click "Draw rectangle" and try again.')
            return
          }

          rectRef.current = polygon
          screenRectRef.current = { a: start, b: end }
          renderOverlayScreen(start, end)
          drawModeRef.current = false
          setDrawMode(false)
          setNavigationEnabled(true)
          setRectangle(polygon)
          setStatus('Area selected. Click "Export STL".')
        } catch (e) {
          console.error('[stl-export] pointer-up error', e)
          setStatus(`Pointer up error: ${(e as Error).message}`)
        }
      }

      const handleKeyDown = (event: any) => {
        try {
          if (drawModeRef.current && (event.key === 'Escape' || event.key === 'Esc')) {
            cancelDraw()
          }
        } catch (e) {
          console.error('[stl-export] key-down error', e)
        }
      }

      const handleFrame = () => {
        try {
          const s = screenRectRef.current
          if (s) renderOverlayScreen(s.a, s.b)
        } catch (e) {
          console.error('[stl-export] frame error', e)
        }
      }

      container.addEventListener('pointerdown', handleDown, true)
      container.addEventListener('pointermove', handleMove, true)
      container.addEventListener('pointerup', handleUp, true)
      container.addEventListener('pointercancel', handleUp, true)
      handlesRef.current = [
        view.on('key-down', handleKeyDown),
        view.on('frame', handleFrame),
        view.map.on('layers-add', () => { collectEligibleLayers(view); scheduleCollect(view) }),
        view.map.on('layers-remove', () => { collectEligibleLayers(view); scheduleCollect(view) }),
        view.map.on('layers-change', () => { collectEligibleLayers(view); scheduleCollect(view) }),
        { remove: () => container.removeEventListener('pointerdown', handleDown, true) },
        { remove: () => container.removeEventListener('pointermove', handleMove, true) },
        { remove: () => container.removeEventListener('pointerup', handleUp, true) },
        { remove: () => container.removeEventListener('pointercancel', handleUp, true) }
      ]

      for (const layer of view.map.allLayers) {
        const lyr = layer as any
        if (typeof lyr.on !== 'function') continue
        const h = lyr.on('load', () => {
          collectEligibleLayers(view)
          scheduleCollect(view)
        })
        if (h && typeof h.remove === 'function') {
          handlesRef.current.push(h)
        }
      }
      scheduleCollect(view, 1500)
    } else {
      setIsScene(false)
      viewRef.current = null
      setStatus('This widget requires a 3D Scene View. Select a 3D map in the widget settings.')
    }
  }

  const zoomToExtentForDetail = async (view: SceneView, extent: any): Promise<void> => {
    const saved = view.camera.clone()
    const center = extent.center
    const fov = view.camera.fov || 55
    const diag = Math.max(extent.width, extent.height)
    const altitude = (diag / 2) / Math.tan((fov / 2) * Math.PI / 180) * 1.2
    const cam = saved.clone()
    cam.position = new Point({
      x: center.x,
      y: center.y,
      z: altitude,
      spatialReference: view.spatialReference
    })
    cam.heading = 0
    cam.tilt = 0
    await view.goTo(cam)

    const layerViews: any[] = []
    for (const layer of view.map.allLayers) {
      const lyr = layer as any
      if (lyr.type !== 'scene' && lyr.type !== 'building' && lyr.type !== 'point-cloud') continue
      try {
        const lv = await view.whenLayerView(lyr)
        layerViews.push(lv)
      } catch (e) {
        console.warn('[stl-export] no layer view for', lyr.title, e)
      }
    }

    const wait = (lv: any) => Promise.race([
      reactiveUtils.whenOnce(() => !lv.updating),
      new Promise((r) => setTimeout(r, 6000))
    ])
    await Promise.all(layerViews.map(wait))
    await new Promise((r) => setTimeout(r, 800))
  }

  const runExport = async (): Promise<Awaited<ReturnType<typeof exportScene>>> => {
    if (!rectangle || !viewRef.current) throw new Error('No AOI drawn yet.')
    const view = viewRef.current
    const savedCamera = view.camera.clone()
    try {
      const config: Config = {
        includeTerrain: options.includeTerrain,
        includeLayers: options.includeLayers,
        extrudeBase: options.extrudeBase,
        extrusionDepth: options.extrusionDepth,
        includePolygons: options.includePolygons,
        polygonWallHeight: options.polygonWallHeight,
        polygonWallHalfWidth: options.polygonWallHalfWidth,
        adminLevels: options.adminLevels,
        includeLabels: options.includeLabels,
        includeLayerLabels: options.includeLayerLabels,
        labelDomeHeight: options.labelDomeHeight,
        labelFontSize: options.labelFontSize,
        labelEdgeGap: options.labelEdgeGap,
        includeFurnitureLabels: options.includeFurnitureLabels,
        furnitureLabelDomeHeight: options.furnitureLabelDomeHeight,
        furnitureLabelFontSize: options.furnitureLabelFontSize,
        furnitureLabelEdgeGap: options.furnitureLabelEdgeGap,
        includeRaster: options.includeRaster,
        hazardLayerId: options.hazardLayerId,
        disasterPolygonLayerId: options.disasterPolygonLayerId,
        disasterPolylineLayerId: options.disasterPolylineLayerId,
        disasterPointLayerId: options.disasterPointLayerId,
        disasterPolygonHeight: options.disasterPolygonHeight,
        disasterWallHeight: options.disasterWallHeight,
        disasterWallHalfWidth: options.disasterWallHalfWidth,
        disasterPointRadius: options.disasterPointRadius,
        disasterPointHeight: options.disasterPointHeight,
        disasterPolygonClassField: options.disasterPolygonClassField,
        disasterPolygonClassHeights: options.disasterPolygonClassHeights,
        disasterPolylineClassField: options.disasterPolylineClassField,
        disasterPolylineClassHeights: options.disasterPolylineClassHeights,
        disasterPointClassField: options.disasterPointClassField,
        disasterPointClassHeights: options.disasterPointClassHeights,
        rasterBandHeights: options.rasterBandHeights,
        rasterBands: options.rasterBands,
        rasterGrid: options.rasterGrid,
        rasterMaxHeight: options.rasterMaxHeight,
        baseZ0: options.baseZ0,
        includeLines: options.includeLines,
        includeRoads: options.includeRoads,
        includeRivers: options.includeRivers,
        roadsWallHeight: options.roadsWallHeight,
        roadsWallHalfWidth: options.roadsWallHalfWidth,
        roadsPolygonHeight: options.roadsPolygonHeight,
        riversWallHeight: options.riversWallHeight,
        riversWallHalfWidth: options.riversWallHalfWidth,
        riversPolygonHeight: options.riversPolygonHeight,
        roadsLayerId: options.roadsLayerId,
        roadsPolygonLayerId: options.roadsPolygonLayerId,
        riversLayerId: options.riversLayerId,
        riversPolygonLayerId: options.riversPolygonLayerId,
        simplifyMeshes: options.simplifyMeshes,
        simplifyCell: options.simplifyCell,
        hazardDots: options.hazardDots,
        hazardDotsPerCell: options.hazardDotsPerCell,
        hazardDotRadius: options.hazardDotRadius,
        hazardDotHeight: options.hazardDotHeight,
        selectedLayerIds: selectedLayerIds,
        flatBase: options.flatBase,
        flatBaseThickness: options.flatBaseThickness,
        includeMargin: options.includeMargin,
        marginThickness: options.marginThickness,
        marginTop: options.marginTop,
        marginLeft: options.marginLeft,
        marginRight: options.marginRight,
        marginBottom: options.marginBottom,
        includeTitle: options.includeTitle,
        mapTitle: options.mapTitle,
        includeScaleBar: options.includeScaleBar,
        scaleBarLength: options.scaleBarLength,
        scaleBarWidth: options.scaleBarWidth,
        scaleBarHeight: options.scaleBarHeight,
        includePrintScale: options.includePrintScale,
        includeNorthArrow: options.includeNorthArrow,
        northArrowLength: options.northArrowLength,
        northArrowWidth: options.northArrowWidth,
        northArrowHeight: options.northArrowHeight,
        northArrowGap: options.northArrowGap,
        useLayout: options.useLayout,
        layoutPlatePreset: options.layoutPlatePreset,
        layoutPlateWidth: options.layoutPlateWidth,
        layoutPlateHeight: options.layoutPlateHeight,
        layoutScaleDenom: options.layoutScaleDenom,
        layoutMarginTop: options.layoutMarginTop,
        layoutMarginLeft: options.layoutMarginLeft,
        layoutMarginRight: options.layoutMarginRight,
        layoutMarginBottom: options.layoutMarginBottom,
        layoutFitToPlate: options.layoutFitToPlate
      }
      if (config.includeLayers) {
        setStatus('Zooming in to load building details...')
        await zoomToExtentForDetail(view, rectangle.extent)
      }
      setStatus('Building 3D model... this may take a moment.')
      const result = await exportScene(view, rectangle, config)
      return result
    } finally {
      view.goTo(savedCamera).catch(() => undefined)
    }
  }

  const handleBuildPreview = async () => {
    if (!rectangle) return
    setExporting(true)
    setPreviewError(null)
    setStatus('Building 3D preview... this may take a moment.')
    try {
      const result = await runExport()
      setPreviewGeom(result.preview)
      setPreviewBlob(result.blob)
      setPreviewTriangles(result.triangleCount)
      setPreviewLayers(result.layerCount)
      setPart(5)
      setStatus(`Preview ready: ${result.triangleCount.toLocaleString()} triangles across ${result.layerCount} mesh(es).`)
    } catch (e) {
      console.error('[stl-export] Preview build failed', e)
      setPreviewError((e as Error).message)
      setStatus(`Preview failed: ${(e as Error).message}`)
    } finally {
      setExporting(false)
    }
  }

  const handleExport = async () => {
    if (!rectangle) return
    setExporting(true)
    setPreviewError(null)
    setStatus('Exporting... this may take a moment.')
    try {
      const result = await runExport()
      setPreviewGeom(result.preview)
      setPreviewBlob(result.blob)
      setPreviewTriangles(result.triangleCount)
      setPreviewLayers(result.layerCount)
      downloadBlob(result.blob, `stl-export-${Date.now()}.stl`)
      setStatus(`Done: ${result.triangleCount.toLocaleString()} triangles across ${result.layerCount} mesh(es).`)
    } catch (e) {
      console.error('[stl-export] Export failed', e)
      setStatus(`Export failed: ${(e as Error).message}`)
    } finally {
      setExporting(false)
    }
  }

  const handleDownloadPreview = () => {
    if (!previewBlob) return
    downloadBlob(previewBlob, `stl-export-${Date.now()}.stl`)
  }

  // Compute the 2D division outlines + Braille label positions for the static
  // layout preview. Re-run when the AOI or label-related options change.
  useEffect(() => {
    let cancelled = false
    const view = viewRef.current
    if (!view || !rectangle) {
      setLayoutPreviewData(null)
      return
    }
    const t = window.setTimeout(async () => {
      try {
        const data = await computeLayoutPreviewData(view, rectangle, { ...options, selectedLayerIds })
        if (!cancelled) setLayoutPreviewData(data)
      } catch (e) {
        console.warn('[stl-export] layout preview data failed', e)
        if (!cancelled) setLayoutPreviewData(null)
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [rectangle, options.includeLabels, options.includeLayerLabels, options.includeFurnitureLabels, options.labelDomeHeight, options.labelFontSize, options.labelEdgeGap, options.furnitureLabelDomeHeight, options.furnitureLabelFontSize, options.furnitureLabelEdgeGap, options.adminLevels, selectedLayerIds])

  return <div className="widget-stl-export jimu-widget p-2">
    {props.useMapWidgetIds && props.useMapWidgetIds.length === 1 && (
      <JimuMapViewComponent useMapWidgetId={props.useMapWidgetIds?.[0]} onActiveViewChange={activeViewChangeHandler} />
    )}

    {isScene && (
      <div className="mt-2" style={{ border: '1px solid #ccc', padding: '8px', borderRadius: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 6 }}>Export wizard</div>

        {/* Step tabs */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 8 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setPart(n)}
              style={{
                flex: 1,
                padding: '5px 2px',
                fontSize: 11,
                border: '1px solid #ccc',
                borderRadius: 4,
                background: part === n ? '#2b6cb0' : '#fff',
                color: part === n ? '#fff' : '#333',
                cursor: 'pointer'
              }}
            >
              {n}. {['AOI', 'Layers', 'Map Components', 'Layout', 'Export'][n - 1]}
            </button>
          ))}
        </div>

        {/* Persistent static layout preview (visible in all parts) */}
        {rectangle && (
          <div style={{ marginBottom: 8, padding: '6px', border: '1px solid #eee', borderRadius: 4, background: '#fcfcfc' }}>
            <div style={{ fontSize: 11, fontWeight: 'bold', marginBottom: 3 }}>Static Layout Preview</div>
            <LayoutPreview
              extent={rectangle?.extent ?? null}
              options={options}
              zoom={pvZoom}
              pan={pvPan}
              previewData={layoutPreviewData}
              onZoom={(z) => setPvZoom(z)}
              onPan={(p) => setPvPan(p)}
            />
          </div>
        )}

        <div style={{ fontSize: 12, maxHeight: 'calc(100vh - 300px)', overflowY: 'auto', paddingRight: 4 }}>
          {part === 1 && (
            <div>
              <div style={{ marginBottom: 8, padding: '4px 0', borderBottom: '1px dashed #ddd' }}>
                <div style={{ fontSize: 12, fontWeight: 'bold', marginBottom: 4 }}>Part 1 · Define AOI (Draw Rectangle)</div>
                <div style={{ fontSize: 11, color: '#666' }}>Click "Draw rectangle", then drag on the scene to set the export area. Right-click or Esc to cancel.</div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <button
                  className="btn btn-primary"
                  disabled={exporting}
                  onClick={drawMode ? cancelDraw : startDrawing}
                >
                  {drawMode ? 'Cancel drawing' : 'Draw rectangle'}
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#666' }}>
                {rectangle
                  ? <>AOI set: {rectangle.extent.width.toFixed(1)} × {rectangle.extent.height.toFixed(1)} m</>
                  : 'No AOI drawn yet.'}
              </div>
            </div>
          )}

          {part === 2 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 'bold', marginBottom: 4 }}>Part 2 · Layer settings</div>
              <div style={{ marginBottom: 8, padding: '4px 0', borderBottom: '1px dashed #ddd' }}>
                <label style={{ fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedLayerIds.length === 0}
                    onChange={() => {
                      if (selectedLayerIds.length === 0) {
                        setSelectedLayerIds([LAYER_SELECT_NONE])
                      } else {
                        setSelectedLayerIds([])
                      }
                    }}
                    style={{ marginRight: 4 }}
                  />
                  Export all eligible layers
                </label>
              </div>

              <OptionSection title="Scene layers (buildings)" checked={options.includeLayers} onToggle={(v) => setOpt('includeLayers', v)}>
                <LayerCheckboxes layers={sceneLayerList} selected={selectedLayerIds} onToggle={toggleLayerId} />
                <OptionSwitch label="Simplify building meshes" checked={options.simplifyMeshes} onChanged={(v) => setOpt('simplifyMeshes', v)} />
                {options.simplifyMeshes && (
                  <OptionNum label="Simplify cell (mm)" value={options.simplifyCell} min={0.05} step={0.05} onChanged={(v) => setOpt('simplifyCell', v ?? 0.1)} />
                )}
              </OptionSection>

              <OptionSection title="Administrative divisions (polygon)" checked={options.includePolygons} onToggle={(v) => setOpt('includePolygons', v)}>
                <OptionNum label="Wall height (mm)" value={options.polygonWallHeight} min={0} step={0.1} onChanged={(v) => setOpt('polygonWallHeight', v ?? 0)} />
                <OptionNum label="Wall half-width (mm)" value={options.polygonWallHalfWidth} min={0} step={0.05} onChanged={(v) => setOpt('polygonWallHalfWidth', v ?? 0)} />
                <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Dash-dot block parameters per level</div>
                <AdminLevelFields label="Village (dash-4 dots)" cfg={options.adminLevels.village} layerOptions={divisionPolygonList} onChange={(p) => setAdminLevel('village', p)} />
                <AdminLevelFields label="District (dash-3 dots)" cfg={options.adminLevels.district} layerOptions={divisionPolygonList} onChange={(p) => setAdminLevel('district', p)} />
                <AdminLevelFields label="City/Regency (dash-2 dots)" cfg={options.adminLevels.city} layerOptions={divisionPolygonList} onChange={(p) => setAdminLevel('city', p)} />
                <AdminLevelFields label="Province (dash-1 dot)" cfg={options.adminLevels.province} layerOptions={divisionPolygonList} onChange={(p) => setAdminLevel('province', p)} />
                <AdminLevelFields label="Country (dash-dash)" cfg={options.adminLevels.country} layerOptions={divisionPolygonList} onChange={(p) => setAdminLevel('country', p)} />
              </OptionSection>

              <OptionSection title="Roads" checked={options.includeRoads} onToggle={(v) => setOpt('includeRoads', v)}>
                {polylineLayerList.length > 0 && (
                  <OptionSelect label="Roads layer (polyline)" value={options.roadsLayerId} options={polylineLayerList} onChanged={(v) => setOpt('roadsLayerId', v)} />
                )}
                {polygonLayerList.length > 0 && (
                  <OptionSelect label="Roads layer (polygon)" value={options.roadsPolygonLayerId} options={polygonLayerList} onChanged={(v) => setOpt('roadsPolygonLayerId', v)} />
                )}
                {options.roadsLayerId && options.roadsLayerId !== LINE_LAYER_NONE ? (
                  <>
                    <OptionNum label="Road wall height (mm)" value={options.roadsWallHeight} min={0} step={0.1} onChanged={(v) => setOpt('roadsWallHeight', v ?? 0)} />
                    <OptionNum label="Road wall half-width (mm)" value={options.roadsWallHalfWidth} min={0} step={0.05} onChanged={(v) => setOpt('roadsWallHalfWidth', v ?? 0)} />
                  </>
                ) : null}
                {options.roadsPolygonLayerId && options.roadsPolygonLayerId !== LINE_LAYER_NONE && (
                  <OptionNum label="Road polygon height (mm)" value={options.roadsPolygonHeight} min={0} step={0.1} onChanged={(v) => setOpt('roadsPolygonHeight', v ?? 0)} />
                )}
              </OptionSection>

              <OptionSection title="Rivers" checked={options.includeRivers} onToggle={(v) => setOpt('includeRivers', v)}>
                {polylineLayerList.length > 0 && (
                  <OptionSelect label="Rivers layer (polyline)" value={options.riversLayerId} options={polylineLayerList} onChanged={(v) => setOpt('riversLayerId', v)} />
                )}
                {riverPolygonList.length > 0 && (
                  <OptionSelect label="Rivers layer (polygon)" value={options.riversPolygonLayerId} options={riverPolygonList} onChanged={(v) => setOpt('riversPolygonLayerId', v)} />
                )}
                {options.riversLayerId && options.riversLayerId !== LINE_LAYER_NONE ? (
                  <>
                    <OptionNum label="River wall height (mm)" value={options.riversWallHeight} min={0} step={0.1} onChanged={(v) => setOpt('riversWallHeight', v ?? 0)} />
                    <OptionNum label="River wall half-width (mm)" value={options.riversWallHalfWidth} min={0} step={0.05} onChanged={(v) => setOpt('riversWallHalfWidth', v ?? 0)} />
                  </>
                ) : null}
                {options.riversPolygonLayerId && options.riversPolygonLayerId !== LINE_LAYER_NONE && (
                  <OptionNum label="River polygon height (mm)" value={options.riversPolygonHeight} min={0} step={0.1} onChanged={(v) => setOpt('riversPolygonHeight', v ?? 0)} />
                )}
              </OptionSection>

              <OptionSection title="Disaster related" checked={options.includeRaster} onToggle={(v) => setOpt('includeRaster', v)}>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Add up to one layer of each feature type. Parameters depend on the layer type.</div>
                <OptionSelect label="Disaster layer (raster)" value={options.hazardLayerId} options={rasterLayerList} onChanged={(v) => setOpt('hazardLayerId', v)} />
                {rasterLayerList.length === 0 && (
                  <div style={{ fontSize: 11, color: '#c44', marginBottom: 4 }}>
                    No raster dataset layers found in the scene — add one (e.g. tsunami hazard, flood zone, earthquake risk) to enable the hazard bands.
                  </div>
                )}
                {options.hazardLayerId && options.hazardLayerId !== LINE_LAYER_NONE && (
                  <>
                    <OptionNum label="Raster bands" value={options.rasterBands} min={1} max={20} step={1} onChanged={(v) => {
                      const nb = Math.max(1, Math.min(20, v ?? 1))
                      setOpt('rasterBands', nb)
                      setOptions((prev) => {
                        const cur = prev.rasterBandHeights ?? []
                        const next = new Array<number>(nb)
                        for (let b = 0; b < nb; b++) next[b] = cur[b] ?? 0
                        return { ...prev, rasterBandHeights: next }
                      })
                    }} />
                    <OptionNum label="Sampling grid" value={options.rasterGrid} min={4} max={120} step={4} onChanged={(v) => setOpt('rasterGrid', v ?? 4)} />
                    <OptionNum label="Top band height (mm)" value={options.rasterMaxHeight} min={0} step={0.1} onChanged={(v) => setOpt('rasterMaxHeight', v ?? 0)} />
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 2 }}>Per-band heights (mm) — leave 0 to scale linearly from the top height</div>
                    {(options.rasterBandHeights ?? []).map((h, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                        <span style={{ fontSize: 12 }}>Band {idx + 1} (low→high)</span>
                        <NumericInput
                          value={h}
                          min={0}
                          step={0.1}
                          size="sm"
                          onChange={(v) => {
                            const val = v ?? 0
                            setOptions((prev) => {
                              const cur = [...(prev.rasterBandHeights ?? [])]
                              while (cur.length <= idx) cur.push(0)
                              cur[idx] = val
                              return { ...prev, rasterBandHeights: cur }
                            })
                          }}
                          style={{ width: 70 }}
                        />
                      </div>
                    ))}
                    <OptionSwitch label="Hazard texture dots" checked={options.hazardDots} onChanged={(v) => setOpt('hazardDots', v)} />
                    {options.hazardDots && (
                      <>
                        <OptionNum label="Dots per cell" value={options.hazardDotsPerCell} min={1} max={6} step={1} onChanged={(v) => setOpt('hazardDotsPerCell', v ?? 1)} />
                        <OptionNum label="Dot radius (mm)" value={options.hazardDotRadius} min={0} step={0.05} onChanged={(v) => setOpt('hazardDotRadius', v ?? 0)} />
                        <OptionNum label="Dot height (mm)" value={options.hazardDotHeight} min={0} step={0.05} onChanged={(v) => setOpt('hazardDotHeight', v ?? 0)} />
                      </>
                    )}
                  </>
                )}

                <OptionSelect label="Disaster layer (polygon)" value={options.disasterPolygonLayerId} options={polygonLayerList} onChanged={(v) => setOpt('disasterPolygonLayerId', v)} />
                {options.disasterPolygonLayerId && options.disasterPolygonLayerId !== LINE_LAYER_NONE && (
                  <>
                    <OptionNum label="Polygon height (mm)" value={options.disasterPolygonHeight} min={0} step={0.1} onChanged={(v) => setOpt('disasterPolygonHeight', v ?? 0)} />
                    <ClassHeightEditor
                      fields={polygonLayerList.find((l) => l.id === options.disasterPolygonLayerId)?.fields ?? []}
                      classField={options.disasterPolygonClassField}
                      heights={options.disasterPolygonClassHeights}
                      onFieldChange={(v) => setOpt('disasterPolygonClassField', v)}
                      onHeightChange={(cv, h) => setClassHeight('disasterPolygonClassHeights', cv, h)}
                      onRemoveHeight={(cv) => removeClassHeight('disasterPolygonClassHeights', cv)}
                      onDetect={() => detectAndAddClasses('disasterPolygonClassHeights', options.disasterPolygonLayerId, options.disasterPolygonClassField, options.disasterPolygonHeight)}
                    />
                  </>
                )}

                <OptionSelect label="Disaster layer (polyline)" value={options.disasterPolylineLayerId} options={polylineLayerList} onChanged={(v) => setOpt('disasterPolylineLayerId', v)} />
                {options.disasterPolylineLayerId && options.disasterPolylineLayerId !== LINE_LAYER_NONE && (
                  <>
                    <OptionNum label="Wall height (mm)" value={options.disasterWallHeight} min={0} step={0.1} onChanged={(v) => setOpt('disasterWallHeight', v ?? 0)} />
                    <OptionNum label="Wall half-width (mm)" value={options.disasterWallHalfWidth} min={0} step={0.05} onChanged={(v) => setOpt('disasterWallHalfWidth', v ?? 0)} />
                    <ClassHeightEditor
                      fields={polylineLayerList.find((l) => l.id === options.disasterPolylineLayerId)?.fields ?? []}
                      classField={options.disasterPolylineClassField}
                      heights={options.disasterPolylineClassHeights}
                      onFieldChange={(v) => setOpt('disasterPolylineClassField', v)}
                      onHeightChange={(cv, h) => setClassHeight('disasterPolylineClassHeights', cv, h)}
                      onRemoveHeight={(cv) => removeClassHeight('disasterPolylineClassHeights', cv)}
                      onDetect={() => detectAndAddClasses('disasterPolylineClassHeights', options.disasterPolylineLayerId, options.disasterPolylineClassField, options.disasterWallHeight)}
                    />
                  </>
                )}

                <OptionSelect label="Disaster layer (point)" value={options.disasterPointLayerId} options={pointLayerList} onChanged={(v) => setOpt('disasterPointLayerId', v)} />
                {options.disasterPointLayerId && options.disasterPointLayerId !== LINE_LAYER_NONE && (
                  <>
                    <OptionNum label="Point radius (mm)" value={options.disasterPointRadius} min={0} step={0.05} onChanged={(v) => setOpt('disasterPointRadius', v ?? 0)} />
                    <OptionNum label="Point height (mm)" value={options.disasterPointHeight} min={0} step={0.05} onChanged={(v) => setOpt('disasterPointHeight', v ?? 0)} />
                    <ClassHeightEditor
                      fields={pointLayerList.find((l) => l.id === options.disasterPointLayerId)?.fields ?? []}
                      classField={options.disasterPointClassField}
                      heights={options.disasterPointClassHeights}
                      onFieldChange={(v) => setOpt('disasterPointClassField', v)}
                      onHeightChange={(cv, h) => setClassHeight('disasterPointClassHeights', cv, h)}
                      onRemoveHeight={(cv) => removeClassHeight('disasterPointClassHeights', cv)}
                      onDetect={() => detectAndAddClasses('disasterPointClassHeights', options.disasterPointLayerId, options.disasterPointClassField, options.disasterPointHeight)}
                    />
                  </>
                )}
              </OptionSection>

              <OptionSection title="Terrain" checked={options.includeTerrain} onToggle={(v) => setOpt('includeTerrain', v)}>
                <OptionSwitch label="Extrude base" checked={options.extrudeBase} onChanged={(v) => setOpt('extrudeBase', v)} />
                {options.extrudeBase && (
                  <OptionNum label="Extrusion depth (mm)" value={options.extrusionDepth} min={0} step={0.5} onChanged={(v) => setOpt('extrusionDepth', v ?? 0)} />
                )}
              </OptionSection>

              <OptionSection title="Flat base plate" checked={options.flatBase} onToggle={(v) => setOpt('flatBase', v)}>
                <OptionNum label="Plate thickness (mm)" value={options.flatBaseThickness} min={0} step={0.1} onChanged={(v) => setOpt('flatBaseThickness', v ?? 0)} />
              </OptionSection>
            </div>
          )}

          {part === 3 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 'bold', marginBottom: 4 }}>Part 3 · Map components</div>

              <OptionSection title="Components" checked={options.includeMargin} onToggle={(v) => setOpt('includeMargin', v)}>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Map furniture placed in the margins around the AOI</div>
                <OptionSwitch label="Map title (Braille)" checked={options.includeTitle} onChanged={(v) => setOpt('includeTitle', v)} />
                {options.includeTitle && (
                  <>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Uses the shared Braille font size &amp; dome height from the Labels section.</div>
                    <OptionText label="Title text" value={options.mapTitle} onChanged={(v) => setOpt('mapTitle', v)} />
                  </>
                )}
                <OptionSwitch label="Scale bar (bottom)" checked={options.includeScaleBar} onChanged={(v) => setOpt('includeScaleBar', v)} />
                {options.includeScaleBar && (
                  <>
                    <OptionNum label="Scale bar length (mm)" value={options.scaleBarLength} min={0} step={1} onChanged={(v) => setOpt('scaleBarLength', v ?? 0)} />
                    <OptionNum label="Scale bar width (mm)" value={options.scaleBarWidth} min={0} step={0.5} onChanged={(v) => setOpt('scaleBarWidth', v ?? 0)} />
                    <OptionNum label="Scale bar height (mm)" value={options.scaleBarHeight} min={0} step={0.5} onChanged={(v) => setOpt('scaleBarHeight', v ?? 0)} />
                  </>
                )}
                <OptionSwitch label="Print scale (1:X, bottom-right)" checked={options.includePrintScale} onChanged={(v) => setOpt('includePrintScale', v)} />
                <OptionSwitch label="North arrow (top-left)" checked={options.includeNorthArrow} onChanged={(v) => setOpt('includeNorthArrow', v)} />
                {options.includeNorthArrow && (
                  <>
                    <OptionNum label="Arrow length (mm)" value={options.northArrowLength} min={0} step={1} onChanged={(v) => setOpt('northArrowLength', v ?? 0)} />
                    <OptionNum label="Arrow width (mm)" value={options.northArrowWidth} min={0} step={0.5} onChanged={(v) => setOpt('northArrowWidth', v ?? 0)} />
                    <OptionNum label="Arrow height (mm)" value={options.northArrowHeight} min={0} step={0.5} onChanged={(v) => setOpt('northArrowHeight', v ?? 0)} />
                    <OptionNum label="Arrow gap (mm)" value={options.northArrowGap} min={0} step={0.5} onChanged={(v) => setOpt('northArrowGap', v ?? 0)} />
                  </>
                )}
                </OptionSection>

              <OptionSection title="Labels" checked={options.includeLabels} onToggle={(v) => setOpt('includeLabels', v)}>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Master switch for all Braille text. Each branch below has its own toggle and parameters.</div>
                <OptionSection title="Layer labels" checked={options.includeLabels && options.includeLayerLabels} onToggle={(v) => setOpt('includeLayerLabels', v)}>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Administrative division names as Braille dots at each polygon centroid.</div>
                  <OptionNum label="Font size (mm)" value={options.labelFontSize} min={0.5} step={0.1} onChanged={(v) => setOpt('labelFontSize', v ?? 0)} />
                  <OptionNum label="Dome height (mm)" value={options.labelDomeHeight} min={0} step={0.1} onChanged={(v) => setOpt('labelDomeHeight', v ?? 0)} />
                  <OptionNum label="Edge gap (mm)" value={options.labelEdgeGap} min={0} step={0.5} onChanged={(v) => setOpt('labelEdgeGap', v ?? 0)} />
                </OptionSection>
                <OptionSection title="Furniture labels" checked={options.includeLabels && options.includeFurnitureLabels} onToggle={(v) => setOpt('includeFurnitureLabels', v)}>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Map furniture Braille text: title, scale bar label and print scale.</div>
                  <OptionNum label="Font size (mm)" value={options.furnitureLabelFontSize} min={0.5} step={0.1} onChanged={(v) => setOpt('furnitureLabelFontSize', v ?? 0)} />
                  <OptionNum label="Dome height (mm)" value={options.furnitureLabelDomeHeight} min={0} step={0.1} onChanged={(v) => setOpt('furnitureLabelDomeHeight', v ?? 0)} />
                  <OptionNum label="Edge gap (mm)" value={options.furnitureLabelEdgeGap} min={0} step={0.5} onChanged={(v) => setOpt('furnitureLabelEdgeGap', v ?? 0)} />
                </OptionSection>
              </OptionSection>
            </div>
          )}

          {part === 4 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 'bold', marginBottom: 4 }}>Part 4 · Layout settings</div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
                Plate size, margins and scale. The Static Layout Preview above updates as you adjust them.
              </div>
              <OptionSection title="Layout view (plate & scale)" checked={options.useLayout} onToggle={(v) => setOpt('useLayout', v)}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                  {(Object.keys(PLATE_PRESETS)).map((key) => (
                    <button
                      key={key}
                      onClick={() => {
                        const preset = PLATE_PRESETS[key]
                        setOpt('layoutPlatePreset', key)
                        if (key !== 'CUSTOM') {
                          setOpt('layoutPlateWidth', preset.width)
                          setOpt('layoutPlateHeight', preset.height)
                        }
                      }}
                      style={{
                        flex: 1,
                        minWidth: 56,
                        padding: '3px 4px',
                        fontSize: 11,
                        border: '1px solid #ccc',
                        borderRadius: 4,
                        background: options.layoutPlatePreset === key ? '#2b6cb0' : '#fff',
                        color: options.layoutPlatePreset === key ? '#fff' : '#333',
                        cursor: 'pointer'
                      }}
                    >
                      {PLATE_PRESETS[key].label}
                    </button>
                  ))}
                </div>
                {options.layoutPlatePreset === 'CUSTOM' && (
                  <>
                    <OptionNum label="Plate width (mm)" value={options.layoutPlateWidth} min={1} step={1} onChanged={(v) => setOpt('layoutPlateWidth', v ?? 1)} />
                    <OptionNum label="Plate height (mm)" value={options.layoutPlateHeight} min={1} step={1} onChanged={(v) => setOpt('layoutPlateHeight', v ?? 1)} />
                  </>
                )}
                <OptionNum label="Print scale (1 : X)" value={options.layoutScaleDenom} min={1} step={100} onChanged={(v) => setOpt('layoutScaleDenom', v ?? 1)} />
                <OptionSwitch label="Fit AOI to plate" checked={options.layoutFitToPlate} onChanged={(v) => setOpt('layoutFitToPlate', v)} />
                <OptionNum label="Top margin (mm)" value={options.layoutMarginTop} min={0} step={1} onChanged={(v) => setOpt('layoutMarginTop', v ?? 0)} />
                <OptionNum label="Left margin (mm)" value={options.layoutMarginLeft} min={0} step={1} onChanged={(v) => setOpt('layoutMarginLeft', v ?? 0)} />
                <OptionNum label="Right margin (mm)" value={options.layoutMarginRight} min={0} step={1} onChanged={(v) => setOpt('layoutMarginRight', v ?? 0)} />
                <OptionNum label="Bottom margin (mm)" value={options.layoutMarginBottom} min={0} step={1} onChanged={(v) => setOpt('layoutMarginBottom', v ?? 0)} />
                <OptionNum label="Frame thickness (mm)" value={options.marginThickness} min={0} step={0.5} onChanged={(v) => setOpt('marginThickness', v ?? 0)} />
              </OptionSection>
            </div>
          )}

          {part === 5 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 'bold', marginBottom: 4 }}>Part 5 · Export STL</div>
              <div style={{ marginBottom: 8, padding: '4px 0', borderBottom: '1px dashed #ddd' }}>
                <div style={{ fontSize: 11, color: '#666' }}>
                  {rectangle
                    ? <>AOI: {rectangle.extent.width.toFixed(1)} × {rectangle.extent.height.toFixed(1)} m. Build the 3D model, inspect it in the floating preview (drag to tilt / scroll to zoom), then download the STL.</>
                    : 'Draw a rectangle in Part 1 before exporting.'}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button
                  className="btn btn-primary"
                  disabled={exporting || !rectangle}
                  onClick={handleBuildPreview}
                >
                  {exporting ? 'Building...' : (previewGeom ? 'Rebuild 3D model' : 'Build 3D model')}
                </button>
                {previewBlob && (
                  <button className="btn btn-success" onClick={handleDownloadPreview}>
                    Download STL
                  </button>
                )}
              </div>

              {previewError && (
                <div style={{ fontSize: 12, color: '#c44', marginBottom: 8 }}>Preview failed: {previewError}</div>
              )}

              {previewGeom ? (
                <Mesh3DPreview geometry={previewGeom} triangles={previewTriangles} layers={previewLayers} />
              ) : (
                <div
                  style={{
                    height: 240,
                    border: '1px dashed #ccc',
                    borderRadius: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#999',
                    fontSize: 12
                  }}
                >
                  {exporting ? 'Building 3D model...' : 'Click "Build 3D model" to see a floating 3D preview.'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Prev / Next navigation */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 6, borderTop: '1px solid #eee' }}>
          <button
            className="btn btn-secondary"
            disabled={part <= 1}
            onClick={() => setPart(Math.max(1, part - 1))}
          >
            ← Back
          </button>
          <span style={{ fontSize: 11, color: '#888', alignSelf: 'center' }}>Part {part} of {maxPart}</span>
          <button
            className="btn btn-primary"
            disabled={part >= maxPart}
            onClick={() => setPart(Math.min(maxPart, part + 1))}
          >
            Next →
          </button>
        </div>
      </div>
    )}

    <div className="mt-2" style={{ fontSize: 13, color: '#666' }}>
      {status}
    </div>

    <div className="mt-1" style={{ fontSize: 11, color: '#bbb' }}>
      stl-export v7 (DOM overlay)
    </div>
  </div>
}

const OptionSwitch = ({ label, checked, onChanged }: {
  label: string
  checked: boolean
  onChanged: (v: boolean) => void
}) => {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <Switch checked={checked} onChange={(e, v) => onChanged(v)} />
    </div>
  )
}

const OptionNum = ({ label, value, min, max, step, onChanged }: {
  label: string
  value: number
  min: number
  max?: number
  step: number
  onChanged: (v: number | undefined) => void
}) => {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <div style={{ width: 120 }}>
        <NumericInput size="sm" value={value} onChange={onChanged} min={min} max={max} step={step} showHandlers />
      </div>
    </div>
  )
}

const OptionText = ({ label, value, onChanged }: {
  label: string
  value: string
  onChanged: (v: string) => void
}) => {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChanged(e.target.value)}
        style={{ width: 120, fontSize: 12, padding: 2 }}
      />
    </div>
  )
}

const ClassHeightEditor = ({ fields, classField, heights, onFieldChange, onHeightChange, onRemoveHeight, onDetect }: {
  fields: string[]
  classField: string
  heights: Record<string, number>
  onFieldChange: (v: string) => void
  onHeightChange: (classValue: string, height: number) => void
  onRemoveHeight: (classValue: string) => void
  onDetect: () => Promise<string[]>
}) => {
  const [detected, setDetected] = React.useState<string[] | null>(null)
  const [busy, setBusy] = React.useState(false)
  return (
    <div style={{ border: '1px dashed #ddd', borderRadius: 4, padding: '4px 6px', marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 12 }}>Class field</span>
        <div style={{ width: 120 }}>
          <select
            value={classField}
            onChange={(e) => onFieldChange(e.target.value)}
            style={{ width: '100%', fontSize: 12, padding: 2 }}
          >
            <option value="">None (single height)</option>
            {fields.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>
      </div>
      {classField ? (
        <>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
            Distinct values of <b>{classField}</b> get their own height. Click "Detect" to fetch the values present in the AOI, then adjust each height.
          </div>
          <button
            onClick={async () => {
              setBusy(true)
              try {
                const vals = await onDetect()
                setDetected(vals)
              } finally {
                setBusy(false)
              }
            }}
            style={{ fontSize: 11, padding: '2px 6px', marginBottom: 4 }}
            disabled={busy}
          >
            {busy ? 'Detecting...' : 'Detect classes'}
          </button>
          {detected && detected.length === 0 && (
            <div style={{ fontSize: 11, color: '#c44', marginBottom: 4 }}>No values found for this field within the AOI.</div>
          )}
          {detected && detected.length > 0 && (
            <div style={{ fontSize: 11, color: '#284', marginBottom: 4 }}>Detected {detected.length} class value(s). Adjust each height below as needed.</div>
          )}
          <div style={{ fontSize: 11, color: '#888', marginBottom: 2 }}>Class heights (mm)</div>
          {Object.keys(heights).length === 0 && (
            <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>No classes yet — detect them above, or add manually.</div>
          )}
          {Object.keys(heights).map((cv) => (
            <div key={cv} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 12 }}>{cv}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <NumericInput
                  value={heights[cv]}
                  min={0}
                  step={0.1}
                  size="sm"
                  onChange={(v) => onHeightChange(cv, v ?? 0)}
                  style={{ width: 70 }}
                />
                <button onClick={() => onRemoveHeight(cv)} style={{ fontSize: 11, padding: '0 4px' }}>×</button>
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  )
}

const OptionSelect = ({ label, value, options, onChanged }: {
  label: string
  value: string
  options: Array<{ id: string, title: string }>
  onChanged: (v: string) => void
}) => {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <div style={{ width: 120 }}>
        <select
          value={value}
          onChange={(e) => onChanged(e.target.value)}
          style={{ width: '100%', fontSize: 12, padding: 2 }}
        >
          <option value="__none__">None (exclude)</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.title}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

const OptionSection = ({ title, checked, onToggle, children }: {
  title: string
  checked: boolean
  onToggle: (v: boolean) => void
  children: React.ReactNode
}) => {
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 4, padding: '6px 8px', marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: checked ? 6 : 0 }}>
        <span style={{ fontSize: 12, fontWeight: 'bold' }}>{title}</span>
        <Switch checked={checked} onChange={(e, v) => onToggle(v)} />
      </div>
      {checked && children}
    </div>
  )
}

const AdminLevelFields = ({ label, cfg, layerOptions, onChange }: {
  label: string
  cfg: AdminLevelWallConfig
  layerOptions: Array<{ id: string, title: string }>
  onChange: (patch: Partial<AdminLevelWallConfig>) => void
}) => {
  const dims: Array<{ key: 'height' | 'halfWidth' | 'dashLength' | 'dotLength' | 'gap', text: string, step: number, min: number }> = [
    { key: 'height', text: 'Height (mm)', step: 0.1, min: 0 },
    { key: 'halfWidth', text: 'Half-width (mm)', step: 0.05, min: 0 },
    { key: 'dashLength', text: 'Dash length (mm)', step: 0.1, min: 0 },
    { key: 'dotLength', text: 'Dot length (mm)', step: 0.1, min: 0 },
    { key: 'gap', text: 'Gap (mm)', step: 0.1, min: 0 }
  ]
  return (
    <div style={{ marginBottom: 6, paddingLeft: 4, borderLeft: '2px solid #eee' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
        <span style={{ fontSize: 12, fontWeight: 'bold' }}>{label}</span>
        <Switch checked={cfg.enabled} onChange={(e, v) => onChange({ enabled: v })} />
      </div>
      {cfg.enabled && (
        <>
          <OptionSelect label="Layer" value={cfg.layerId || '__none__'} options={layerOptions} onChanged={(v) => onChange({ layerId: v === '__none__' ? '' : v })} />
          {dims.map((f) => (
            <OptionNum key={f.key} label={f.text} value={cfg[f.key]} min={f.min} step={f.step} onChanged={(v) => onChange({ [f.key]: v ?? 0 })} />
          ))}
        </>
      )}
    </div>
  )
}

const LayerCheckboxes = ({ layers, selected, onToggle }: {
  layers: Array<{ id: string, title: string }>
  selected: string[]
  onToggle: (id: string) => void
}) => {
  if (layers.length === 0) return null
  const all = selected.length === 0
  const none = selected.indexOf(LAYER_SELECT_NONE) !== -1
  return (
    <div style={{ marginBottom: 6, paddingLeft: 4, borderLeft: '2px solid #eee' }}>
      {layers.map((layer) => {
        const checked = all || (!none && selected.indexOf(layer.id) !== -1)
        return (
          <div key={layer.id} style={{ fontSize: 12 }}>
            <label style={{ cursor: 'pointer', display: 'block' }}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(layer.id)}
                style={{ marginRight: 4 }}
              />
              {layer.title}
            </label>
          </div>
        )
      })}
    </div>
  )
}

const LayoutPreview = ({ extent, options, compact, zoom, pan, previewData, onZoom, onPan }: {
  extent: { width: number, height: number, xmin: number, xmax: number, ymin: number, ymax: number } | null
  options: Config
  compact?: boolean
  zoom: number
  pan: { x: number, y: number }
  previewData?: LayoutPreviewData | null
  onZoom: (z: number) => void
  onPan: (p: { x: number, y: number }) => void
}) => {
  const [mounted, setMounted] = React.useState(false)
  const svgRef = React.useRef<SVGSVGElement>(null)
  const dragRef = React.useRef<{ sx: number, sy: number, px: number, py: number } | null>(null)
  React.useEffect(() => setMounted(true), [])

  if (!extent || !mounted) {
    return (
      <div style={{ fontSize: 11, color: '#999', margin: '4px 0' }}>
        {extent ? 'Loading preview...' : 'Draw a rectangle on the scene to see the layout preview.'}
      </div>
    )
  }

  const plate = plateSizeMm(options)
  const topMm = options.layoutMarginTop ?? 25
  const leftMm = options.layoutMarginLeft ?? 10
  const rightMm = options.layoutMarginRight ?? 10
  const bottomMm = options.layoutMarginBottom ?? 10
  const frameW = Math.max(plate.width - leftMm - rightMm, 1)
  const frameH = Math.max(plate.height - topMm - bottomMm, 1)

  let scaleDenom = options.layoutScaleDenom ?? 5000
  if (options.layoutFitToPlate) {
    scaleDenom = Math.max(extent.width * 1000 / frameW, extent.height * 1000 / frameH)
  }

  const aoiWmm = extent.width * 1000 / scaleDenom
  const aoiHmm = extent.height * 1000 / scaleDenom
  const overflows = aoiWmm > frameW + 0.001 || aoiHmm > frameH + 0.001

  const scaleLabel = `1 : ${Math.round(scaleDenom).toLocaleString()}`
  const plateLabel = `${plate.width} × ${plate.height} mm`

  // Proportional viewBox: plate mm ratio with padding around it.
  const pad = 1.25
  const vbW = plate.width * pad
  const vbH = plate.height * pad
  const offX = (vbW - plate.width) / 2
  const offY = (vbH - plate.height) / 2

  const aoiXmm = leftMm + (frameW - aoiWmm) / 2
  const aoiYmm = topMm + (frameH - aoiHmm) / 2

  // Ground (extent) coords -> plate mm, assuming north is up and the AOI is
  // centered in the map frame. Used to render the 2D outlines + label dots.
  const toPlateX = (gx: number) => aoiXmm + ((gx - extent.xmin) / extent.width) * aoiWmm
  const toPlateY = (gy: number) => aoiYmm + ((extent.ymax - gy) / extent.height) * aoiHmm
  const platePt = (gx: number, gy: number) => `${(offX + toPlateX(gx)).toFixed(2)},${(offY + toPlateY(gy)).toFixed(2)}`

  const handleZoom = (factor: number) => {
    const z0 = zoom
    const z1 = Math.min(8, Math.max(0.5, z0 * factor))
    const cx = vbW / 2
    const cy = vbH / 2
    onZoom(z1)
    onPan({
      x: cx - (cx - pan.x) * (z1 / z0),
      y: cy - (cy - pan.y) * (z1 / z0)
    })
  }

  const resetView = () => {
    onZoom(1)
    onPan({ x: 0, y: 0 })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !svgRef.current) return
    const scale = vbW / svgRef.current.clientWidth
    const dx = (e.clientX - dragRef.current.sx) * scale
    const dy = (e.clientY - dragRef.current.sy) * scale
    onPan({ x: dragRef.current.px + dx, y: dragRef.current.py + dy })
  }

  const onPointerUp = () => {
    dragRef.current = null
  }

  const btnStyle: React.CSSProperties = {
    width: compact ? 20 : 24,
    height: compact ? 20 : 24,
    lineHeight: '1',
    padding: 0,
    fontSize: compact ? 12 : 14,
    border: '1px solid #ccc',
    borderRadius: 3,
    background: '#fff',
    color: '#333',
    cursor: 'pointer'
  }

  return (
    <div style={{ margin: compact ? '1px 0' : '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: compact ? 1 : 3 }}>
        <div style={{ fontSize: compact ? 10 : 11, color: '#555' }}>
          {scaleLabel} · AOI {((aoiWmm / plate.width) * 100).toFixed(1)}% × {((aoiHmm / plate.height) * 100).toFixed(1)}% of plate
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          <button title="Zoom in" style={btnStyle} onClick={() => handleZoom(1.3)}>+</button>
          <button title="Zoom out" style={btnStyle} onClick={() => handleZoom(1 / 1.3)}>−</button>
          <button title="Reset view" style={btnStyle} onClick={resetView}>⟲</button>
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={(e) => { e.preventDefault(); handleZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15) }}
        style={{
          width: '100%',
          maxHeight: compact ? 90 : 240,
          border: '1px solid #ddd',
          background: '#fafafa',
          cursor: 'grab',
          touchAction: 'none'
        }}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          <rect x={offX} y={offY} width={plate.width} height={plate.height} fill="#fff" stroke="#bbb" strokeWidth={0.6} />
          <rect x={offX + leftMm} y={offY + topMm} width={frameW} height={frameH} fill="none" stroke="#999" strokeWidth={0.5} strokeDasharray="2 1.2" />
          <rect
            x={offX + aoiXmm} y={offY + aoiYmm} width={aoiWmm} height={aoiHmm}
            fill={overflows ? '#fbe3e3' : '#e3eefb'}
            stroke={overflows ? '#c44' : '#2b6cb0'}
            strokeWidth={0.7}
          />
          {!compact && previewData && previewData.outlines.map((ring, ri) => (
            <polyline
              key={`o${ri}`}
              points={ring.map((p) => platePt(p[0], p[1])).join(' ')}
              fill="none"
              stroke="#b07850"
              strokeWidth={0.5}
              strokeOpacity={0.8}
            />
          ))}
          {!compact && previewData && previewData.labels.map((lb, li) => (
            <circle
              key={`l${li}`}
              cx={offX + toPlateX(lb.x)}
              cy={offY + toPlateY(lb.y)}
              r={Math.max(1, Math.min(2.5, aoiWmm * 0.01))}
              fill="#c33"
            />
          ))}
          {!compact && options.includeNorthArrow !== false && (
            <polygon
              points={(() => {
                const len = Math.min(topMm * 0.5, 10)
                const ax = offX + (options.northArrowGap ?? 8) + len * 0.4
                const ay = offY + topMm / 2
                const w = len * 0.16
                const h = len * 0.4
                return [
                  `${ax - w},${ay + len * 0.4}`,
                  `${ax + w},${ay + len * 0.4}`,
                  `${ax + w},${ay + len * 0.12}`,
                  `${ax + h},${ay + len * 0.12}`,
                  `${ax},${ay - len * 0.45}`,
                  `${ax - h},${ay + len * 0.12}`,
                  `${ax - w},${ay + len * 0.12}`
                ].join(' ')
              })()}
              fill="#c33"
            />
          )}
          {!compact && options.includeTitle !== false && (
            <text
              x={offX + leftMm + frameW / 2}
              y={offY + topMm / 2 + plate.width * 0.01}
              fontSize={plate.width * 0.028}
              textAnchor="middle"
              fill="#333"
            >
              {(options.mapTitle || 'Title').slice(0, 18)}
            </text>
          )}
          {!compact && options.includeScaleBar !== false && (
            <>
              <rect
                x={offX + leftMm}
                y={offY + topMm + frameH + bottomMm / 2}
                width={Math.min(frameW * 0.12, 40)}
                height={Math.max(1, bottomMm * 0.2)}
                fill="#555"
              />
              <text
                x={offX + leftMm + Math.min(frameW * 0.12, 40) + 5}
                y={offY + topMm + frameH + bottomMm / 2 + plate.width * 0.008}
                fontSize={plate.width * 0.022}
                textAnchor="start"
                fill="#333"
              >
                {formatKmLabelPreview(extent, options)}
              </text>
            </>
          )}
          {!compact && options.includePrintScale !== false && (
            <text
              x={offX + leftMm + frameW}
              y={offY + topMm + frameH + bottomMm / 2 + plate.width * 0.008}
              fontSize={plate.width * 0.022}
              textAnchor="end"
              fill="#333"
            >
              {scaleLabel}
            </text>
          )}
          {overflows && (
            <text x={offX + plate.width / 2} y={offY + 10} fontSize={plate.width * 0.03} textAnchor="middle" fill="#c44">
              AOI exceeds map frame at this scale
            </text>
          )}
        </g>
      </svg>
      {!compact && <div style={{ fontSize: 11, color: '#777', marginTop: 3 }}>Plate {plateLabel} · map frame {frameW.toFixed(0)} × {frameH.toFixed(0)} mm · drag to pan, scroll / buttons to zoom</div>}
    </div>
  )
}

const Mesh3DPreview = ({ geometry, triangles, layers }: {
  geometry: PreviewGeometry
  triangles: number
  layers: number
}) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const viewerRef = React.useRef<Preview3D | null>(null)
  const [autoRotate, setAutoRotate] = React.useState(true)
  const [frameCount, setFrameCount] = React.useState(0)
  const [color, setColor] = React.useState<[number, number, number]>([0.82, 0.87, 0.95])
  const COLOR_OPTIONS: Array<{ name: string, rgb: [number, number, number] }> = [
    { name: 'Grey', rgb: [0.82, 0.87, 0.95] },
    { name: 'Green', rgb: [0.36, 0.72, 0.36] },
    { name: 'Red', rgb: [0.82, 0.25, 0.25] },
    { name: 'Blue', rgb: [0.25, 0.45, 0.82] },
    { name: 'Yellow', rgb: [0.88, 0.8, 0.25] }
  ]

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const viewer = new Preview3D(canvas)
    viewerRef.current = viewer
    viewer.setGeometry(geometry)
    viewer.setAutoRotate(autoRotate)
    viewer.setColor(color)
    viewer.setOnFrame(() => setFrameCount((c) => c + 1))
    return () => {
      viewer.dispose()
      viewerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry])

  React.useEffect(() => {
    viewerRef.current?.setAutoRotate(autoRotate)
  }, [autoRotate])

  React.useEffect(() => {
    viewerRef.current?.setColor(color)
  }, [color])

  const dims = geometry ? `W ${(geometry.maxX - geometry.minX).toFixed(1)} × D ${(geometry.maxY - geometry.minY).toFixed(1)} × H ${(geometry.maxZ - geometry.minZ).toFixed(1)} m` : ''

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 4, background: '#f5f7fa' }}>
      <div style={{ fontSize: 11, color: '#555', padding: '6px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>3D preview · {dims} · {triangles.toLocaleString()} triangles, {layers} mesh(es)</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>Color</span>
          {COLOR_OPTIONS.map((c) => (
            <button
              key={c.name}
              title={c.name}
              onClick={() => setColor(c.rgb)}
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                border: color === c.rgb ? '2px solid #2b6cb0' : '1px solid #ccc',
                background: `rgb(${Math.round(c.rgb[0] * 255)}, ${Math.round(c.rgb[1] * 255)}, ${Math.round(c.rgb[2] * 255)})`,
                cursor: 'pointer',
                padding: 0
              }}
            />
          ))}
          <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} />
            Auto-rotate
          </label>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: 260, display: 'block', cursor: 'grab', touchAction: 'none' }}
      />
      <div style={{ fontSize: 10, color: '#888', padding: '3px 8px 6px' }}>
        Drag to tilt &amp; rotate · scroll wheel to zoom · rendered by Preview3D (custom WebGL renderer)
      </div>
    </div>
  )
}

// Renders the single scale-bar block's km label in the static preview.
function formatKmLabelPreview(extent: { width: number }, options: Config): string {
  const scaleDenom = options.layoutScaleDenom ?? 5000
  const lenMm = options.scaleBarLength ?? 40
  const meters = (lenMm * scaleDenom) / 1000
  const km = meters / 1000
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(km, 0.1))))
  const normalized = km / mag
  let nice = 1
  if (normalized >= 5) nice = 5
  else if (normalized >= 2) nice = 2
  else if (normalized >= 1) nice = 1
  else nice = 0.5
  const niceKm = nice * mag
  const s = Number.isInteger(niceKm) ? String(niceKm) : niceKm.toFixed(1)
  return s + 'km'
}

export default Widget
