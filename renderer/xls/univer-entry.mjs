// Univer entry — bundled offline by scripts/build-xls-viewer.mjs (esbuild).
// Exposes window.XLSViewer.mount(container, sheets) / dispose().
// Renders the uploaded spreadsheet as close to the original as possible:
// real merges, auto-fitted column widths, text wrapping, row heights, alignment.
// If this bundle is missing (offline / not built), app.js falls back to the built-in Excel table.
import { createUniver, defaultTheme, LocaleType, merge } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/presets/preset-sheets-core'
import sheetsCoreRuRU from '@univerjs/presets/preset-sheets-core/locales/ru-RU'
import '@univerjs/presets/lib/styles/preset-sheets-core.css'
import { WrapStrategy, HorizontalAlign, VerticalAlign } from '@univerjs/core'

let current = null

const CHAR_PX = 6.6        // approx width of one char at 11px Arial
const LINE_PX = 17         // approx height of one wrapped line
const COL_MIN = 40, COL_MAX = 340
const ROW_MIN = 22, ROW_MAX = 420

function toNum(s) {
  const t = String(s).trim().replace(/[\s\u00a0]/g, '')
  if (/^-?\d+(?:[.,]\d+)?$/.test(t)) return parseFloat(t.replace(',', '.'))
  return null
}
function longestLine(str) {
  let mx = 0
  String(str).split('\n').forEach(seg => { if (seg.length > mx) mx = seg.length })
  return mx
}
function mapH(h) { return h === 'center' ? HorizontalAlign.CENTER : h === 'right' ? HorizontalAlign.RIGHT : HorizontalAlign.LEFT }
function mapV(v) { return v === 'top' ? VerticalAlign.TOP : v === 'bottom' ? VerticalAlign.BOTTOM : VerticalAlign.MIDDLE }

function buildSheet(s, i) {
  const rows = s.rows || []
  let ncol = 0
  rows.forEach(r => { if (r.length > ncol) ncol = r.length })
  ncol = Math.max(ncol, 1)
  const nrow = rows.length
  const styles = s.styles || {}

  // Map merges: covered cells + span info keyed by origin.
  const covered = {}, span = {}
  ;(s.merges || []).forEach(m => {
    span[m.r + ':' + m.c] = { rs: m.rs, cs: m.cs }
    for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.cs; c++) { if (r === m.r && c === m.c) continue; covered[r + ':' + c] = 1 }
  })

  // --- Column widths: prefer the file's widths, otherwise auto-fit to content ---
  const fileW = s.colWidths || []
  const colW = new Array(ncol).fill(0)
  for (let c = 0; c < ncol; c++) {
    let contentMax = 0
    for (let r = 0; r < nrow; r++) {
      if (covered[r + ':' + c]) continue
      const sp = span[r + ':' + c]
      if (sp && sp.cs > 1) continue // spanning cells don't dictate a single column width
      const v = (rows[r] && rows[r][c] != null) ? String(rows[r][c]) : ''
      if (!v) continue
      const w = longestLine(v) * CHAR_PX + 14
      if (w > contentMax) contentMax = w
    }
    let w = Math.max(fileW[c] || 0, contentMax)
    if (!w) w = 60
    colW[c] = Math.round(Math.max(COL_MIN, Math.min(w, COL_MAX)))
  }

  // --- Cell data + styles ---
  const cellData = {}
  for (let r = 0; r < nrow; r++) {
    for (let c = 0; c < ncol; c++) {
      if (covered[r + ':' + c]) continue
      const raw = (rows[r] && rows[r][c] != null) ? String(rows[r][c]) : ''
      if (raw === '') continue
      const n = toNum(raw)
      const st = styles[r + ':' + c] || {}
      const style = { tb: WrapStrategy.WRAP, vt: mapV(st.v || 'top') }
      style.ht = st.h ? mapH(st.h) : (n != null ? HorizontalAlign.RIGHT : HorizontalAlign.LEFT)
      if (st.b) style.bl = 1
      if (!cellData[r]) cellData[r] = {}
      cellData[r][c] = { v: raw, s: style }
    }
  }

  // --- Row heights: fit wrapped text given final column widths (respect merges) ---
  const fileH = s.rowHeights || []
  const rowData = {}
  for (let r = 0; r < nrow; r++) {
    let lines = 1
    for (let c = 0; c < ncol; c++) {
      if (covered[r + ':' + c]) continue
      const v = (rows[r] && rows[r][c] != null) ? String(rows[r][c]) : ''
      if (!v) continue
      const sp = span[r + ':' + c]
      let avail = colW[c]
      if (sp && sp.cs > 1) { avail = 0; for (let cc = c; cc < c + sp.cs && cc < ncol; cc++) avail += colW[cc] }
      const cap = Math.max(1, Math.floor((avail - 10) / CHAR_PX))
      let need = 0
      v.split('\n').forEach(seg => { need += Math.max(1, Math.ceil(seg.length / cap)) })
      // merged rows spread their height across spanned rows
      if (sp && sp.rs > 1) need = Math.ceil(need / sp.rs)
      if (need > lines) lines = need
    }
    let h = lines * LINE_PX + 6
    if (fileH[r]) h = Math.max(h, fileH[r])
    rowData[r] = { h: Math.round(Math.max(ROW_MIN, Math.min(h, ROW_MAX))) }
  }

  const columnData = {}
  for (let c = 0; c < ncol; c++) columnData[c] = { w: colW[c] }

  const mergeData = (s.merges || []).map(m => ({ startRow: m.r, startColumn: m.c, endRow: m.r + m.rs - 1, endColumn: m.c + m.cs - 1 }))

  return {
    id: 'sheet_' + i,
    name: s.name || ('Лист ' + (i + 1)),
    rowCount: Math.max(nrow + 8, 60),
    columnCount: Math.max(ncol + 3, 20),
    cellData,
    mergeData,
    rowData,
    columnData,
    defaultColumnWidth: 80,
    defaultRowHeight: 22,
  }
}

function toWorkbook(sheets) {
  const sheetOrder = []
  const sh = {}
  ;(sheets || []).forEach((s, i) => { const w = buildSheet(s, i); sheetOrder.push(w.id); sh[w.id] = w })
  if (!sheetOrder.length) { sheetOrder.push('sheet_0'); sh['sheet_0'] = { id: 'sheet_0', name: 'Лист 1', rowCount: 40, columnCount: 12, cellData: {} } }
  return { id: 'wb_' + Date.now(), name: 'Документ', sheetOrder, sheets: sh }
}

export function mount(container, sheets) {
  dispose()
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.RU_RU,
    locales: { [LocaleType.RU_RU]: merge({}, sheetsCoreRuRU) },
    theme: defaultTheme,
    presets: [UniverSheetsCorePreset({ container })],
  })
  univerAPI.createWorkbook(toWorkbook(sheets))
  current = univer
}

export function dispose() {
  if (current) { try { current.dispose() } catch (e) {} current = null }
}

window.XLSViewer = { mount, dispose }
