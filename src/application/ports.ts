import type { ReceivingProduct, prepareReceivingEntry } from '../domain/receiving.ts';

export type Actor = { subject: string; displayName?: string };
export type PreparedEntry = ReturnType<typeof prepareReceivingEntry> & { recordedBy?: Actor };
export type EntryStatus = 'ACCEPTED' | 'APPLIED' | 'REJECTED';
export type LedgerEntry = PreparedEntry & {
  status: EntryStatus;
  acceptedAt: string;
  completedAt?: string;
  rejectionReason?: string;
};
export type Product = ReceivingProduct & {
  active: boolean;
  name?: string;
  barcode?: string;
  createdBy?: Actor;
  createdAt?: string;
  updatedBy?: Actor;
  updatedAt?: string;
};
export type Warehouse = { warehouseId: string; name: string; active: boolean };
export type Balance = { skuId: string; lotCode?: string; quantity: number };
export type Page<T> = { items: T[]; cursor?: string };
export class ConflictError extends Error {}
export class EligibilityError extends Error {}
export interface IntakeStore {
  getProduct(organizationId: string, skuId: string): Promise<Product | undefined>;
  putProduct(organizationId: string, product: Product, actor?: Actor): Promise<void>;
  listProducts(organizationId: string, limit: number, cursor?: string): Promise<Page<Product>>;
  findProductByCode(organizationId: string, code: string): Promise<Product | undefined>;
  getWarehouse(organizationId: string, warehouseId: string): Promise<Warehouse | undefined>;
  putWarehouse(organizationId: string, warehouse: Warehouse): Promise<void>;
  accept(command: PreparedEntry): Promise<LedgerEntry>;
  getEntry(entryId: string): Promise<LedgerEntry | undefined>;
  listEntries(
    organizationId: string,
    warehouseId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<LedgerEntry>>;
  getBalances(
    organizationId: string,
    warehouseId: string,
    skuId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<Balance>>;
  listStock(
    organizationId: string,
    warehouseId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<Balance>>;
  apply(entryId: string): Promise<void>;
}
