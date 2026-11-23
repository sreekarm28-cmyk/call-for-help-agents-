export const canHideProviders = `
  sr.preferred_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
  AND NOT EXISTS (
    SELECT 1 FROM bookings b JOIN provider_offers o ON o.id = b.offer_id
    WHERE b.request_id = sr.id
      AND b.status IN ('awaiting_provider_confirmation', 'confirmed')
      AND (o.visit_at AT TIME ZONE 'Asia/Kolkata')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
  )`;

const offerIdPattern = /^[1-9][0-9]{0,18}$/;
export function validOfferRouteId(id: string) {
  return offerIdPattern.test(id) && BigInt(id) <= 9223372036854775807n;
}
