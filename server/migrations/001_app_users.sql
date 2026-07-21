create table if not exists public.app_users (
  id bigint generated always as identity primary key,
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('admin', 'user')),
  is_active boolean not null default true,
  failed_login_attempts integer not null default 0 check (failed_login_attempts >= 0),
  locked_until timestamptz,
  password_changed_at timestamptz not null default now(),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_users_normalized_username check (username = lower(btrim(username)))
);

create index if not exists app_users_active_role_idx
  on public.app_users (is_active, role);

revoke all on public.app_users from public;
revoke all on sequence public.app_users_id_seq from public;
