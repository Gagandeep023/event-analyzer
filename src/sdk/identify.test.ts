import { describe, it, expect } from 'vitest';
import { Identify, Revenue } from './identify';
import { quietLogger } from './__fixtures__';

describe('Identify', () => {
  it('chains and builds a wire payload', () => {
    const out = new Identify()
      .set('plan', 'pro')
      .setOnce('src', 'blog')
      .add('logins', 1)
      .append('features', 'export')
      .prepend('recent', 'v2')
      .preInsert('tags', 'beta')
      .postInsert('tags', 'pro')
      .remove('tags', 'trial')
      .unset('trial_ends')
      .build();

    expect(out).toEqual({
      $set: { plan: 'pro' },
      $setOnce: { src: 'blog' },
      $add: { logins: 1 },
      $append: { features: 'export' },
      $prepend: { recent: 'v2' },
      $preInsert: { tags: 'beta' },
      $postInsert: { tags: 'pro' },
      $remove: { tags: 'trial' },
      $unset: { trial_ends: '-' },
    });
  });

  it('rejects a non-numeric add at the call site, without throwing', () => {
    // An analytics bug must never break the host application.
    const id = new Identify(quietLogger);
    expect(() => id.add('n', 'x' as unknown as number)).not.toThrow();
    expect(id.build()).toEqual({});
  });

  it('ignores an empty property name', () => {
    expect(new Identify(quietLogger).set('', 1).build()).toEqual({});
  });

  it('clearAll dominates and ignores everything after it', () => {
    const out = new Identify(quietLogger).set('a', 1).clearAll().set('b', 2).build();
    expect(out).toEqual({ $clearAll: '-' });
  });

  it('reports emptiness', () => {
    expect(new Identify().isEmpty()).toBe(true);
    expect(new Identify().set('a', 1).isEmpty()).toBe(false);
    expect(new Identify().clearAll().isEmpty()).toBe(false);
  });
});

describe('Revenue', () => {
  it('computes revenue from price and quantity when not set', () => {
    expect(new Revenue().setPrice(29).setQuantity(2).build().revenue).toBe(58);
  });

  it('defaults quantity to 1', () => {
    expect(new Revenue().setPrice(29).build().revenue).toBe(29);
  });

  it('keeps an explicit revenue', () => {
    expect(new Revenue().setPrice(29).setQuantity(2).setRevenue(50).build().revenue).toBe(50);
  });

  it('carries product metadata', () => {
    const out = new Revenue()
      .setProductId('pro_monthly')
      .setRevenueType('purchase')
      .setCurrency('USD')
      .build();
    expect(out).toMatchObject({
      product_id: 'pro_monthly',
      revenue_type: 'purchase',
      currency: 'USD',
    });
  });

  it('rejects a non-finite number without throwing', () => {
    const r = new Revenue(quietLogger);
    expect(() => r.setPrice(NaN)).not.toThrow();
    expect(r.build().price).toBeUndefined();
  });

  it('carries extra event properties separately from revenue fields', () => {
    const r = new Revenue().setPrice(1).setEventProperties({ campaign: 'launch' });
    expect(r.eventProperties()).toEqual({ campaign: 'launch' });
    expect(r.build()).not.toHaveProperty('campaign');
  });
});
