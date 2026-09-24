/**
 * Chainable builders for user and group properties, and for revenue.
 *
 * Validation logs a warning rather than throwing, because an analytics bug must
 * never break the host application.
 */

import type { Logger, PropertyValue, RevenueFields, UserProperties } from '../types';
import { IdentifyOperation } from '../types';

type Bag = Record<string, PropertyValue>;

export class Identify {
  private props: Record<string, Bag> = {};
  private cleared = false;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  private op(operation: IdentifyOperation, key: string, value: PropertyValue): this {
    // Once clearAll is called, every other operation on this instance is ignored.
    if (this.cleared) {
      this.logger?.warn(`ignoring ${operation} on "${key}" after clearAll()`);
      return this;
    }
    if (typeof key !== 'string' || key.length === 0) {
      this.logger?.warn(`ignoring ${operation} with an empty property name`);
      return this;
    }
    const bag = this.props[operation] ?? (this.props[operation] = {});
    bag[key] = value;
    return this;
  }

  set(key: string, value: PropertyValue): this {
    return this.op(IdentifyOperation.SET, key, value);
  }

  setOnce(key: string, value: PropertyValue): this {
    return this.op(IdentifyOperation.SET_ONCE, key, value);
  }

  /** Numbers only. A non-numeric increment is rejected at the call site. */
  add(key: string, value: number): this {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.logger?.warn(`add("${key}") requires a finite number, got ${typeof value}`);
      return this;
    }
    return this.op(IdentifyOperation.ADD, key, value);
  }

  append(key: string, value: PropertyValue): this {
    return this.op(IdentifyOperation.APPEND, key, value);
  }

  prepend(key: string, value: PropertyValue): this {
    return this.op(IdentifyOperation.PREPEND, key, value);
  }

  preInsert(key: string, value: PropertyValue): this {
    return this.op(IdentifyOperation.PRE_INSERT, key, value);
  }

  postInsert(key: string, value: PropertyValue): this {
    return this.op(IdentifyOperation.POST_INSERT, key, value);
  }

  remove(key: string, value: PropertyValue): this {
    return this.op(IdentifyOperation.REMOVE, key, value);
  }

  unset(key: string): this {
    return this.op(IdentifyOperation.UNSET, key, '-');
  }

  /** Clears every user property. Dominates the rest of this instance. */
  clearAll(): this {
    this.props = {};
    this.cleared = true;
    return this;
  }

  /** True when nothing would be sent. */
  isEmpty(): boolean {
    return !this.cleared && Object.keys(this.props).length === 0;
  }

  /** The wire payload. */
  build(): UserProperties {
    if (this.cleared) return { [IdentifyOperation.CLEAR_ALL]: '-' } as UserProperties;
    return { ...this.props } as UserProperties;
  }
}

export class Revenue {
  private fields: RevenueFields = {};
  private extra?: Record<string, PropertyValue>;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  private num(name: keyof RevenueFields, value: number): this {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.logger?.warn(`${String(name)} requires a finite number`);
      return this;
    }
    (this.fields[name] as number) = value;
    return this;
  }

  setPrice(price: number): this {
    return this.num('price', price);
  }

  setQuantity(quantity: number): this {
    return this.num('quantity', quantity);
  }

  setRevenue(revenue: number): this {
    return this.num('revenue', revenue);
  }

  setProductId(id: string): this {
    this.fields.product_id = id;
    return this;
  }

  setRevenueType(type: string): this {
    this.fields.revenue_type = type;
    return this;
  }

  /** ISO 4217, e.g. `USD`. */
  setCurrency(currency: string): this {
    this.fields.currency = currency;
    return this;
  }

  setEventProperties(props: Record<string, PropertyValue>): this {
    this.extra = { ...(this.extra ?? {}), ...props };
    return this;
  }

  eventProperties(): Record<string, PropertyValue> | undefined {
    return this.extra;
  }

  /** Fills `revenue` from `price * quantity` when it was not set explicitly. */
  build(): RevenueFields {
    const out: RevenueFields = { ...this.fields };
    if (out.revenue === undefined && out.price !== undefined) {
      out.revenue = out.price * (out.quantity ?? 1);
    }
    return out;
  }
}
