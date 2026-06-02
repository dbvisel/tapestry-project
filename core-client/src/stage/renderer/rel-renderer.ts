import { Graphics, Point, StrokeStyle } from 'pixi.js'
import { TapestryElementRenderer } from './tapestry-element-renderer'
import { mul, Point as TapestryPoint, translate, Vector } from 'tapestry-core/src/lib/geometry'
import { Store } from '../../lib/store/index'
import { IdMap } from 'tapestry-core/src/utils'
import { isHoveredElement } from '../utils'
import {
  computeRelCurvePoints,
  Curve,
  REL_ARROWHEAD_SIZES,
  REL_LINE_WIDTHS,
} from '../../view-model/rel-geometry'
import { ItemViewModel, RelViewModel, TapestryViewModel } from '../../view-model'
import { TapestryStage } from '..'
import { Theme, THEMES } from '../../theme/themes'

const DEFAULT_REL_Z_INDEX = 0
const LINE_SMOOTHNESS = 0.7

const MIN_LINE_STROKE_VISIBLE_WIDTH = 0.7

export function drawCurve(gfx: Graphics, curve: Curve, part: 'full' | 'head' | 'tail' = 'full') {
  const start = part === 'tail' ? curve.points.middle : curve.points.start
  gfx.moveTo(start.x, start.y)
  if (part !== 'tail') {
    gfx.quadraticCurveTo(
      curve.points.control1.x,
      curve.points.control1.y,
      curve.points.middle.x,
      curve.points.middle.y,
      LINE_SMOOTHNESS,
    )
  }
  if (part !== 'head') {
    gfx.quadraticCurveTo(
      curve.points.control2.x,
      curve.points.control2.y,
      curve.points.end.x,
      curve.points.end.y,
      LINE_SMOOTHNESS,
    )
  }
  return gfx
}

export interface RelRenderState<R extends RelViewModel> {
  viewModel: R
  fromItem?: ItemViewModel
  toItem?: ItemViewModel
  isHighlighted: boolean
  theme: Theme
  scale: number
}

export class RelRenderer<R extends RelViewModel> extends TapestryElementRenderer<
  R,
  RelRenderState<R>
> {
  private line: Graphics
  private lineHighlightFrom: Graphics
  private lineHighlightTo: Graphics
  private fromArrowhead: Graphics
  private toArrowhead: Graphics

  constructor(store: Store<TapestryViewModel>, stage: TapestryStage, viewModel: R) {
    super(store, stage, viewModel)
    this.pixiContainer.zIndex = DEFAULT_REL_Z_INDEX
    this.line = new Graphics({ label: 'line', eventMode: 'auto' })
    this.pixiContainer.addChild(this.line)
    this.lineHighlightFrom = new Graphics({ label: 'line-highlight-from', eventMode: 'static' })
    this.pixiContainer.addChild(this.lineHighlightFrom)
    this.lineHighlightTo = new Graphics({ label: 'line-highlight-to', eventMode: 'static' })
    this.pixiContainer.addChild(this.lineHighlightTo)
    this.fromArrowhead = new Graphics({ label: 'from-arrowhead', eventMode: 'auto' })
    this.pixiContainer.addChild(this.fromArrowhead)
    this.toArrowhead = new Graphics({ label: 'to-arrowhead', eventMode: 'auto' })
    this.pixiContainer.addChild(this.toArrowhead)
  }

  protected computeRelCurvePoints(viewModel: R, items: IdMap<ItemViewModel>) {
    return computeRelCurvePoints(viewModel, items)
  }

  protected obtainRenderState(viewModel: R, store: Store<TapestryViewModel>): RelRenderState<R> {
    const { id, from, to } = viewModel.dto
    const { items } = store.get()
    const fromItem = items[from.itemId]
    const toItem = items[to.itemId]
    const isInteractive = id === store.get('interactiveElement.modelId')
    const pointerInteractionTarget = store.get('pointerInteraction.target')
    return {
      viewModel,
      fromItem,
      toItem,
      isHighlighted:
        isInteractive ||
        (isHoveredElement(pointerInteractionTarget) && pointerInteractionTarget.modelId === id),
      theme: THEMES[store.get('theme')],
      scale: store.get('viewport.transform.scale'),
    }
  }

  protected doRender(state: RelRenderState<R>, changedKeys: (keyof RelRenderState<R>)[]) {
    if (changedKeys.length === 1 && changedKeys[0] === 'isHighlighted') {
      // No need to redraw the paths, just update the highlights, if necessary
      this.lineHighlightFrom.alpha = this.lineHighlightTo.alpha = state.isHighlighted ? 0.1 : 0
      return
    }

    const { from, to, color, weight } = state.viewModel.dto

    this.line.clear()
    this.lineHighlightFrom.clear()
    this.lineHighlightTo.clear()
    this.fromArrowhead.clear()
    this.toArrowhead.clear()

    if (!state.fromItem || !state.toItem) return

    const curve = this.computeRelCurvePoints(state.viewModel, {
      [state.fromItem.dto.id]: state.fromItem,
      [state.toItem.dto.id]: state.toItem,
    })

    const arrowHeadSize = REL_ARROWHEAD_SIZES[weight]
    const lineStrokeWidth = Math.max(
      REL_LINE_WIDTHS[weight],
      MIN_LINE_STROKE_VISIBLE_WIDTH / state.scale,
    )

    // Instead of a single cubic Bezier curve, draw two quadratic Bezier curves joined in the middle.
    // This way we will have two separate segments of the curve and we will be able to handle
    // user interactions with them more easily.
    drawCurve(this.line, curve).stroke({ width: lineStrokeWidth, color, cap: 'square' })

    const highlightStrokeStyle: StrokeStyle = {
      width: 4 * lineStrokeWidth,
      color: 'white',
      cap: 'butt',
    }

    drawCurve(this.lineHighlightFrom, curve, 'head').stroke(highlightStrokeStyle)
    drawCurve(this.lineHighlightTo, curve, 'tail').stroke(highlightStrokeStyle)
    this.lineHighlightFrom.tint = this.lineHighlightTo.tint = color
    this.lineHighlightFrom.alpha = this.lineHighlightTo.alpha = state.isHighlighted ? 0.1 : 0

    if (from.arrowhead === 'arrow') {
      this.drawArrowhead(
        this.fromArrowhead,
        curve.from,
        curve.fromDirection,
        arrowHeadSize,
        color,
        lineStrokeWidth,
      )
    }

    if (to.arrowhead === 'arrow') {
      this.drawArrowhead(
        this.toArrowhead,
        curve.to,
        curve.toDirection,
        arrowHeadSize,
        color,
        lineStrokeWidth,
      )
    }
  }

  private drawArrowhead(
    graphics: Graphics,
    point: TapestryPoint,
    dir: Vector,
    size: number,
    color: string,
    strokeWidth: number,
  ) {
    const middle = translate(point, mul(strokeWidth / 2, dir))
    const midpoint = new Point(middle.x, middle.y)
    const direction = new Point(dir.dx, dir.dy)
    const degrees = Math.PI / 5
    const cos = Math.cos(degrees)
    const sin = Math.sin(degrees)
    const arrowCorner1 = midpoint.add(
      new Point(
        (direction.dot({ x: cos, y: sin }) * size) / cos,
        (direction.dot({ x: -sin, y: cos }) * size) / cos,
      ),
    )
    const arrowCorner2 = midpoint.add(
      new Point(
        (direction.dot({ x: cos, y: -sin }) * size) / cos,
        (direction.dot({ x: sin, y: cos }) * size) / cos,
      ),
    )

    graphics
      .moveTo(arrowCorner1.x, arrowCorner1.y)
      .lineTo(midpoint.x, midpoint.y)
      .lineTo(arrowCorner2.x, arrowCorner2.y)
      .stroke({
        color,
        cap: 'butt',
        join: 'miter',
        width: strokeWidth,
      })
  }
}
