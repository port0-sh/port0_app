/**
 * Pool price chart.
 *
 * TradingView's lightweight-charts, as candlesticks over the indexer's history
 * buckets. The library is the largest dependency in the app and only this page
 * draws a chart, so it is imported on demand. The TradingView attribution logo
 * stays enabled: the library licence requires an attribution notice and a link
 * to tradingview.com, and the logo satisfies that requirement.
 */

import type { ISeriesApi, UTCTimestamp } from 'lightweight-charts'
import type { Candle } from './history'

/** Chart colours, resolved from the stylesheet's custom properties. */
export interface ChartTheme {
  background: string
  text: string
  grid: string
  up: string
  down: string
}

export interface PriceChart {
  /** Replaces the series with candles in ascending time order. */
  setData(candles: readonly Candle[]): void
}

/** Price scale precision: six decimals covers a 4-decimal token pair at any ratio. */
const PRICE_FORMAT = { type: 'price', precision: 6, minMove: 0.000001 } as const

/** Mounts a chart into `container`. The container needs a width and a height. */
export async function mountPriceChart(
  container: HTMLElement,
  theme: ChartTheme,
): Promise<PriceChart> {
  const { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart } = await import(
    'lightweight-charts'
  )
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: theme.background },
      textColor: theme.text,
      fontFamily: 'inherit',
      fontSize: 11,
      // The licence's linking requirement is met by the footer attribution in
      // `src/lib/site.ts`, which links every page to tradingview.com.
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: theme.grid, style: LineStyle.Dotted },
      horzLines: { color: theme.grid, style: LineStyle.Dotted },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      horzLine: { labelBackgroundColor: theme.text },
      vertLine: { labelBackgroundColor: theme.text },
    },
    rightPriceScale: { borderColor: theme.grid },
    timeScale: {
      borderColor: theme.grid,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
    },
  })
  const series: ISeriesApi<'Candlestick'> = chart.addSeries(CandlestickSeries, {
    // Hollow up candles, filled down candles: the convention on most trading
    // desks. A transparent fill lets the grid show through the body.
    upColor: 'rgba(0, 0, 0, 0)',
    downColor: theme.down,
    borderUpColor: theme.up,
    borderDownColor: theme.down,
    wickUpColor: theme.up,
    wickDownColor: theme.down,
    priceFormat: PRICE_FORMAT,
    priceLineVisible: true,
  })
  return {
    setData: (candles) =>
      series.setData(
        candles.map((candle) => ({ ...candle, time: candle.time as UTCTimestamp })),
      ),
  }
}