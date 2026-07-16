import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { Booking } from './booking.entity';

/**
 * Generates a PDF receipt for a paid / completed booking.
 *
 * Returns a Buffer the controller streams with `Content-Disposition:
 * attachment`. pdfkit is purely synchronous Buffer-building (no network)
 * so a receipt renders in well under 50 ms — safe inline from the
 * request thread, no queue needed.
 */
@Injectable()
export class ReceiptService {
  // ─── Seller / legal details ──────────────────────────────────
  // Override via env once the business is GST-registered. Until then
  // these placeholders render clearly so the invoice is honest about
  // being from an unregistered supplier (no "Tax Invoice" claim, no
  // fabricated GSTIN). Set INVOICE_BUSINESS_NAME / INVOICE_BUSINESS_ADDRESS
  // / INVOICE_GSTIN in Railway to go live.
  private readonly bizName =
    process.env.INVOICE_BUSINESS_NAME || 'CookOnCall';
  private readonly bizAddress =
    process.env.INVOICE_BUSINESS_ADDRESS || 'Ahmedabad, Gujarat, India';
  private readonly gstin = process.env.INVOICE_GSTIN || '';

  /** Human invoice number derived from the booking id (stable, unique). */
  invoiceNumber(booking: Booking): string {
    return `INV-${booking.id.slice(0, 8).toUpperCase()}`;
  }

  /** Suggested attachment / download filename for this invoice. */
  fileName(booking: Booking): string {
    return `cookoncall-invoice-${booking.id.slice(0, 8)}.pdf`;
  }

  generate(booking: Booking): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 48,
          info: {
            Title: `CookOnCall Invoice ${this.invoiceNumber(booking)}`,
            Author: 'CookOnCall',
          },
        });

        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        this.renderHeader(doc);
        this.renderSeller(doc);
        this.renderMeta(doc, booking);
        this.renderItems(doc, booking);
        this.renderTotals(doc, booking);
        this.renderFooter(doc);

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  // ─── HEADER ───────────────────────────────────────────────────
  private renderHeader(doc: PDFKit.PDFDocument) {
    doc.fillColor('#E8520A').fontSize(24).text('CookOnCall', { align: 'left' });
    doc.fillColor('#666666').fontSize(10).text('Home chefs, on demand').moveDown(0.6);
    // Not a "Tax Invoice" — the supplier is not GST-registered yet, so we
    // avoid any claim that implies GST was collected.
    doc.fillColor('#3D2418').fontSize(18).text('Invoice').moveDown(0.3);
    doc.strokeColor('#E5E0D8').lineWidth(1)
      .moveTo(48, doc.y).lineTo(547, doc.y).stroke().moveDown(0.6);
  }

  // ─── SELLER / GST DETAILS ─────────────────────────────────────
  private renderSeller(doc: PDFKit.PDFDocument) {
    doc.fillColor('#3D2418').font('Helvetica-Bold').fontSize(10).text('From:');
    doc.font('Helvetica').fillColor('#3D2418').fontSize(10).text(this.bizName);
    doc.fillColor('#666666').fontSize(9).text(this.bizAddress);
    if (this.gstin) {
      doc.fillColor('#666666').fontSize(9).text(`GSTIN: ${this.gstin}`);
    } else {
      doc.fillColor('#999999').fontSize(8)
        .text('GST not applicable — supplier not registered under GST.');
    }
    doc.moveDown(0.6);
  }

  // ─── METADATA (booking id, date, customer, cook) ─────────────
  private renderMeta(doc: PDFKit.PDFDocument, b: Booking) {
    const fmt = (d: Date | string | null | undefined) =>
      d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

    const rows: [string, string][] = [
      ['Invoice No', this.invoiceNumber(b)],
      ['Invoice Date', fmt(new Date())],
      ['Booking ID', b.id.length >= 8 ? b.id.slice(0, 8).toUpperCase() : b.id.toUpperCase()],
      ['Status', this.prettyStatus(b.status)],
      ['Scheduled', fmt(b.scheduled_at)],
      ['Completed', fmt(b.completed_at)],
      ['Customer', b.user?.name || '—'],
      ['Chef', b.cook?.user?.name || '—'],
      ['Address', b.address || '—'],
    ];
    doc.fillColor('#3D2418').fontSize(10);
    rows.forEach(([k, v]) => {
      doc.font('Helvetica-Bold').text(`${k}:`, { continued: true, width: 120 })
        .font('Helvetica').text(`  ${v}`);
    });
    doc.moveDown(0.6);
  }

  // ─── DISH / PACKAGE LINE ITEMS ───────────────────────────────
  private renderItems(doc: PDFKit.PDFDocument, b: Booking) {
    doc.fillColor('#3D2418').font('Helvetica-Bold').fontSize(11).text('Items').moveDown(0.3);

    const orderItems = (b.order_items as Array<Record<string, unknown>> | undefined) ?? [];
    if (orderItems.length === 0 && !b.dishes) {
      doc.font('Helvetica').fillColor('#666666').fontSize(10)
        .text('No itemised line items recorded.').moveDown(0.6);
      return;
    }
    if (orderItems.length > 0) {
      doc.font('Helvetica').fillColor('#3D2418').fontSize(10);
      orderItems.forEach((it) => {
        const name = String(it.name ?? it.title ?? 'Item');
        const qty = Number(it.quantity ?? it.qty ?? 1);
        const price = Number(it.price ?? 0);
        doc.text(`${name} × ${qty}`, { continued: true })
          .text(`₹${(price * qty).toFixed(2)}`, { align: 'right' });
      });
    } else if (b.dishes) {
      doc.font('Helvetica').fillColor('#3D2418').fontSize(10).text(b.dishes);
    }
    doc.moveDown(0.6);
  }

  // ─── PRICE BREAKDOWN ─────────────────────────────────────────
  private renderTotals(doc: PDFKit.PDFDocument, b: Booking) {
    doc.strokeColor('#E5E0D8').lineWidth(1)
      .moveTo(48, doc.y).lineTo(547, doc.y).stroke().moveDown(0.4);

    const subtotal = Number(b.subtotal ?? 0);
    const visit = Number(b.visit_fee ?? 0);
    const platform = Number(b.platform_fee ?? 0);
    const total = Number(b.total_price ?? 0);

    const lines: [string, string][] = [
      ['Subtotal', `₹${subtotal.toFixed(2)}`],
      ['Visit fee', `₹${visit.toFixed(2)}`],
      ['Convenience fee (2.5%)', `₹${platform.toFixed(2)}`],
    ];
    doc.font('Helvetica').fillColor('#3D2418').fontSize(10);
    lines.forEach(([k, v]) => {
      doc.text(k, { continued: true }).text(v, { align: 'right' });
    });
    doc.moveDown(0.4);

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#E8520A')
      .text('Total paid', { continued: true })
      .text(`₹${total.toFixed(2)}`, { align: 'right' });
    doc.moveDown(0.6);
  }

  // ─── FOOTER ──────────────────────────────────────────────────
  private renderFooter(doc: PDFKit.PDFDocument) {
    doc.strokeColor('#E5E0D8').lineWidth(1)
      .moveTo(48, doc.y).lineTo(547, doc.y).stroke().moveDown(0.6);
    doc.fillColor('#999999').fontSize(8).font('Helvetica')
      .text(
        'Thank you for using CookOnCall. For support, email support@thecookoncall.com or call +91 90814 44326.',
        { align: 'center' },
      ).moveDown(0.3)
      .text(`Receipt generated on ${new Date().toLocaleString('en-IN')}.`, { align: 'center' });
  }

  private prettyStatus(s: string): string {
    return s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
}
