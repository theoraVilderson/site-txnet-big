-- AC-1-a: staff edit a person's name, username or email, and the trail names
-- the act. One enum value; additive. Rollback: none needed (an enum value
-- cannot be dropped, and nothing writes it once the route is gone).

ALTER TYPE "audit"."AdminAction" ADD VALUE 'user_profile_update';
