// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Render a "chart" cell: JSON data for TradingView Lightweight Charts.
 * Format: { "series": [{ "type": "line"|"area", "data": [{ "time": "2024-01-01", "value": 100 }, ...] }], "title"?: string }
 */
import { useRef, useEffect, useState } from "react";
import { useT } from "../i18n";

export interface ChartCellProps {
  content: string;
}

export function ChartCell({ content }: ChartCellProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  const chartRef = useRef<import("lightweight-charts").IChartApi | null>(null);
  useEffect(() => {
    if (!containerRef.current || !content.trim()) return;
    chartRef.current = null;
    setError(null);
    try {
      const spec = JSON.parse(content) as {
        series?: { type?: string; data?: { time: string; value: number }[] }[];
        title?: string;
      };
      const seriesList = Array.isArray(spec.series) ? spec.series : [];
      if (seriesList.length === 0) {
        setError(t("chart.noData"));
        return;
      }
      import("lightweight-charts").then(({ createChart, LineSeries, AreaSeries }) => {
        if (!containerRef.current) return;
        chartRef.current = createChart(containerRef.current, {
          width: containerRef.current.clientWidth,
          height: 320,
          layout: { background: { color: "#fff" }, textColor: "#333" },
          grid: { vertLines: { color: "#eee" }, horzLines: { color: "#eee" } },
          rightPriceScale: { borderColor: "#ccc" },
          timeScale: { borderColor: "#ccc", timeVisible: true, secondsVisible: false },
        });
        const ch = chartRef.current;
        if (!ch) return;
        seriesList.forEach((s) => {
          const data = (s.data ?? []).map((d) => ({
            time: d.time,
            value: Number(d.value),
          }));
          if (data.length === 0) return;
          const isArea = (s.type || "line").toLowerCase() === "area";
          const series = ch.addSeries(isArea ? AreaSeries : LineSeries, {
            lineColor: "rgb(75, 192, 192)",
            topColor: "rgba(75, 192, 192, 0.4)",
            bottomColor: "rgba(75, 192, 192, 0)",
            lineWidth: 2,
          });
          series.setData(data);
        });
        ch.timeScale().fitContent();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("chart.invalidJson"));
    }
    return () => {
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [content, t]);

  if (error) {
    return <div className="chat-cell-chart-fallback">{t("chart.prefix", { error })}</div>;
  }
  return <div ref={containerRef} className="chat-cell-chart" style={{ width: "100%", minHeight: 320 }} />;
}
