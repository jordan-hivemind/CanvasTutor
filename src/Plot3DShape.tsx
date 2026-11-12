// A 3D plot that lives on the board as data (expressions + view angle), so it can be rotated.
// Drag the ⟳ grip to rotate; the new angle is saved and syncs like any other change.
import { useMemo, useRef, useState } from 'react'
import { BaseBoxShapeUtil, HTMLContainer, T, useEditor, type TLShape } from 'tldraw'
import { renderPlot3D, type Plot3DSpec } from '../server/plotcore'

const PLOT3D = 'plot3d'

declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [PLOT3D]: { w: number; h: number; spec: string; azimuth: number; elevation: number }
  }
}

export type Plot3DShape = TLShape<typeof PLOT3D>

function render(shape: Plot3DShape, az: number, el: number, resolution?: number): string {
  try {
    const spec = JSON.parse(shape.props.spec) as Plot3DSpec
    return renderPlot3D({ ...spec, w: shape.props.w, h: shape.props.h, azimuth: az, elevation: el, resolution }).svg
  } catch (e) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${shape.props.w}" height="${shape.props.h}"><text x="10" y="24" fill="#c92a2a" font-size="14">Couldn't draw this plot: ${String(e).replace(/[<&]/g, '')}</text></svg>`
  }
}

function svgDataUrl(svg: string) {
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
}

function Plot3DView({ shape }: { shape: Plot3DShape }) {
  const editor = useEditor()
  const [live, setLive] = useState<{ az: number; el: number } | null>(null)
  const drag = useRef<{ x: number; y: number; az: number; el: number; id: number } | null>(null)
  const az = live?.az ?? shape.props.azimuth
  const el = live?.el ?? shape.props.elevation
  // lighter mesh while dragging keeps rotation smooth
  const svg = useMemo(() => render(shape, az, el, live ? 18 : undefined), [shape, az, el, live])

  const end = () => {
    const d = drag.current
    drag.current = null
    if (!d || !live) return setLive(null)
    editor.updateShape<Plot3DShape>({ id: shape.id, type: PLOT3D, props: { azimuth: live.az, elevation: live.el } })
    setLive(null)
  }

  return (
    <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, position: 'relative' }}>
      <div style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: svg }} />
      <div
        className="plot3d-grip"
        title="Drag to rotate"
        onPointerDown={(e) => {
          e.stopPropagation() // don't start drawing or selecting
          e.preventDefault()
          try {
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          } catch {}
          drag.current = { x: e.clientX, y: e.clientY, az: shape.props.azimuth, el: shape.props.elevation, id: e.pointerId }
          setLive({ az: shape.props.azimuth, el: shape.props.elevation })
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || d.id !== e.pointerId) return
          e.stopPropagation()
          setLive({ az: d.az - (e.clientX - d.x) * 0.6, el: Math.max(-5, Math.min(89, d.el + (e.clientY - d.y) * 0.4)) })
        }}
        onPointerUp={(e) => {
          e.stopPropagation()
          end()
        }}
        onPointerCancel={end}
      >
        ⟳
      </div>
    </HTMLContainer>
  )
}

export class Plot3DShapeUtil extends BaseBoxShapeUtil<Plot3DShape> {
  static override type = PLOT3D
  static override props = { w: T.number, h: T.number, spec: T.string, azimuth: T.number, elevation: T.number }

  override getDefaultProps(): Plot3DShape['props'] {
    return { w: 460, h: 380, spec: '{}', azimuth: -55, elevation: 28 }
  }

  override canEdit() {
    return false
  }

  override component(shape: Plot3DShape) {
    return <Plot3DView shape={shape} />
  }

  override getIndicatorPath(shape: Plot3DShape) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }

  // Exports (board snapshots for Claude, image export) use the current angle.
  override toSvg(shape: Plot3DShape) {
    return <image href={svgDataUrl(render(shape, shape.props.azimuth, shape.props.elevation))} width={shape.props.w} height={shape.props.h} />
  }
}
