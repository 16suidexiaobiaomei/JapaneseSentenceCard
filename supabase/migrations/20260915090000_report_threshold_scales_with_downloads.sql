-- Auto-removal used to trigger on a flat >= 3 unique reporters,
-- regardless of how many people had downloaded the tag. That's a fair
-- bar for a small deck, but a widely-downloaded tag could be taken
-- down by the same tiny handful of reports that a niche one would be,
-- even though those 3 reports represent a much smaller fraction of
-- its actual audience. Removal now requires BOTH the existing floor
-- (>= 3 unique reporters, so a single bad-faith report still can't
-- remove anything) AND a proportional bar that scales up with
-- popularity (>= 5% of download_count, rounded up) — so an
-- established tag with real traction needs proportionally more
-- reports to come down, while a small one still only needs 3.
create or replace function public.report_shared_tag(
  p_shared_tag_id uuid,
  p_reason text,
  p_detail text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_report_count integer;
  v_download_count integer;
  v_removed_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.shared_tag_reports (shared_tag_id, reporter_id, reason, detail)
  values (p_shared_tag_id, v_uid, p_reason, coalesce(p_detail, ''))
  on conflict (shared_tag_id, reporter_id) do nothing;

  select count(*) into v_report_count
  from public.shared_tag_reports
  where shared_tag_id = p_shared_tag_id;

  select download_count into v_download_count from public.shared_tags where id = p_shared_tag_id;

  if v_report_count >= 3 and v_report_count >= ceil(coalesce(v_download_count, 0) * 0.05) then
    select owner_id into v_owner from public.shared_tags where id = p_shared_tag_id;

    update public.shared_tags set status = 'removed' where id = p_shared_tag_id and status = 'active';

    select count(*) into v_removed_count
    from public.shared_tags
    where owner_id = v_owner and status = 'removed';

    if v_removed_count >= 2 then
      update public.profiles set sharing_frozen = true where id = v_owner;
    end if;
  end if;
end;
$$;
