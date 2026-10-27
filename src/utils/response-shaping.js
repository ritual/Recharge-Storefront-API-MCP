/**
 * Response shaping helpers
 *
 * Trim Recharge payloads down to the fields an assistant actually needs, so
 * clients with response-size limits (e.g. Intercom Fin) don't have to truncate
 * them. Unknown top-level keys (cursors, pagination) are preserved.
 */

export const SUBSCRIPTION_FIELDS = [
  'id',
  'address_id',
  'status',
  'product_title',
  'variant_title',
  'sku',
  'quantity',
  'price',
  'presentment_currency',
  'next_charge_scheduled_at',
  'order_interval_frequency',
  'order_interval_unit',
  'charge_interval_frequency',
  'order_day_of_month',
  'is_skippable',
  'is_swappable',
  'is_prepaid',
  'has_queued_charges',
  'cancelled_at',
  'cancellation_reason',
  'external_product_id',
  'external_variant_id',
];

export const ADDRESS_FIELDS = [
  'id',
  'first_name',
  'last_name',
  'company',
  'address1',
  'address2',
  'city',
  'province',
  'zip',
  'country_code',
  'phone',
];

export function pickFields(record, fields) {
  if (!record || typeof record !== 'object') {
    return record;
  }
  const picked = {};
  for (const field of fields) {
    if (record[field] !== undefined) {
      picked[field] = record[field];
    }
  }
  return picked;
}

/**
 * Shape a Recharge response that wraps either a list (e.g. `subscriptions`)
 * or a single record (e.g. `subscription`) under a known key.
 */
export function shapeResponse(response, key, fields) {
  if (!response || typeof response !== 'object' || response[key] === undefined) {
    return response;
  }
  const value = response[key];
  return {
    ...response,
    [key]: Array.isArray(value)
      ? value.map(item => pickFields(item, fields))
      : pickFields(value, fields),
  };
}
