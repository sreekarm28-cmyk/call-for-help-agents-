export function up(pgm) {
  pgm.createTable('request_providers', {
    request_id: { type: 'bigint', notNull: true, references: 'service_requests', onDelete: 'CASCADE' },
    google_place_id: { type: 'text', notNull: true },
    rank: { type: 'integer', notNull: true, check: 'rank BETWEEN 1 AND 5' },
  });
  pgm.addConstraint('request_providers', 'request_providers_pk', {
    primaryKey: ['request_id', 'google_place_id'],
  });
  pgm.addConstraint('request_providers', 'request_providers_rank_unique', {
    unique: ['request_id', 'rank'],
  });
  pgm.sql(`
    WITH latest_search AS (
      SELECT DISTINCT ON (request_id) request_id, metadata
      FROM request_events
      WHERE event_type = 'provider_search' AND status = 'completed'
      ORDER BY request_id, created_at DESC, id DESC
    ), unique_places AS (
      SELECT request_id, place_id, MIN(position) AS first_position
      FROM latest_search
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(metadata->'placeIds') = 'array'
             THEN metadata->'placeIds' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS places(place_id, position)
      WHERE place_id IS NOT NULL AND place_id <> ''
      GROUP BY request_id, place_id
    ), ranked_places AS (
      SELECT request_id, place_id,
             ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY first_position) AS rank
      FROM unique_places
    )
    INSERT INTO request_providers (request_id, google_place_id, rank)
    SELECT request_id, place_id, rank::integer FROM ranked_places WHERE rank <= 5;
  `);
}

export function down(pgm) {
  pgm.dropTable('request_providers');
}
