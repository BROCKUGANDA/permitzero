/**
 * Intake form metadata per tool. Mirrors the API's per-tool argument schemas;
 * the server re-validates everything, so this is guidance, not enforcement.
 */
import type { SupportedTool } from '@permitzero/schemas';

export type FieldKind = 'text' | 'money' | 'currency' | 'integer' | 'textarea' | 'optional-text';

export interface ToolFieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  help?: string;
}

export interface ToolMeta {
  label: string;
  description: string;
  sideEffecting: boolean;
  fields: ToolFieldDef[];
}

export const TOOL_META: Record<SupportedTool, ToolMeta> = {
  'payment.execute': {
    label: 'Send payment',
    description: 'Move money to a vendor. Needs a permit; may need a human first.',
    sideEffecting: true,
    fields: [
      { name: 'invoice_id', label: 'Invoice', kind: 'text', placeholder: 'INV-2041' },
      { name: 'vendor_id', label: 'Vendor', kind: 'text', placeholder: 'VEN-017' },
      { name: 'amount_minor', label: 'Amount', kind: 'money', placeholder: '3000.00' },
      { name: 'currency', label: 'Currency', kind: 'currency', placeholder: 'USD' },
      { name: 'beneficiary_ref', label: 'Payout destination', kind: 'text', placeholder: 'BEN-017-VERIFIED' },
    ],
  },
  'payment.propose': {
    label: 'Propose payment',
    description: 'Draft a payment for review without moving money.',
    sideEffecting: false,
    fields: [
      { name: 'invoice_id', label: 'Invoice', kind: 'text', placeholder: 'INV-2041' },
      { name: 'vendor_id', label: 'Vendor', kind: 'text', placeholder: 'VEN-017' },
      { name: 'amount_minor', label: 'Amount', kind: 'money', placeholder: '3000.00' },
      { name: 'currency', label: 'Currency', kind: 'currency', placeholder: 'USD' },
      { name: 'beneficiary_ref', label: 'Payout destination', kind: 'text', placeholder: 'BEN-017-VERIFIED' },
    ],
  },
  'invoice.read': {
    label: 'Read invoice',
    description: 'Look up an invoice and its backing records.',
    sideEffecting: false,
    fields: [{ name: 'invoice_id', label: 'Invoice', kind: 'text', placeholder: 'INV-2041' }],
  },
  'purchase_order.read': {
    label: 'Read purchase order',
    description: 'Look up a purchase order.',
    sideEffecting: false,
    fields: [{ name: 'purchase_order_id', label: 'Purchase order', kind: 'text', placeholder: 'PO-882' }],
  },
  'vendor.read': {
    label: 'Read vendor',
    description: 'Look up a vendor profile and standing.',
    sideEffecting: false,
    fields: [{ name: 'vendor_id', label: 'Vendor', kind: 'text', placeholder: 'VEN-017' }],
  },
  'vendor.update_bank_details': {
    label: 'Change payout account',
    description: 'Point a vendor at a new destination. Always needs two humans plus outside verification.',
    sideEffecting: true,
    fields: [
      { name: 'vendor_id', label: 'Vendor', kind: 'text', placeholder: 'VEN-017' },
      { name: 'new_beneficiary_ref', label: 'New destination', kind: 'text', placeholder: 'BEN-017-NEW' },
      { name: 'reason', label: 'Reason', kind: 'textarea', placeholder: 'Why is this changing?' },
      {
        name: 'verification_ref',
        label: 'Verification reference (optional)',
        kind: 'optional-text',
        placeholder: 'Call log, letter date…',
      },
    ],
  },
  'vendor.export': {
    label: 'Export vendors',
    description: 'Bulk-export vendor records. Watched for exfiltration.',
    sideEffecting: true,
    fields: [
      { name: 'vendor_id', label: 'Single vendor (optional)', kind: 'optional-text', placeholder: 'Leave blank for all' },
      { name: 'record_limit', label: 'Record limit', kind: 'integer', placeholder: '1000' },
      { name: 'data_classification', label: 'Data classification', kind: 'text', placeholder: 'INTERNAL' },
    ],
  },
};

export const TOOL_ORDER: SupportedTool[] = [
  'payment.execute',
  'payment.propose',
  'vendor.update_bank_details',
  'vendor.export',
  'invoice.read',
  'purchase_order.read',
  'vendor.read',
];
