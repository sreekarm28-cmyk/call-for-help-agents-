export function up(pgm) {
  pgm.sql(`
    ALTER TABLE scheduled_jobs DROP CONSTRAINT scheduled_jobs_request_id_key;
    CREATE UNIQUE INDEX scheduled_jobs_one_active_search
      ON scheduled_jobs (request_id) WHERE status IN ('pending', 'running');
    CREATE INDEX scheduled_jobs_request_latest ON scheduled_jobs (request_id, id DESC);
    ALTER TABLE request_events ADD COLUMN search_job_id bigint;
    UPDATE request_events e SET search_job_id = j.id
      FROM scheduled_jobs j WHERE e.request_id = j.request_id AND e.event_type = 'provider_search';
    CREATE INDEX request_events_search_job ON request_events (search_job_id);

    ALTER TABLE service_requests ADD COLUMN collect_offers boolean NOT NULL DEFAULT false;
    ALTER TABLE request_providers ADD COLUMN expires_at timestamptz;
    UPDATE request_providers p SET expires_at = (
      r.preferred_date + CASE r.preferred_time_window
        WHEN 'morning' THEN time '12:00' WHEN 'afternoon' THEN time '16:00'
        WHEN 'evening' THEN time '20:00' ELSE time '24:00' END
      ) AT TIME ZONE 'Asia/Kolkata' + interval '10 hours'
      FROM service_requests r WHERE p.request_id = r.id;
    ALTER TABLE request_providers ALTER COLUMN expires_at SET NOT NULL;
    CREATE INDEX request_providers_expiry ON request_providers (expires_at);
    ALTER TABLE bookings ADD COLUMN replacement_requested boolean NOT NULL DEFAULT false;
    ALTER TABLE call_attempts ADD COLUMN confirmation_booking_id bigint UNIQUE REFERENCES bookings(id) ON DELETE CASCADE;
    ALTER TABLE call_attempts DROP CONSTRAINT call_attempts_status_check;
    ALTER TABLE call_attempts ADD CHECK (status IN
      ('queued', 'calling', 'no_answer', 'declined', 'offer_received', 'confirmed', 'failed', 'cancelled'));
  `);
}

// Replacement searches may create multiple jobs for the same request.
export const down = false;
