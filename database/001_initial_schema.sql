-- Apply once to the application's PostgreSQL database using psql or pgAdmin.
-- Both tables are created together, or the transaction rolls back.
BEGIN;

CREATE TABLE public.users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email VARCHAR(254) NOT NULL,
    -- The backend must generate a salted password hash before inserting a user.
    -- Store the full encoded hash, including its algorithm and salt.
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT users_email_valid CHECK (
        email = BTRIM(email)
        AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    ),
    CONSTRAINT users_password_hash_present CHECK (
        LENGTH(BTRIM(password_hash)) > 0
    )
);

-- Treat different capitalizations of the same email as one account.
-- Login lookups should use LOWER(email) = LOWER($1).
CREATE UNIQUE INDEX users_email_unique ON public.users (LOWER(email));

CREATE TABLE public.service_requests (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    service_type VARCHAR(20) NOT NULL,
    custom_service VARCHAR(100),
    description VARCHAR(2000) NOT NULL,

    -- Contact details belong to this particular request. A user can submit
    -- another job with a different contact person or service address.
    contact_name VARCHAR(100) NOT NULL,
    contact_phone VARCHAR(25) NOT NULL,
    service_address VARCHAR(500) NOT NULL,

    -- Date and time window refer to local service time in Asia/Kolkata for v1.
    preferred_date DATE NOT NULL,
    preferred_time_window VARCHAR(20) NOT NULL,
    -- Amount is in Indian rupees, matching the current form.
    max_visit_fee NUMERIC(12, 2),

    share_name BOOLEAN NOT NULL DEFAULT FALSE,
    share_phone BOOLEAN NOT NULL DEFAULT FALSE,
    share_address BOOLEAN NOT NULL DEFAULT FALSE,
    booking_permission VARCHAR(20) NOT NULL DEFAULT 'approval',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT requests_service_type_valid CHECK (
        service_type IN ('plumber', 'electrician', 'other')
    ),
    CONSTRAINT requests_custom_service_valid CHECK (
        (service_type = 'other' AND custom_service IS NOT NULL
            AND LENGTH(BTRIM(custom_service)) > 0)
        OR (service_type <> 'other' AND custom_service IS NULL)
    ),
    CONSTRAINT requests_description_present CHECK (
        LENGTH(BTRIM(description)) > 0
    ),
    CONSTRAINT requests_contact_name_present CHECK (
        LENGTH(BTRIM(contact_name)) > 0
    ),
    CONSTRAINT requests_contact_phone_valid CHECK (
        contact_phone ~ '^[+0-9() .-]{7,25}$'
        AND contact_phone ~ '[0-9]'
    ),
    CONSTRAINT requests_address_present CHECK (
        LENGTH(BTRIM(service_address)) > 0
    ),
    CONSTRAINT requests_time_window_valid CHECK (
        preferred_time_window IN ('morning', 'afternoon', 'evening', 'any')
    ),
    CONSTRAINT requests_visit_fee_valid CHECK (
        max_visit_fee IS NULL OR max_visit_fee BETWEEN 1 AND 1000000
    ),
    CONSTRAINT requests_booking_permission_valid CHECK (
        booking_permission IN ('approval', 'automatic')
    ),
    CONSTRAINT requests_automatic_booking_requires_budget CHECK (
        booking_permission <> 'automatic' OR max_visit_fee IS NOT NULL
    )
);

-- Supports fetching a user's requests with the newest ones first.
CREATE INDEX service_requests_user_created_idx
    ON public.service_requests (user_id, created_at DESC, id DESC);

-- The backend must derive user_id from the authenticated session and scope
-- request reads and writes to that user. The foreign key enforces ownership
-- references. Session authentication enforces access to those references.
-- Validate preferred_date against today's local date when accepting a request.
-- A database CHECK against CURRENT_DATE would become stale as time passes.

COMMIT;
