import type { Chart, Sheet } from './model';
import { Calc } from './model';

/**
 * Charts drawn as SVG from a range of cells: column, bar, line, area, pie, doughnut and scatter.
 * The same renderer draws on screen (dark or light) and into images for Excel files and printing.
 */

export const PALETTE = ['#8ab4f8', '#f28b82', '#fdd663', '#81c995', '#c58af9', '#78d9ec', '#fcad70', '#ff8bcb', '#a8dab5', '#d7aefb'];
export const PALETTE_LIGHT = ['#1a73e8', '#d93025', '#f9ab00', '#1e8e3e', '#9334e6', '#12b5cb', '#e8710a', '#e52592', '#188038', '#a142f4'];

export interface ChartData {
  categories: string[];
  xs: number[] | null; // numeric x values (scatter)
  series: { name: string; values: (number | null)[] }[];
}

const cellText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' && (v as any).code ? (v as any).code : String(v));

/** Read a chart's range into categories and series. */
export function chartData(chart: Chart, sheet: Sheet, calc: Calc): ChartData {
  const { r1, c1, r2, c2 } = chart.range;
  const grid: unknown[][] = [];
  for (let r = r1; r <= r2; r++) {
    const row: unknown[] = [];
    for (let c = c1; c <= c2; c++) row.push(calc.value(sheet, r, c));
    grid.push(row);
  }
  const byRows = chart.seriesBy === 'rows';
  const m = byRows ? grid : grid[0] ? grid[0].map((_, c) => grid.map((row) => row[c])) : [];
  // m: one array per potential series (columns by default).
  const header = chart.headerRow !== false && m.length > 0 && m.some((s) => typeof s[0] === 'string');
  const labels = chart.labelCol !== false && m.length > 1 && m[0].slice(header ? 1 : 0).some((v) => typeof v === 'string' || chart.type === 'scatter');
  const body = (s: unknown[]) => s.slice(header ? 1 : 0);
  const catSrc = labels ? body(m[0]) : null;
  const categories = catSrc ? catSrc.map(cellText) : body(m[labels ? 1 : 0] || []).map((_, i) => String(i + 1));
  const all = m.slice(labels ? 1 : 0).map((s, i) => ({
    name: header ? cellText(s[0]) || `Series ${i + 1}` : `Series ${i + 1}`,
    values: body(s).map((v) => (typeof v === 'number' ? v : null))
  }));
  // Text-only columns (like a "Group" column) aren't data to plot.
  const numeric = all.filter((s) => s.values.some((v) => v !== null));
  const series = numeric.length ? numeric : all;
  const xs = chart.type === 'scatter' && catSrc ? catSrc.map((v) => (typeof v === 'number' ? v : NaN)) : null;
  return { categories, xs, series };
}

function niceStep(range: number, ticks: number) {
  const raw = range / Math.max(1, ticks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}
function niceScale(min: number, max: number, ticks = 5) {
  if (min === max) {
    min = min > 0 ? 0 : min - 1;
    max = max > 0 ? max : max + 1;
  }
  const step = niceStep(max - min, ticks);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
  return { lo, hi, ticks: out };
}
const fmt = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v * 100) / 100);
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** SVG markup for a chart (used on screen and to make images). */
export function chartSvg(chart: Chart, data: ChartData, w: number, h: number, theme: 'dark' | 'light'): string {
  const dark = theme === 'dark';
  const ink = dark ? '#e3e3e3' : '#202124';
  const ink2 = dark ? '#9aa0a6' : '#5f6368';
  const grid = dark ? '#3c4043' : '#e0e0e0';
  const bg = dark ? '#1b1c1d' : '#ffffff';
  const colors = chart.colors?.length ? chart.colors : dark ? PALETTE : PALETTE_LIGHT;
  const font = `font-family="Inter, Segoe UI, Arial, sans-serif"`;
  const parts: string[] = [`<rect width="${w}" height="${h}" fill="${bg}"/>`];
  let top = 12;
  if (chart.title) {
    parts.push(`<text x="${w / 2}" y="26" text-anchor="middle" font-size="15" font-weight="600" fill="${ink}" ${font}>${esc(trunc(chart.title, 80))}</text>`);
    top = 40;
  }
  const pie = chart.type === 'pie' || chart.type === 'doughnut';
  const legendItems = pie ? data.categories : data.series.map((s) => s.name);
  const legend = chart.legend || (legendItems.length > 1 || pie ? 'bottom' : 'none');
  let right = w - 14;
  let bottom = h - 12;
  // Legend
  if (legend !== 'none' && legendItems.length) {
    if (legend === 'right') {
      const lw = Math.min(160, Math.max(...legendItems.map((s) => s.length)) * 7 + 28);
      right = w - lw - 8;
      legendItems.slice(0, 14).forEach((name, i) => {
        const y = top + 8 + i * 20;
        parts.push(`<rect x="${right + 14}" y="${y - 9}" width="10" height="10" rx="2" fill="${colors[i % colors.length]}"/><text x="${right + 30}" y="${y}" font-size="12" fill="${ink2}" ${font}>${esc(trunc(name, 18))}</text>`);
      });
    } else {
      const items = legendItems.slice(0, 12).map((n) => trunc(n, 20));
      const widths = items.map((n) => n.length * 6.6 + 28);
      const total = widths.reduce((a, b) => a + b, 0);
      let x = Math.max(10, (w - total) / 2);
      const y = legend === 'top' ? top + 6 : h - 14;
      items.forEach((name, i) => {
        parts.push(`<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${colors[i % colors.length]}"/><text x="${x + 15}" y="${y}" font-size="12" fill="${ink2}" ${font}>${esc(name)}</text>`);
        x += widths[i];
      });
      if (legend === 'top') top += 24;
      else bottom -= 24;
    }
  }

  if (pie) {
    const vals = (data.series[0]?.values || []).map((v) => Math.max(0, v || 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = (right + 14) / 2;
    const cy = (top + bottom) / 2;
    const r = Math.max(10, Math.min(right - 14, bottom - top) / 2 - 8);
    const inner = chart.type === 'doughnut' ? r * 0.58 : 0;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rr: number, a: number) => `${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`;
      const d =
        v / total >= 0.9999
          ? `M ${cx - r},${cy} A ${r},${r} 0 1 1 ${cx + r},${cy} A ${r},${r} 0 1 1 ${cx - r},${cy} ${inner ? `M ${cx - inner},${cy} A ${inner},${inner} 0 1 0 ${cx + inner},${cy} A ${inner},${inner} 0 1 0 ${cx - inner},${cy}` : ''} Z`
          : inner
            ? `M ${p(r, a0)} A ${r},${r} 0 ${large} 1 ${p(r, a1)} L ${p(inner, a1)} A ${inner},${inner} 0 ${large} 0 ${p(inner, a0)} Z`
            : `M ${cx},${cy} L ${p(r, a0)} A ${r},${r} 0 ${large} 1 ${p(r, a1)} Z`;
      parts.push(`<path d="${d}" fill="${colors[i % colors.length]}" stroke="${bg}" stroke-width="1.5" fill-rule="evenodd"/>`);
      if (v / total > 0.04) {
        const mid = (a0 + a1) / 2;
        const lr = inner ? (r + inner) / 2 : r * 0.66;
        parts.push(`<text x="${cx + lr * Math.cos(mid)}" y="${cy + lr * Math.sin(mid) + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#111" ${font}>${chart.showValues ? esc(fmt(v)) : Math.round((v / total) * 100) + '%'}</text>`);
      }
      a0 = a1;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
  }

  const horizontal = chart.type === 'bar';
  const stacked = !!chart.stacked && (chart.type === 'column' || chart.type === 'bar' || chart.type === 'area');
  const n = data.categories.length;
  let min = 0;
  let max = 0;
  if (stacked) {
    for (let i = 0; i < n; i++) {
      let pos = 0,
        neg = 0;
      for (const s of data.series) {
        const v = s.values[i] || 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      max = Math.max(max, pos);
      min = Math.min(min, neg);
    }
  } else
    for (const s of data.series)
      for (const v of s.values)
        if (v !== null) {
          max = Math.max(max, v);
          min = Math.min(min, v);
        }
  if (chart.type === 'line' || chart.type === 'scatter') {
    const all = data.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    if (all.length) {
      min = Math.min(...all);
      max = Math.max(...all);
      if (min > 0 && min < max * 0.5) min = 0;
    }
  }
  const scale = niceScale(min, max);
  const axisW = horizontal ? Math.min(120, Math.max(...data.categories.map((c) => c.length), 1) * 6.5 + 12) : Math.max(...scale.ticks.map((t) => fmt(t).length)) * 7 + 14;
  const left = 10 + axisW + (chart.yTitle ? 18 : 0);
  if (chart.xTitle) bottom -= 18;
  const plotBottom = bottom - (horizontal ? 18 : 22);
  const plotTop = top + 6;
  const plotW = Math.max(10, right - left);
  const plotH = Math.max(10, plotBottom - plotTop);
  const val = (v: number) => (v - scale.lo) / (scale.hi - scale.lo || 1);

  // Grid and value axis
  for (const t of scale.ticks) {
    if (horizontal) {
      const x = left + val(t) * plotW;
      parts.push(`<line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}" stroke="${grid}"/><text x="${x}" y="${plotBottom + 14}" text-anchor="middle" font-size="11" fill="${ink2}" ${font}>${fmt(t)}</text>`);
    } else {
      const y = plotBottom - val(t) * plotH;
      parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${grid}"/><text x="${left - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="${ink2}" ${font}>${fmt(t)}</text>`);
    }
  }
  if (chart.yTitle) parts.push(`<text transform="translate(14 ${(plotTop + plotBottom) / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="${ink2}" ${font}>${esc(chart.yTitle)}</text>`);
  if (chart.xTitle) parts.push(`<text x="${left + plotW / 2}" y="${bottom + 12}" text-anchor="middle" font-size="12" fill="${ink2}" ${font}>${esc(chart.xTitle)}</text>`);

  const zero = val(Math.max(scale.lo, Math.min(0, scale.hi)));
  if (chart.type === 'scatter') {
    const xs = data.xs && data.xs.some((x) => !isNaN(x)) ? data.xs : data.categories.map((_, i) => i + 1);
    const xv = xs.filter((x) => !isNaN(x));
    const xsScale = niceScale(Math.min(...xv), Math.max(...xv));
    const xval = (x: number) => (x - xsScale.lo) / (xsScale.hi - xsScale.lo || 1);
    for (const t of xsScale.ticks) parts.push(`<text x="${left + xval(t) * plotW}" y="${plotBottom + 16}" text-anchor="middle" font-size="11" fill="${ink2}" ${font}>${fmt(t)}</text>`);
    data.series.forEach((s, si) =>
      s.values.forEach((v, i) => {
        if (v === null || isNaN(xs[i])) return;
        parts.push(`<circle cx="${left + xval(xs[i]) * plotW}" cy="${plotBottom - val(v) * plotH}" r="4" fill="${colors[si % colors.length]}" fill-opacity="0.85"/>`);
      })
    );
  } else {
    // Category axis labels
    const band = (horizontal ? plotH : plotW) / Math.max(1, n);
    const every = Math.max(1, Math.ceil((horizontal ? 16 : 60) / band));
    data.categories.forEach((c, i) => {
      if (i % every) return;
      if (horizontal) parts.push(`<text x="${left - 6}" y="${plotTop + band * (i + 0.5) + 4}" text-anchor="end" font-size="11" fill="${ink2}" ${font}>${esc(trunc(c, 18))}</text>`);
      else parts.push(`<text x="${left + band * (i + 0.5)}" y="${plotBottom + 16}" text-anchor="middle" font-size="11" fill="${ink2}" ${font}>${esc(trunc(c, Math.max(4, Math.floor((band * every) / 7))))}</text>`);
    });
    if (chart.type === 'column' || chart.type === 'bar') {
      const groups = stacked ? 1 : data.series.length;
      const inner = band * 0.72;
      const bw = inner / Math.max(1, groups);
      const acc = new Array(n).fill(0).map(() => ({ pos: 0, neg: 0 }));
      data.series.forEach((s, si) => {
        s.values.forEach((v, i) => {
          if (v === null) return;
          let a: number, b: number;
          if (stacked) {
            const base = v >= 0 ? acc[i].pos : acc[i].neg;
            a = val(base);
            b = val(base + v);
            if (v >= 0) acc[i].pos += v;
            else acc[i].neg += v;
          } else {
            a = zero;
            b = val(v);
          }
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const off = band * i + (band - inner) / 2 + (stacked ? 0 : bw * si);
          const color = colors[si % colors.length];
          if (horizontal) parts.push(`<rect x="${left + lo * plotW}" y="${plotTop + off}" width="${Math.max(1, (hi - lo) * plotW)}" height="${Math.max(1, bw - 2)}" rx="2" fill="${color}"/>`);
          else parts.push(`<rect x="${left + off}" y="${plotBottom - hi * plotH}" width="${Math.max(1, bw - 2)}" height="${Math.max(1, (hi - lo) * plotH)}" rx="2" fill="${color}"/>`);
          if (chart.showValues && !stacked) {
            if (horizontal) parts.push(`<text x="${left + hi * plotW + 4}" y="${plotTop + off + bw / 2 + 3}" font-size="10" fill="${ink2}" ${font}>${fmt(v)}</text>`);
            else parts.push(`<text x="${left + off + bw / 2 - 1}" y="${plotBottom - hi * plotH - 4}" text-anchor="middle" font-size="10" fill="${ink2}" ${font}>${fmt(v)}</text>`);
          }
        });
      });
    } else {
      // Line and area
      const acc = new Array(n).fill(0);
      data.series.forEach((s, si) => {
        const color = colors[si % colors.length];
        const pts: [number, number][] = [];
        const basePts: [number, number][] = [];
        s.values.forEach((v, i) => {
          if (v === null) return;
          const x = left + band * (i + 0.5);
          const base = stacked ? acc[i] : 0;
          const top = stacked ? base + v : v;
          if (stacked) acc[i] = top;
          pts.push([x, plotBottom - val(top) * plotH]);
          basePts.push([x, plotBottom - val(stacked ? base : Math.max(scale.lo, 0)) * plotH]);
        });
        if (!pts.length) return;
        const path = (p: [number, number][]) => {
          if (!chart.smooth || p.length < 3) return p.map((q, i) => `${i ? 'L' : 'M'} ${q[0]},${q[1]}`).join(' ');
          let d = `M ${p[0][0]},${p[0][1]}`;
          for (let i = 0; i < p.length - 1; i++) {
            const p0 = p[i - 1] || p[i];
            const p1 = p[i];
            const p2 = p[i + 1];
            const p3 = p[i + 2] || p2;
            d += ` C ${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
          }
          return d;
        };
        if (chart.type === 'area') {
          const back = [...basePts].reverse();
          parts.push(`<path d="${path(pts)} L ${back.map((q) => `${q[0]},${q[1]}`).join(' L ')} Z" fill="${color}" fill-opacity="0.35"/>`);
        }
        parts.push(`<path d="${path(pts)}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
        if (pts.length <= 40) pts.forEach(([x, y]) => parts.push(`<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`));
        if (chart.showValues) s.values.forEach((v, i) => v !== null && pts[i] && parts.push(`<text x="${pts[i][0]}" y="${pts[i][1] - 8}" text-anchor="middle" font-size="10" fill="${ink2}" ${font}>${fmt(v)}</text>`));
      });
    }
  }
  // Axis line
  if (horizontal) parts.push(`<line x1="${left + zero * plotW}" y1="${plotTop}" x2="${left + zero * plotW}" y2="${plotBottom}" stroke="${ink2}"/>`);
  else parts.push(`<line x1="${left}" y1="${plotBottom - zero * plotH}" x2="${right}" y2="${plotBottom - zero * plotH}" stroke="${ink2}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}

/** PNG of a chart (light theme), for Excel files and printing. */
export async function chartPng(svg: string, w: number, h: number, scale = 2): Promise<Uint8Array> {
  // Wait for the load event rather than img.decode(): decode() can fail on SVGs while other work is running.
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Chart image could not be drawn'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  canvas.getContext('2d')!.drawImage(img, 0, 0, w * scale, h * scale);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('chart image failed'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
