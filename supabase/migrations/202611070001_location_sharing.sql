create extension if not exists pg_cron;

create table if not exists public.sawakai_location_shares (
  session_hash text not null,
  group_id text not null,
  member_name text not null,
  enabled boolean not null default false,
  latitude double precision,
  longitude double precision,
  updated_at timestamptz,
  primary key (session_hash, group_id),
  check ((latitude is null and longitude is null and updated_at is null) or
    (latitude is not null and longitude is not null and
     latitude between -90 and 90 and longitude between -180 and 180 and updated_at is not null))
);

alter table public.sawakai_location_shares enable row level security;
revoke all on public.sawakai_location_shares from public, anon, authenticated;
grant select, insert, update, delete on public.sawakai_location_shares to service_role;

create or replace function public.sawakai_visible_locations(requester text, requested_group text)
returns table (member_name text, latitude double precision, longitude double precision, updated_at timestamptz)
language sql stable security invoker
set search_path = ''
as $$
  select s.member_name, s.latitude, s.longitude, s.updated_at
  from public.sawakai_location_shares s
  where s.group_id = requested_group and s.enabled and s.updated_at is not null
    and exists (
      select 1 from public.sawakai_location_shares own
      where own.session_hash = requester and own.group_id = requested_group and own.enabled
    );
$$;
revoke all on function public.sawakai_visible_locations(text, text) from public, anon, authenticated;
grant execute on function public.sawakai_visible_locations(text, text) to service_role;

select cron.schedule(
  'sawakai-location-daily-cleanup',
  '* * * * *',
  $$update public.sawakai_location_shares
    set latitude = null, longitude = null, updated_at = null
    where updated_at is not null
      and now() >= (((updated_at at time zone 'Asia/Tokyo')::date + time '23:59') at time zone 'Asia/Tokyo')$$
);
