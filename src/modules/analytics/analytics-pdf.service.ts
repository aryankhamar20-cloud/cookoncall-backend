import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics.dto';

/**
 * Analytics Phase 3 — PDF report generator.
 *
 * Reuses the same query layer (`AnalyticsService`) that powers the
 * Recharts dashboard, so the numbers in a PDF and the numbers in the
 * web UI are guaranteed identical.
 *
 * Why pdfkit and not headless Chrome / puppeteer?
 * ────────────────────────────────────────────────
 * - We already use pdfkit for booking receipts (Round 2). One library
 *   to maintain, one set of fonts to ship.
 * - Synchronous Buffer-building means we can stream the PDF in the
 *   same request without spawning a sub-process. Fits Railway's
 *   shared-CPU pricing.
 * - We don't render charts in the PDF — for an exec-facing summary,
 *   tables of numbers + KPI tiles read better than tiny chart PNGs.
 *   Web users who want chart screenshots can use the live dashboard.
 *
 * Layout
 * ──────
 *   • Cover header: CookOnCall · Analytics Report · range
 *   • KPI block (8 tiles, 4-up grid)
 *   • Top chefs table (10 rows)
 *   • Top cities table
 *   • Bookings funnel summary
 *   • Footer: generated-at + URL of the live dashboard
 */
@Injectable()
export class AnalyticsPdfService {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * Build a Buffer containing the PDF. Caller is responsible for
   * sending the right Content-Type / Content-Disposition headers.
   *
   * `metric` is currently 'overview' only — the API leaves room for
   * future per-metric PDFs (revenue-only, top-chefs-only).
   */
  async buildOverviewPdf(dto: AnalyticsQueryDto): Promise<Buffer> {
    // Pull every section in parallel — same pattern as the web panel.
    // Failure of any single query is non-fatal: we render an "n/a"
    // for that section rather than blowing up the whole PDF.
    const [overview, chefs, locations] = await Promise.all([
      this.analytics.overview(dto).catch((): null => null),
      this.analytics.chefs(dto).catch((): null => null),
      this.analytics.locations(dto).catch((): null => null),
    ]);

    return new Promise<Buffer>((resolve) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        bufferPages: true,
        info: {
          Title: 'CookOnCall Analytics Report',
          Author: 'CookOnCall',
          Subject: `Analytics ${dto?.from ?? ''} → ${dto?.to ?? ''}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      this.renderHeader(doc, overview);
      this.renderKpis(doc, overview);
      this.renderTopChefs(doc, chefs);
      this.renderTopCities(doc, locations);
      this.renderFooter(doc);

      doc.end();
    });
  }

  // ─── Sections ────────────────────────────────────────

  private renderHeader(doc: PDFKit.PDFDocument, overview: any) {
    // Brand wordmark in the platform's accent orange.
    doc
      .fillColor('#D4721A')
      .fontSize(22)
      .font('Helvetica-Bold')
      .text('CookOnCall', { continued: false });

    doc
      .fillColor('#5D4E37')
      .fontSize(12)
      .font('Helvetica')
      .text('Analytics Report')
      .moveDown(0.3);

    const range = overview?.range;
    if (range) {
      const fromLabel = formatDate(range.from);
      const toLabel = formatDate(range.to);
      doc
        .fillColor('#8B7355')
        .fontSize(10)
        .text(`${fromLabel} — ${toLabel}  ·  ${range.days} days`);
    }

    doc.moveDown(0.5);
    this.divider(doc);
  }

  private renderKpis(doc: PDFKit.PDFDocument, overview: any) {
    doc.moveDown(0.5);
    doc
      .fillColor('#3D2418')
      .fontSize(14)
      .font('Helvetica-Bold')
      .text('Key metrics');
    doc.moveDown(0.4);

    if (!overview) {
      doc.fillColor('#9CA3AF').fontSize(10).text('Overview unavailable.');
      return;
    }

    // Build the eight KPI tiles. Layout: 4 columns × 2 rows.
    const tiles: { label: string; value: string }[] = [
      { label: 'Total users',     value: fmt(overview.users?.total) },
      { label: 'DAU',             value: fmt(overview.users?.dau) },
      { label: 'Active chefs',    value: fmt(overview.cooks?.active_now) },
      { label: 'Bookings',        value: fmt(overview.bookings?.total) },
      { label: 'GMV',             value: rupees(overview.revenue?.gmv ?? overview.revenue?.gross_revenue) },
      { label: 'Net revenue',     value: rupees(overview.revenue?.platform_commission) },
      { label: 'Avg order value', value: rupees(overview.revenue?.avg_order_value) },
      { label: 'Cancel rate',     value: pct(overview.bookings?.cancel_rate_percent) },
    ];

    const colW = (doc.page.width - 80) / 4;
    const rowH = 56;
    const startY = doc.y;
    tiles.forEach((t, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const x = 40 + col * colW;
      const y = startY + row * rowH;

      // Tile box
      doc
        .roundedRect(x, y, colW - 8, rowH - 8, 6)
        .fillAndStroke('#FFF7ED', '#F2D9B6');

      doc
        .fillColor('#8B7355')
        .fontSize(8)
        .font('Helvetica')
        .text(t.label.toUpperCase(), x + 8, y + 8, { width: colW - 24 });

      doc
        .fillColor('#3D2418')
        .fontSize(15)
        .font('Helvetica-Bold')
        .text(t.value, x + 8, y + 22, { width: colW - 24 });
    });
    doc.y = startY + rowH * 2 + 4;
  }

  private renderTopChefs(doc: PDFKit.PDFDocument, chefs: any) {
    doc.moveDown(0.6);
    this.divider(doc);
    doc.moveDown(0.4);
    doc
      .fillColor('#3D2418')
      .fontSize(14)
      .font('Helvetica-Bold')
      .text('Top chefs');
    doc.moveDown(0.3);

    const rows: any[] = chefs?.top_chefs ?? chefs ?? [];
    if (!Array.isArray(rows) || rows.length === 0) {
      doc.fillColor('#9CA3AF').fontSize(10).font('Helvetica').text('No chef data for this range.');
      return;
    }

    this.renderTable(doc, ['#', 'Chef', 'Bookings', 'Revenue'], [70, 220, 90, 120], (idx) => {
      const r = rows[idx];
      if (!r) return null;
      return [
        String(idx + 1),
        r.name ?? r.cook_name ?? '—',
        fmt(r.completed_bookings ?? r.bookings ?? 0),
        rupees(r.revenue ?? r.gross ?? 0),
      ];
    }, Math.min(rows.length, 10));
  }

  private renderTopCities(doc: PDFKit.PDFDocument, locations: any) {
    doc.moveDown(0.6);
    this.divider(doc);
    doc.moveDown(0.4);
    doc
      .fillColor('#3D2418')
      .fontSize(14)
      .font('Helvetica-Bold')
      .text('Top cities');
    doc.moveDown(0.3);

    const rows: any[] = locations?.top_cities ?? locations?.cities ?? [];
    if (!Array.isArray(rows) || rows.length === 0) {
      doc.fillColor('#9CA3AF').fontSize(10).font('Helvetica').text('No location data for this range.');
      return;
    }

    this.renderTable(doc, ['#', 'City', 'Bookings'], [70, 280, 130], (idx) => {
      const r = rows[idx];
      if (!r) return null;
      return [
        String(idx + 1),
        r.city ?? r.name ?? '—',
        fmt(r.bookings ?? r.count ?? 0),
      ];
    }, Math.min(rows.length, 10));
  }

  private renderFooter(doc: PDFKit.PDFDocument) {
    // Place footer at the bottom of every page.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.height - 40;
      doc
        .fillColor('#9CA3AF')
        .fontSize(8)
        .font('Helvetica')
        .text(
          `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST  ·  thecookoncall.com/dashboard/admin`,
          40,
          bottom,
          { width: doc.page.width - 80, align: 'center' },
        );
    }
  }

  // ─── Helpers ────────────────────────────────────────

  private divider(doc: PDFKit.PDFDocument) {
    const y = doc.y;
    doc
      .moveTo(40, y)
      .lineTo(doc.page.width - 40, y)
      .strokeColor('#F2D9B6')
      .lineWidth(0.5)
      .stroke();
  }

  /**
   * Mini table builder. Splits the available width across the column
   * widths and writes header + N rows. Doesn't paginate — caller
   * shouldn't pass huge tables. Safe for our 10-row top-N use case.
   */
  private renderTable(
    doc: PDFKit.PDFDocument,
    headers: string[],
    widths: number[],
    rowFn: (i: number) => string[] | null,
    rowCount: number,
  ) {
    const startX = 40;
    let y = doc.y;
    const lineHeight = 18;

    // Header
    let x = startX;
    headers.forEach((h, i) => {
      doc
        .fillColor('#8B7355')
        .fontSize(8)
        .font('Helvetica-Bold')
        .text(h.toUpperCase(), x + 4, y + 4, { width: widths[i] - 8 });
      x += widths[i];
    });
    doc
      .moveTo(startX, y + lineHeight)
      .lineTo(startX + widths.reduce((a, b) => a + b, 0), y + lineHeight)
      .strokeColor('#F2D9B6')
      .lineWidth(0.5)
      .stroke();
    y += lineHeight + 2;

    // Rows
    for (let i = 0; i < rowCount; i++) {
      const cells = rowFn(i);
      if (!cells) break;
      x = startX;
      cells.forEach((c, j) => {
        doc
          .fillColor('#3D2418')
          .fontSize(10)
          .font('Helvetica')
          .text(c, x + 4, y + 4, { width: widths[j] - 8 });
        x += widths[j];
      });
      y += lineHeight;
    }
    doc.y = y + 4;
  }
}

// ─── Pure formatting helpers ───────────────────────────

function fmt(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN');
}

function rupees(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '—';
  return `\u20B9${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function pct(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
