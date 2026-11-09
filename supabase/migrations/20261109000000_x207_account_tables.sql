-- BE-116: the account tables of x207 (profile, onboarding steps, notification preferences, feedback) and the nonces of the signed requests.
-- Every object ends in `_x207`: the project also holds `reeve_docs` and `reeve_ledger` of another project, which this file does not touch.
-- Access: only the service role (the Edge Function `x207-account`). RLS is ON and there is NO policy, so `anon` and `authenticated` get nothing; their table privileges are revoked as well.

create table if not exists public.profiles_x207 (
  account_id   text primary key check (char_length(account_id) between 2 and 64),
  display_name text check (display_name is null or char_length(display_name) between 1 and 40),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- no foreign key to the profile: a user may tick the first steps before a name is chosen
create table if not exists public.onboarding_x207 (
  account_id     text primary key check (char_length(account_id) between 2 and 64),
  wallet_created boolean not null default false,
  funds_received boolean not null default false,
  joined         boolean not null default false,
  staked         boolean not null default false,
  tour_done      boolean not null default false,
  updated_at     timestamptz not null default now()
);

create table if not exists public.notify_prefs_x207 (
  account_id        text primary key check (char_length(account_id) between 2 and 64),
  email             text check (email is null or char_length(email) <= 254),
  deadline_reminder boolean not null default false,
  updated_at        timestamptz not null default now()
);

-- ip_hash: sha256 of a salt and the address of the sender, only to count messages per address (the address itself is not stored)
create table if not exists public.feedback_x207 (
  id         bigint generated always as identity primary key,
  account_id text check (account_id is null or char_length(account_id) <= 64),
  page       text not null check (char_length(page) between 1 and 200),
  message    text not null check (char_length(message) between 1 and 2000),
  ip_hash    text,
  created_at timestamptz not null default now()
);
create index if not exists feedback_x207_by_ip on public.feedback_x207 (ip_hash, created_at);

-- a nonce is spent once; the primary key refuses the second use. Rows older than an hour are deleted by the function.
create table if not exists public.nonces_x207 (
  nonce      text primary key check (char_length(nonce) <= 64),
  account_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists nonces_x207_by_time on public.nonces_x207 (created_at);

alter table public.profiles_x207     enable row level security;
alter table public.onboarding_x207   enable row level security;
alter table public.notify_prefs_x207 enable row level security;
alter table public.feedback_x207     enable row level security;
alter table public.nonces_x207       enable row level security;

revoke all on table public.profiles_x207, public.onboarding_x207, public.notify_prefs_x207, public.feedback_x207, public.nonces_x207 from public, anon, authenticated;
grant all on table public.profiles_x207, public.onboarding_x207, public.notify_prefs_x207, public.feedback_x207, public.nonces_x207 to service_role;
grant usage, select on sequence public.feedback_x207_id_seq to service_role;
