export const maxAccountVendors = 10;

// Queries using this fragment alias the current service request as r.
export const accountVendorCount = `(SELECT count(DISTINCT previous.google_place_id) FROM call_attempts previous
  JOIN service_requests previous_request ON previous_request.id = previous.request_id
  WHERE previous_request.user_id = r.user_id
    AND (previous.started_at IS NOT NULL OR previous.transcript IS NOT NULL))`;

// The provider is identified by its Google place ID, not the overridden test phone.
// placeIdSql is an internal SQL column expression, never user input.
export function canCallProvider(placeIdSql: string) {
  return `(${accountVendorCount} < ${maxAccountVendors} OR EXISTS (
    SELECT 1 FROM call_attempts previous
    JOIN service_requests previous_request ON previous_request.id = previous.request_id
    WHERE previous_request.user_id = r.user_id
      AND previous.google_place_id = ${placeIdSql}
      AND (previous.started_at IS NOT NULL OR previous.transcript IS NOT NULL)
  ))`;
}
