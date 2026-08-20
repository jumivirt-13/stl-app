import { React } from 'jimu-core'
import type { AllWidgetSettingProps } from 'jimu-for-builder'
import { MapWidgetSelector, SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { Switch, NumericInput, TextInput } from 'jimu-ui'
import type { IMConfig, AdminLevelKey, AdminLevelWallConfig } from '../config'
import { DEFAULT_ADMIN_LEVELS, PLATE_PRESETS } from '../config'

const Setting = (props: AllWidgetSettingProps<IMConfig>) => {
  const onMapWidgetSelected = (useMapWidgetIds: string[]) => {
    props.onSettingChange({
      id: props.id,
      useMapWidgetIds: useMapWidgetIds
    })
  }

  const onIncludeTerrainChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeTerrain', checked)
    })
  }

  const onIncludeLayersChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeLayers', checked)
    })
  }

  const onExtrudeBaseChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('extrudeBase', checked)
    })
  }

  const onExtrusionDepthChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('extrusionDepth', value ?? 0)
    })
  }

  const onIncludePolygonsChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includePolygons', checked)
    })
  }

  const onPolygonWallHeightChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('polygonWallHeight', value ?? 0)
    })
  }

  const onPolygonWallHalfWidthChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('polygonWallHalfWidth', value ?? 0)
    })
  }

  const onAdminLevelChange = (level: AdminLevelKey, key: keyof AdminLevelWallConfig, value: number | boolean | string | undefined) => {
    const levels = { ...DEFAULT_ADMIN_LEVELS, ...(props.config.adminLevels ?? {}) }
    levels[level] = { ...levels[level], [key]: value ?? (key === 'enabled' ? false : '') }
    props.onSettingChange({
      id: props.id,
      config: props.config.set('adminLevels', levels)
    })
  }

  const onIncludeRasterChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeRaster', checked)
    })
  }

  const onIncludeLabelsChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeLabels', checked)
    })
  }

  const onIncludeLayerLabelsChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeLayerLabels', checked)
    })
  }

  const onIncludeFurnitureLabelsChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeFurnitureLabels', checked)
    })
  }

  const onFurnitureLabelFontSizeChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('furnitureLabelFontSize', value ?? 0)
    })
  }

  const onFurnitureLabelDomeHeightChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('furnitureLabelDomeHeight', value ?? 0)
    })
  }

  const onFurnitureLabelEdgeGapChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('furnitureLabelEdgeGap', value ?? 0)
    })
  }

  const onLabelDomeHeightChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('labelDomeHeight', value ?? 0)
    })
  }

  const onLabelFontSizeChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('labelFontSize', value ?? 0)
    })
  }

  const onLabelEdgeGapChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('labelEdgeGap', value ?? 0)
    })
  }

  const onIncludeLinesChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeLines', checked)
    })
  }

  const onIncludeRoadsChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeRoads', checked)
    })
  }

  const onIncludeRiversChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeRivers', checked)
    })
  }

  const onRoadsWallHeightChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('roadsWallHeight', value ?? 0)
    })
  }

  const onRoadsWallHalfWidthChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('roadsWallHalfWidth', value ?? 0)
    })
  }

  const onRoadsPolygonHeightChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('roadsPolygonHeight', value ?? 0)
    })
  }

  const onRiversWallHeightChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('riversWallHeight', value ?? 0)
    })
  }

  const onRiversWallHalfWidthChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('riversWallHalfWidth', value ?? 0)
    })
  }

  const onRiversPolygonHeightChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('riversPolygonHeight', value ?? 0)
    })
  }

  const onRoadsLayerIdChange = (value: string) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('roadsLayerId', value)
    })
  }

  const onRoadsPolygonLayerIdChange = (value: string) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('roadsPolygonLayerId', value)
    })
  }

  const onRiversLayerIdChange = (value: string) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('riversLayerId', value)
    })
  }

  const onRiversPolygonLayerIdChange = (value: string) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('riversPolygonLayerId', value)
    })
  }

  const onSimplifyMeshesChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('simplifyMeshes', checked)
    })
  }

  const onSimplifyCellChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('simplifyCell', value ?? 0.5)
    })
  }

  const onRasterBandsChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('rasterBands', value ?? 1)
    })
  }

  const onRasterGridChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('rasterGrid', value ?? 8)
    })
  }

  const onRasterMaxHeightChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('rasterMaxHeight', value ?? 0)
    })
  }

  const onHazardLayerIdChange = (value: string) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('hazardLayerId', value)
    })
  }

  const onHazardDotsChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('hazardDots', checked)
    })
  }

  const onHazardDotsPerCellChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('hazardDotsPerCell', value ?? 1)
    })
  }

  const onHazardDotRadiusChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('hazardDotRadius', value ?? 0)
    })
  }

  const onHazardDotHeightChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('hazardDotHeight', value ?? 0)
    })
  }

  const onDisasterLayerIdChange = (key: 'disasterPolygonLayerId' | 'disasterPolylineLayerId' | 'disasterPointLayerId', value: string) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set(key, value)
    })
  }

  const onDisasterNumChange = (key: 'disasterPolygonHeight' | 'disasterWallHeight' | 'disasterWallHalfWidth' | 'disasterPointRadius' | 'disasterPointHeight', value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set(key, value ?? 0)
    })
  }

  const onDisasterClassFieldChange = (key: 'disasterPolygonClassField' | 'disasterPolylineClassField' | 'disasterPointClassField', value: string) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set(key, value)
    })
  }

  const onDisasterClassHeightsChange = (key: 'disasterPolygonClassHeights' | 'disasterPolylineClassHeights' | 'disasterPointClassHeights', value: string) => {
    const map: Record<string, number> = {}
    for (const part of value.split(';')) {
      const seg = part.split('=')
      if (seg.length === 2 && seg[0].trim()) {
        const h = Number(seg[1].trim())
        if (Number.isFinite(h)) map[seg[0].trim()] = h
      }
    }
    props.onSettingChange({
      id: props.id,
      config: props.config.set(key, map)
    })
  }

  const onRasterBandHeightsChange = (value: string) => {
    const arr = value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
    props.onSettingChange({
      id: props.id,
      config: props.config.set('rasterBandHeights', arr)
    })
  }

  const onFlatBaseChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('flatBase', checked)
    })
  }

  const onFlatBaseThicknessChange = (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('flatBaseThickness', value ?? 0)
    })
  }

  const onIncludeMarginChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeMargin', checked)
    })
  }

  const onIncludeTitleChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeTitle', checked)
    })
  }

  const onMapTitleChange = (value: string) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('mapTitle', value)
    })
  }

  const onIncludeScaleBarChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeScaleBar', checked)
    })
  }

  const onScaleBarNumChange = (key: 'scaleBarLength' | 'scaleBarWidth' | 'scaleBarHeight') => (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set(key, value ?? 0)
    })
  }

  const onIncludePrintScaleChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includePrintScale', checked)
    })
  }

  const onIncludeNorthArrowChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('includeNorthArrow', checked)
    })
  }

  const onNorthArrowNumChange = (key: 'northArrowLength' | 'northArrowWidth' | 'northArrowHeight' | 'northArrowGap') => (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set(key, value ?? 0)
    })
  }

  const onUseLayoutChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('useLayout', checked)
    })
  }

  const onLayoutNumChange = (key: 'layoutPlateWidth' | 'layoutPlateHeight' | 'layoutScaleDenom' | 'layoutMarginTop' | 'layoutMarginLeft' | 'layoutMarginRight' | 'layoutMarginBottom' | 'marginThickness') => (value: number | undefined) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set(key, value ?? 0)
    })
  }

  const onLayoutPresetChange = (key: string) => {
    const preset = PLATE_PRESETS[key]
    if (!preset) return
    let cfg: IMConfig = props.config.set('layoutPlatePreset', key)
    if (key !== 'CUSTOM') {
      cfg = cfg.set('layoutPlateWidth', preset.width).set('layoutPlateHeight', preset.height)
    }
    props.onSettingChange({ id: props.id, config: cfg })
  }

  const onLayoutFitToPlateChange = (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    props.onSettingChange({
      id: props.id,
      config: props.config.set('layoutFitToPlate', checked)
    })
  }

  const config = props.config || {}

  return <div className="widget-setting-stl-export">
    <SettingSection title="Select map">
      <SettingRow label="Map">
        <MapWidgetSelector useMapWidgetIds={props.useMapWidgetIds} onSelect={onMapWidgetSelected} />
      </SettingRow>
    </SettingSection>

    <SettingSection title="Content to export">
      <SettingRow label="Include terrain">
        <Switch checked={config.includeTerrain !== false} onChange={onIncludeTerrainChange} />
      </SettingRow>
      <SettingRow label="Include scene layers">
        <Switch checked={config.includeLayers !== false} onChange={onIncludeLayersChange} />
      </SettingRow>
      <SettingRow label="Simplify building meshes">
        <Switch checked={config.simplifyMeshes !== false} onChange={onSimplifyMeshesChange} />
      </SettingRow>
      <SettingRow label="Simplify cell (mm)">
        <NumericInput value={config.simplifyCell ?? 0.1} onChange={onSimplifyCellChange} min={0.05} step={0.05} showHandlers />
      </SettingRow>
      <SettingRow label="Include polygons (divisions)">
        <Switch checked={config.includePolygons !== false} onChange={onIncludePolygonsChange} />
      </SettingRow>
      <SettingRow label="Include raster (disaster related)">
        <Switch checked={config.includeRaster !== false} onChange={onIncludeRasterChange} />
      </SettingRow>
      <SettingRow label="Include lines (roads/rivers)">
        <Switch checked={config.includeLines !== false} onChange={onIncludeLinesChange} />
      </SettingRow>
    </SettingSection>

    <SettingSection title="Road walls">
      <SettingRow label="Include roads">
        <Switch checked={config.includeRoads !== false} onChange={onIncludeRoadsChange} />
      </SettingRow>
      <SettingRow label="Roads layer id (polyline)">
        <TextInput value={config.roadsLayerId ?? ''} onChange={onRoadsLayerIdChange} style={{ width: 160 }} />
      </SettingRow>
      <SettingRow label="Roads layer id (polygon)">
        <TextInput value={config.roadsPolygonLayerId ?? ''} onChange={onRoadsPolygonLayerIdChange} style={{ width: 160 }} />
      </SettingRow>
      {config.roadsLayerId && config.roadsLayerId !== '__none__' && (
        <>
          <SettingRow label="Wall height (mm)">
            <NumericInput value={config.roadsWallHeight ?? 0.6} onChange={onRoadsWallHeightChange} min={0} step={0.1} showHandlers />
          </SettingRow>
          <SettingRow label="Wall half-width (mm)">
            <NumericInput value={config.roadsWallHalfWidth ?? 0.1} onChange={onRoadsWallHalfWidthChange} min={0} step={0.05} showHandlers />
          </SettingRow>
        </>
      )}
      {config.roadsPolygonLayerId && config.roadsPolygonLayerId !== '__none__' && (
        <SettingRow label="Polygon area height (mm)">
          <NumericInput value={config.roadsPolygonHeight ?? 0.6} onChange={onRoadsPolygonHeightChange} min={0} step={0.1} showHandlers />
        </SettingRow>
      )}
    </SettingSection>

    <SettingSection title="River walls">
      <SettingRow label="Include rivers">
        <Switch checked={config.includeRivers !== false} onChange={onIncludeRiversChange} />
      </SettingRow>
      <SettingRow label="Rivers layer id (polyline)">
        <TextInput value={config.riversLayerId ?? ''} onChange={onRiversLayerIdChange} style={{ width: 160 }} />
      </SettingRow>
      <SettingRow label="Rivers layer id (polygon)">
        <TextInput value={config.riversPolygonLayerId ?? ''} onChange={onRiversPolygonLayerIdChange} style={{ width: 160 }} />
      </SettingRow>
      {config.riversLayerId && config.riversLayerId !== '__none__' && (
        <>
          <SettingRow label="Wall height (mm)">
            <NumericInput value={config.riversWallHeight ?? 0.6} onChange={onRiversWallHeightChange} min={0} step={0.1} showHandlers />
          </SettingRow>
          <SettingRow label="Wall half-width (mm)">
            <NumericInput value={config.riversWallHalfWidth ?? 0.1} onChange={onRiversWallHalfWidthChange} min={0} step={0.05} showHandlers />
          </SettingRow>
        </>
      )}
      {config.riversPolygonLayerId && config.riversPolygonLayerId !== '__none__' && (
        <SettingRow label="Polygon area height (mm)">
          <NumericInput value={config.riversPolygonHeight ?? 0.6} onChange={onRiversPolygonHeightChange} min={0} step={0.1} showHandlers />
        </SettingRow>
      )}
    </SettingSection>

    <SettingSection title="Division boundary walls">
      <SettingRow label="Wall height (mm)">
        <NumericInput value={config.polygonWallHeight ?? 0.8} onChange={onPolygonWallHeightChange} min={0} step={0.1} showHandlers />
      </SettingRow>
      <SettingRow label="Wall half-width (mm)">
        <NumericInput value={config.polygonWallHalfWidth ?? 0.3} onChange={onPolygonWallHalfWidthChange} min={0} step={0.05} showHandlers />
      </SettingRow>
      {(['village', 'district', 'city', 'province', 'country'] as AdminLevelKey[]).map((level) => {
        const label = level === 'village' ? 'Village (dash-4 dots)' :
          level === 'district' ? 'District (dash-3 dots)' :
          level === 'city' ? 'City/Regency (dash-2 dots)' :
          level === 'province' ? 'Province (dash-1 dot)' : 'Country (dash-dash)'
        const cfg = config.adminLevels?.[level] ?? DEFAULT_ADMIN_LEVELS[level]
        return (
          <div key={level} style={{ paddingLeft: 12, marginBottom: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 'bold', margin: '6px 0 2px' }}>{label}</div>
            <SettingRow label="Enabled">
              <Switch checked={cfg.enabled !== false} onChange={(e, v) => onAdminLevelChange(level, 'enabled', v)} />
            </SettingRow>
            {cfg.enabled !== false && (
              <>
                <SettingRow label="Layer id (empty = auto)">
                  <TextInput value={cfg.layerId ?? ''} onChange={(v) => onAdminLevelChange(level, 'layerId', v)} style={{ width: 160 }} />
                </SettingRow>
                <SettingRow label="Height (mm)">
                  <NumericInput value={cfg.height} onChange={(v) => onAdminLevelChange(level, 'height', v)} min={0} step={0.1} showHandlers />
                </SettingRow>
                <SettingRow label="Half-width (mm)">
                  <NumericInput value={cfg.halfWidth} onChange={(v) => onAdminLevelChange(level, 'halfWidth', v)} min={0} step={0.05} showHandlers />
                </SettingRow>
                <SettingRow label="Dash length (mm)">
                  <NumericInput value={cfg.dashLength} onChange={(v) => onAdminLevelChange(level, 'dashLength', v)} min={0} step={0.1} showHandlers />
                </SettingRow>
                <SettingRow label="Dot length (mm)">
                  <NumericInput value={cfg.dotLength} onChange={(v) => onAdminLevelChange(level, 'dotLength', v)} min={0} step={0.1} showHandlers />
                </SettingRow>
                <SettingRow label="Gap (mm)">
                  <NumericInput value={cfg.gap} onChange={(v) => onAdminLevelChange(level, 'gap', v)} min={0} step={0.1} showHandlers />
                </SettingRow>
              </>
            )}
          </div>
        )
      })}
      <SettingRow label="Labels">
        <Switch checked={config.includeLabels !== false} onChange={onIncludeLabelsChange} />
      </SettingRow>
      {config.includeLabels !== false && (
        <>
          <SettingRow label="Layer labels">
            <Switch checked={config.includeLayerLabels !== false} onChange={onIncludeLayerLabelsChange} />
          </SettingRow>
          {config.includeLayerLabels !== false && (
            <>
              <SettingRow label="Layer font size (mm)">
                <NumericInput value={config.labelFontSize ?? 2.5} onChange={onLabelFontSizeChange} min={0.5} step={0.1} showHandlers />
              </SettingRow>
              <SettingRow label="Layer dome height (mm)">
                <NumericInput value={config.labelDomeHeight ?? 0.5} onChange={onLabelDomeHeightChange} min={0} step={0.1} showHandlers />
              </SettingRow>
              <SettingRow label="Layer edge gap (mm)">
                <NumericInput value={config.labelEdgeGap ?? 5} onChange={onLabelEdgeGapChange} min={0} step={0.5} showHandlers />
              </SettingRow>
            </>
          )}
          <SettingRow label="Furniture labels">
            <Switch checked={config.includeFurnitureLabels !== false} onChange={onIncludeFurnitureLabelsChange} />
          </SettingRow>
          {config.includeFurnitureLabels !== false && (
            <>
              <SettingRow label="Furniture font size (mm)">
                <NumericInput value={config.furnitureLabelFontSize ?? 2.5} onChange={onFurnitureLabelFontSizeChange} min={0.5} step={0.1} showHandlers />
              </SettingRow>
              <SettingRow label="Furniture dome height (mm)">
                <NumericInput value={config.furnitureLabelDomeHeight ?? 0.5} onChange={onFurnitureLabelDomeHeightChange} min={0} step={0.1} showHandlers />
              </SettingRow>
              <SettingRow label="Furniture edge gap (mm)">
                <NumericInput value={config.furnitureLabelEdgeGap ?? 4} onChange={onFurnitureLabelEdgeGapChange} min={0} step={0.5} showHandlers />
              </SettingRow>
            </>
          )}
        </>
      )}
    </SettingSection>

    <SettingSection title="Disaster related (raster contour bands)">
      <SettingRow label="Raster layer id (empty = none)">
        <TextInput value={config.hazardLayerId ?? ''} onChange={onHazardLayerIdChange} style={{ width: 160 }} />
      </SettingRow>
      <SettingRow label="Number of bands">
        <NumericInput value={config.rasterBands ?? 4} onChange={onRasterBandsChange} min={1} max={20} step={1} showHandlers />
      </SettingRow>
      <SettingRow label="Sampling grid (per side)">
        <NumericInput value={config.rasterGrid ?? 24} onChange={onRasterGridChange} min={4} max={120} step={4} showHandlers />
      </SettingRow>
      <SettingRow label="Top band height (mm)">
        <NumericInput value={config.rasterMaxHeight ?? 1.6} onChange={onRasterMaxHeightChange} min={0} step={0.1} showHandlers />
      </SettingRow>
      <SettingRow label="Per-band heights (mm, comma list)">
        <TextInput
          value={(config.rasterBandHeights ?? []).join(',')}
          onChange={onRasterBandHeightsChange}
          style={{ width: 220 }}
        />
      </SettingRow>
    </SettingSection>

    <SettingSection title="Hazard texture dots">
      <SettingRow label="Enable dots">
        <Switch checked={config.hazardDots !== false} onChange={onHazardDotsChange} />
      </SettingRow>
      <SettingRow label="Dots per cell">
        <NumericInput value={config.hazardDotsPerCell ?? 3} onChange={onHazardDotsPerCellChange} min={1} max={6} step={1} showHandlers />
      </SettingRow>
      <SettingRow label="Base dot radius (mm)">
        <NumericInput value={config.hazardDotRadius ?? 0.2} onChange={onHazardDotRadiusChange} min={0} step={0.05} showHandlers />
      </SettingRow>
      <SettingRow label="Base dot height (mm)">
        <NumericInput value={config.hazardDotHeight ?? 0.24} onChange={onHazardDotHeightChange} min={0} step={0.05} showHandlers />
      </SettingRow>
    </SettingSection>

    <SettingSection title="Disaster related (polygon)">
      <SettingRow label="Polygon layer id (empty = none)">
        <TextInput value={config.disasterPolygonLayerId ?? ''} onChange={(v) => onDisasterLayerIdChange('disasterPolygonLayerId', v)} style={{ width: 160 }} />
      </SettingRow>
      <SettingRow label="Polygon height (mm)">
        <NumericInput value={config.disasterPolygonHeight ?? 0.6} onChange={(v) => onDisasterNumChange('disasterPolygonHeight', v)} min={0} step={0.1} showHandlers />
      </SettingRow>
      <SettingRow label="Class field (empty = single height)">
        <TextInput value={config.disasterPolygonClassField ?? ''} onChange={(v) => onDisasterClassFieldChange('disasterPolygonClassField', v)} style={{ width: 160 }} />
      </SettingRow>
      <SettingRow label="Class heights (value=mm; value=mm...)">
        <TextInput
          value={Object.entries(config.disasterPolygonClassHeights ?? {}).map(([k, v]) => `${k}=${v}`).join(';')}
          onChange={(v) => onDisasterClassHeightsChange('disasterPolygonClassHeights', v)}
          style={{ width: 240 }}
        />
      </SettingRow>
    </SettingSection>

    <SettingSection title="Disaster related (polyline)">
      <SettingRow label="Polyline layer id (empty = none)">
        <TextInput value={config.disasterPolylineLayerId ?? ''} onChange={(v) => onDisasterLayerIdChange('disasterPolylineLayerId', v)} style={{ width: 160 }} />
      </SettingRow>
      <SettingRow label="Wall height (mm)">
        <NumericInput value={config.disasterWallHeight ?? 0.6} onChange={(v) => onDisasterNumChange('disasterWallHeight', v)} min={0} step={0.1} showHandlers />
      </SettingRow>
      <SettingRow label="Wall half-width (mm)">
        <NumericInput value={config.disasterWallHalfWidth ?? 0.1} onChange={(v) => onDisasterNumChange('disasterWallHalfWidth', v)} min={0} step={0.05} showHandlers />
      </SettingRow>
      <SettingRow label="Class field (empty = single height)">
        <TextInput value={config.disasterPolylineClassField ?? ''} onChange={(v) => onDisasterClassFieldChange('disasterPolylineClassField', v)} style={{ width: 160 }} />
      </SettingRow>
      <SettingRow label="Class heights (value=mm; value=mm...)">
        <TextInput
          value={Object.entries(config.disasterPolylineClassHeights ?? {}).map(([k, v]) => `${k}=${v}`).join(';')}
          onChange={(v) => onDisasterClassHeightsChange('disasterPolylineClassHeights', v)}
          style={{ width: 240 }}
        />
      </SettingRow>
    </SettingSection>

    <SettingSection title="Disaster related (point)">
      <SettingRow label="Point layer id (empty = none)">
        <TextInput value={config.disasterPointLayerId ?? ''} onChange={(v) => onDisasterLayerIdChange('disasterPointLayerId', v)} style={{ width: 160 }} />
      </SettingRow>
      <SettingRow label="Point radius (mm)">
        <NumericInput value={config.disasterPointRadius ?? 0.3} onChange={(v) => onDisasterNumChange('disasterPointRadius', v)} min={0} step={0.05} showHandlers />
      </SettingRow>
      <SettingRow label="Point height (mm)">
        <NumericInput value={config.disasterPointHeight ?? 0.5} onChange={(v) => onDisasterNumChange('disasterPointHeight', v)} min={0} step={0.05} showHandlers />
      </SettingRow>
      <SettingRow label="Class field (empty = single height)">
        <TextInput value={config.disasterPointClassField ?? ''} onChange={(v) => onDisasterClassFieldChange('disasterPointClassField', v)} style={{ width: 160 }} />
      </SettingRow>
      <SettingRow label="Class heights (value=mm; value=mm...)">
        <TextInput
          value={Object.entries(config.disasterPointClassHeights ?? {}).map(([k, v]) => `${k}=${v}`).join(';')}
          onChange={(v) => onDisasterClassHeightsChange('disasterPointClassHeights', v)}
          style={{ width: 240 }}
        />
      </SettingRow>
    </SettingSection>

    <SettingSection title="Layout view (plate & scale)">
      <SettingRow label="Use layout mode">
        <Switch checked={config.useLayout === true} onChange={onUseLayoutChange} />
      </SettingRow>
      {config.useLayout === true && (
        <>
          <SettingRow label="Plate preset">
            <select
              value={config.layoutPlatePreset ?? 'A4-L'}
              onChange={(e) => onLayoutPresetChange(e.target.value)}
              style={{ width: 180 }}
            >
              {(Object.keys(PLATE_PRESETS)).map((key) => (
                <option key={key} value={key}>{PLATE_PRESETS[key].label}</option>
              ))}
            </select>
          </SettingRow>
          {(config.layoutPlatePreset ?? 'A4-L') === 'CUSTOM' && (
            <>
              <SettingRow label="Plate width (mm)">
                <NumericInput value={config.layoutPlateWidth ?? 400} onChange={onLayoutNumChange('layoutPlateWidth')} min={1} step={1} showHandlers />
              </SettingRow>
              <SettingRow label="Plate height (mm)">
                <NumericInput value={config.layoutPlateHeight ?? 300} onChange={onLayoutNumChange('layoutPlateHeight')} min={1} step={1} showHandlers />
              </SettingRow>
            </>
          )}
          <SettingRow label="Print scale (1 : X)">
            <NumericInput value={config.layoutScaleDenom ?? 5000} onChange={onLayoutNumChange('layoutScaleDenom')} min={1} step={100} showHandlers />
          </SettingRow>
          <SettingRow label="Fit AOI to plate">
            <Switch checked={config.layoutFitToPlate !== false} onChange={onLayoutFitToPlateChange} />
          </SettingRow>
          <SettingRow label="Top margin (mm)">
            <NumericInput value={config.layoutMarginTop ?? 25} onChange={onLayoutNumChange('layoutMarginTop')} min={0} step={1} showHandlers />
          </SettingRow>
          <SettingRow label="Left margin (mm)">
            <NumericInput value={config.layoutMarginLeft ?? 10} onChange={onLayoutNumChange('layoutMarginLeft')} min={0} step={1} showHandlers />
          </SettingRow>
          <SettingRow label="Right margin (mm)">
            <NumericInput value={config.layoutMarginRight ?? 10} onChange={onLayoutNumChange('layoutMarginRight')} min={0} step={1} showHandlers />
          </SettingRow>
          <SettingRow label="Bottom margin (mm)">
            <NumericInput value={config.layoutMarginBottom ?? 10} onChange={onLayoutNumChange('layoutMarginBottom')} min={0} step={1} showHandlers />
          </SettingRow>
          <SettingRow label="Frame thickness (mm)">
            <NumericInput value={config.marginThickness ?? 2} onChange={onLayoutNumChange('marginThickness')} min={0} step={0.5} showHandlers />
          </SettingRow>
        </>
      )}
    </SettingSection>

    <SettingSection title="Margin & map furniture">
      <SettingRow label="Include offset margin">
        <Switch checked={config.includeMargin !== false} onChange={onIncludeMarginChange} />
      </SettingRow>
      <SettingRow label="Braille map title">
        <Switch checked={config.includeTitle !== false} onChange={onIncludeTitleChange} />
      </SettingRow>
      {config.includeTitle !== false && (
        <>
          <SettingRow label="Title text">
            <TextInput value={config.mapTitle ?? ''} onChange={onMapTitleChange} style={{ width: 180 }} />
          </SettingRow>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Uses the shared Braille font size &amp; dome height (see "Braille name labels").</div>
        </>
      )}
      <SettingRow label="Scale bar (bottom)">
        <Switch checked={config.includeScaleBar !== false} onChange={onIncludeScaleBarChange} />
      </SettingRow>
      {config.includeScaleBar !== false && (
        <>
          <SettingRow label="Scale bar length (mm)">
            <NumericInput value={config.scaleBarLength ?? 40} onChange={onScaleBarNumChange('scaleBarLength')} min={0} step={1} showHandlers />
          </SettingRow>
          <SettingRow label="Scale bar width (mm)">
            <NumericInput value={config.scaleBarWidth ?? 3} onChange={onScaleBarNumChange('scaleBarWidth')} min={0} step={0.5} showHandlers />
          </SettingRow>
          <SettingRow label="Scale bar height (mm)">
            <NumericInput value={config.scaleBarHeight ?? 0.8} onChange={onScaleBarNumChange('scaleBarHeight')} min={0} step={0.5} showHandlers />
          </SettingRow>
        </>
      )}
      <SettingRow label="Print scale (1:X, bottom-right)">
        <Switch checked={config.includePrintScale !== false} onChange={onIncludePrintScaleChange} />
      </SettingRow>
      <SettingRow label="North arrow (top-left)">
        <Switch checked={config.includeNorthArrow !== false} onChange={onIncludeNorthArrowChange} />
      </SettingRow>
      {config.includeNorthArrow !== false && (
        <>
          <SettingRow label="Arrow length (mm)">
            <NumericInput value={config.northArrowLength ?? 12} onChange={onNorthArrowNumChange('northArrowLength')} min={0} step={1} showHandlers />
          </SettingRow>
          <SettingRow label="Arrow width (mm)">
            <NumericInput value={config.northArrowWidth ?? 6} onChange={onNorthArrowNumChange('northArrowWidth')} min={0} step={0.5} showHandlers />
          </SettingRow>
          <SettingRow label="Arrow height (mm)">
            <NumericInput value={config.northArrowHeight ?? 1.2} onChange={onNorthArrowNumChange('northArrowHeight')} min={0} step={0.5} showHandlers />
          </SettingRow>
          <SettingRow label="Arrow gap (mm)">
            <NumericInput value={config.northArrowGap ?? 8} onChange={onNorthArrowNumChange('northArrowGap')} min={0} step={0.5} showHandlers />
          </SettingRow>
        </>
      )}
    </SettingSection>

    <SettingSection title="Print base">
      <SettingRow label="Extrude base">
        <Switch checked={config.extrudeBase !== false} onChange={onExtrudeBaseChange} />
      </SettingRow>
      <SettingRow label="Extrusion depth (mm)">
        <NumericInput
          value={config.extrusionDepth ?? 2}
          onChange={onExtrusionDepthChange}
          min={0}
          step={0.5}
          showHandlers
        />
      </SettingRow>
      <SettingRow label="Flat base plate">
        <Switch checked={config.flatBase === true} onChange={onFlatBaseChange} />
      </SettingRow>
      <SettingRow label="Plate thickness (mm)">
        <NumericInput
          value={config.flatBaseThickness ?? 0.4}
          onChange={onFlatBaseThicknessChange}
          min={0}
          step={0.1}
          showHandlers
        />
      </SettingRow>
    </SettingSection>
  </div>
}

export default Setting
