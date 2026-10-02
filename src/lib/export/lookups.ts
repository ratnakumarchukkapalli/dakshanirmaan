import { collect, readPaged } from './paged';
import type { ExportContext } from './types';

// Small master tables read once per export and shared by every sheet that names an account, a party,
// a warehouse, an item, a person or a document number. Posted documents snapshot item names, HSN and
// tax; parties, accounts and warehouses are shown by their name in the master as of the export.

type Reader = Pick<ExportContext, 'supabase' | 'asOf' | 'fy'>;

export interface PartyRow {
  id: string; name: string; type: string; gstin: string | null; state_code: string; phone: string | null; whatsapp_phone: string | null;
  credit_limit: string; credit_days: number; interest_rate_pm: string | null; is_active: boolean; is_walk_in: boolean; created_at: string;
}
export interface AccountRow { id: string; code: string; name: string; type: string; parent_id: string | null; system_key: string | null; is_group: boolean; is_control: boolean; is_money: boolean }
export interface WarehouseRow { id: string; name: string; address: unknown; is_default: boolean; is_transit: boolean }
export interface ItemRow {
  id: string; name: string; brand: string | null; category: string; hsn_code: string; gst_rate: string; base_uom: string; alt_uom: string | null;
  conversion_factor: string | null; reorder_level: string; sale_rate: string; is_active: boolean; is_stock: boolean;
}

/** Address JSON ({line1, line2, city, district, pincode}) as one line of text. */
export function addressText(address: unknown): string | null {
  if (!address || typeof address !== 'object') return null;
  const a = address as Record<string, unknown>;
  const known = ['line1', 'line2', 'city', 'district', 'pincode'];
  const parts = [...known, ...Object.keys(a).filter((k) => !known.includes(k))].map((k) => a[k]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return parts.length > 0 ? parts.join(', ') : null;
}

export class Lookups {
  private memo = new Map<string, Promise<unknown>>();
  constructor(private readonly ctx: Reader) {}

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.memo.set(key, p);
    }
    return p;
  }

  partyRows() {
    return this.once('partyRows', () => collect(readPaged<PartyRow>(this.ctx, {
      from: 'parties',
      select: 'id, name, type, gstin, state_code, phone, whatsapp_phone, credit_limit::text, credit_days, interest_rate_pm::text, is_active, is_walk_in, created_at',
      order: ['name', 'id'],
    })));
  }

  async parties(): Promise<Map<string, PartyRow>> {
    return this.once('parties', async () => new Map((await this.partyRows()).map((p) => [p.id, p])));
  }

  /** Default address per party (the default one, else the first by label). */
  partyAddresses(): Promise<Map<string, string>> {
    return this.once('partyAddresses', async () => {
      const rows = await collect(readPaged<{ party_id: string; label: string; address: unknown; is_default: boolean }>(this.ctx, {
        from: 'party_addresses', select: 'party_id, label, address, is_default', order: ['party_id', 'is_default', 'label', 'id'],
      }));
      // ascending is_default puts the default last; keep the last row seen per party
      const out = new Map<string, string>();
      for (const r of rows) {
        const text = addressText(r.address);
        if (text) out.set(r.party_id, text);
      }
      return out;
    });
  }

  accountRows() {
    return this.once('accountRows', () => collect(readPaged<AccountRow>(this.ctx, {
      from: 'accounts', select: 'id, code, name, type, parent_id, system_key, is_group, is_control, is_money', order: ['code', 'id'],
    })));
  }

  async accounts(): Promise<Map<string, AccountRow>> {
    return this.once('accounts', async () => new Map((await this.accountRows()).map((a) => [a.id, a])));
  }

  warehouseRows() {
    return this.once('warehouseRows', () => collect(readPaged<WarehouseRow>(this.ctx, {
      from: 'warehouses', select: 'id, name, address, is_default, is_transit', order: ['name', 'id'],
    })));
  }

  async warehouses(): Promise<Map<string, WarehouseRow>> {
    return this.once('warehouses', async () => new Map((await this.warehouseRows()).map((w) => [w.id, w])));
  }

  itemRows() {
    return this.once('itemRows', () => collect(readPaged<ItemRow>(this.ctx, {
      from: 'items',
      select: 'id, name, brand, category, hsn_code, gst_rate::text, base_uom, alt_uom, conversion_factor::text, reorder_level::text, sale_rate::text, is_active, is_stock',
      order: ['name', 'id'],
    })));
  }

  async items(): Promise<Map<string, ItemRow>> {
    return this.once('items', async () => new Map((await this.itemRows()).map((i) => [i.id, i])));
  }

  /** Names of the people who post, by user id. */
  users(): Promise<Map<string, string>> {
    return this.once('users', async () => new Map((await collect(readPaged<{ user_id: string; name: string }>(this.ctx, {
      from: 'app_users', select: 'user_id, name', order: ['user_id'],
    }))).map((u) => [u.user_id, u.name])));
  }

  /** Document number by `source_type:source_id`, for documents dated up to the end of the year. */
  docNumbers(): Promise<Map<string, string>> {
    return this.once('docNumbers', async () => {
      const out = new Map<string, string>();
      for await (const r of readPaged<{ source_type: string; source_id: string; doc_no: string | null }>(this.ctx, {
        from: 'v_document_refs', select: 'source_type, source_id, doc_no', order: ['source_type', 'source_id'],
        dateColumn: 'doc_date', range: { to: this.ctx.fy.to }, createdAt: false,
      })) {
        if (r.doc_no) out.set(`${r.source_type}:${r.source_id}`, r.doc_no);
      }
      return out;
    });
  }
}
