/**
 * Renders a "chart" cell: JSON data for TradingView Lightweight Charts.
 * Format: { "series": [{ "type": "line"|"area", "data": [{ "time": "2024-01-01", "value": 100 }, ...] }], "title"?: string }
 *
 * memo + IntersectionObserver gate: a chart mounts its canvas and internal
 * render loop only when scrolled near the viewport — a long chat with charts
 * offscreen pays nothing for them.
 */
import { memo, useRef, useEffect, useState } from "react";
import { useNearViewport } from "../lib/useNearViewport";

export interface ChartCellProps {
  content: string;
}

/** Model-authored JSON must not be able to freeze the feed. */
const MAX_SERIES = 12;
const MAX_POINTS_PER_SERIES = 20_000;

export const ChartCell = memo(function ChartCell({ content }: ChartCellProps) {
  const [viewRef, near] = useNearViewport<HTMLDivElement>();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<import("lightweight-charts").IChartApi | null>(null);
  const heightRef = useRef(320);
  const [error, setError] = useState<string | null>(null);

  // Two-pane/fold layouts resize the container; lightweight-charts needs an explicit resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width <= 0 || !chartRef.current) return;
      chartRef.current.applyOptions({ width: Math.round(box.width), height: heightRef.current });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    if (!containerRef.current || !content.trim()) return;
    chartRef.current = null;
    setError(null);
    try {
      const spec = JSON.parse(content) as {
        series?: { type?: string; data?: { time: string; value: number }[] }[];
        title?: string;
      };
      const seriesList = (Array.isArray(spec.series) ? spec.series : []).slice(0, MAX_SERIES);
      if (seriesList.length === 0) {
        setError("Нет данных для графика");
        return;
      }
      import("lightweight-charts")
        .then(({ createChart, LineSeries, AreaSeries }) => {
          if (!containerRef.current) return;
          chartRef.current = createChart(containerRef.current, {
            width: containerRef.current.clientWidth,
            height: 320,
            layout: { background: { color: "#252528" }, textColor: "#aaa" },
            grid: { vertLines: { color: "#3a3a3d" }, horzLines: { color: "#3a3a3d" } },
            rightPriceScale: { borderColor: "#3a3a3d" },
            timeScale: { borderColor: "#3a3a3d", timeVisible: true, secondsVisible: false },
          });
          const ch = chartRef.current;
          if (!ch) return;
          // One bad series (NaN value, bad time, huge set) must not kill the
          // whole chart — errors land in the fallback view, good series stay.
          for (const s of seriesList) {
            const data = (s.data ?? [])
              .slice(0, MAX_POINTS_PER_SERIES)
              .map((d) => ({ time: d.time, value: Number(d.value) }))
              .filter((d) => Number.isFinite(d.value) && d.time != null && d.time !== "");
            if (data.length === 0) continue;
            try {
              const isArea = (s.type || "line").toLowerCase() === "area";
              const series = ch.addSeries(isArea ? AreaSeries : LineSeries, {
                lineColor: "#c9c9ce",
                topColor: "rgba(201, 201, 206, 0.3)",
                bottomColor: "rgba(201, 201, 206, 0)",
                lineWidth: 2,
              });
              series.setData(data);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Неверные данные ряда");
            }
          }
          ch.timeScale().fitContent();
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Не удалось построить график"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Неверный JSON графика");
    }
    return () => {
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [content, near]);

  return (
    <div ref={viewRef}>
      {error ? (
        <div className="chat-cell-chart-fallback">График: {error}</div>
      ) : (
        <div ref={containerRef} className="chat-cell-chart" style={{ width: "100%", minHeight: 320 }} />
      )}
    </div>
  );
});
