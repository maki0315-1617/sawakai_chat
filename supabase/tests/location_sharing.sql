begin;

update public.kv_store_8e9e0c0c
set value = value || '[{"id":"__location_test_a__"},{"id":"__location_test_b__"}]'::jsonb
where key = 'sawakai:groups';

insert into public.kv_store_8e9e0c0c (key, value) values
  ('sawakai:group:__location_test_a__:members', '[{"name":"Alice"},{"name":"Bob"}]'),
  ('sawakai:group:__location_test_b__:members', '[{"name":"Carol"}]');

insert into public.sawakai_location_shares
  (session_hash, group_id, member_name, enabled, latitude, longitude, updated_at)
values
  ('test-alice', '__location_test_a__', 'Alice', true, 35, 139, now()),
  ('test-bob', '__location_test_a__', 'Bob', true, 36, 140, now()),
  ('test-carol', '__location_test_b__', 'Carol', true, 37, 141, now());

do $$
begin
  if (select count(*) from public.sawakai_visible_locations('test-alice', '__location_test_a__')) != 2 then
    raise exception 'shared group lookup failed';
  end if;
  if (select count(*) from public.sawakai_visible_locations('test-carol', '__location_test_a__')) != 0 then
    raise exception 'cross-group access was not blocked';
  end if;
  if has_table_privilege('anon', 'public.sawakai_location_shares', 'SELECT')
     or has_function_privilege('anon', 'public.sawakai_visible_locations(text,text)', 'EXECUTE') then
    raise exception 'anonymous database access was not blocked';
  end if;
end $$;

delete from public.sawakai_location_shares where session_hash = 'test-alice';
do $$
begin
  if exists (select 1 from public.sawakai_visible_locations('test-alice', '__location_test_a__')) then
    raise exception 'disabled requester can still see locations';
  end if;
end $$;

update public.kv_store_8e9e0c0c set value = '[{"name":"Alice"}]'::jsonb
where key = 'sawakai:group:__location_test_a__:members';
do $$
begin
  if exists (select 1 from public.sawakai_location_shares where session_hash = 'test-bob') then
    raise exception 'removed member location was not deleted';
  end if;
end $$;

update public.sawakai_location_shares set updated_at = now() - interval '2 days'
where session_hash = 'test-carol';
update public.sawakai_location_shares set latitude = null, longitude = null, updated_at = null
where updated_at is not null
  and now() >= (((updated_at at time zone 'Asia/Tokyo')::date + time '23:59') at time zone 'Asia/Tokyo');
do $$
begin
  if not exists (select 1 from public.sawakai_location_shares
    where session_hash = 'test-carol' and enabled and latitude is null and longitude is null and updated_at is null) then
    raise exception 'expired position cleanup failed';
  end if;
end $$;

delete from public.kv_store_8e9e0c0c
where key = 'sawakai:group:__location_test_b__:members';
do $$
begin
  if exists (select 1 from public.sawakai_location_shares where session_hash = 'test-carol') then
    raise exception 'deleted group members did not remove sharing settings';
  end if;
  begin
    insert into public.sawakai_location_shares
      (session_hash, group_id, member_name, enabled, latitude, longitude, updated_at)
    values ('test-carol', '__location_test_b__', 'Carol', true, 37, 141, now());
    raise exception 'removed member was allowed to share';
  exception when raise_exception then
    if sqlerrm = 'removed member was allowed to share' then raise; end if;
  end;
end $$;

rollback;
