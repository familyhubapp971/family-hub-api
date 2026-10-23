-- FHS-672: app_founder_feedback(), the one reader behind the founder's /admin
-- feedback page.
--
-- beta_feedback is tenant-isolated (FORCE RLS), so the app role only ever sees
-- one family's rows. The founder page reads every family's answers, so it goes
-- through this SECURITY DEFINER function, the same pattern as the 0030
-- readers. Approved by the founder on 2026-10-23. It only SELECTs feedback
-- (no other table's data beyond the family slug and name), and the only route
-- that calls it is guarded by the founder passcode.
--
-- Also applied on every boot by scripts/apply-functions.mjs, because
-- staging/prod use drizzle-kit push, which never creates functions. Every
-- statement is idempotent. MUST run as the owner/migrate role.
--
-- Rollback: drizzle/down/0047_founder_feedback_reader.down.sql.

CREATE OR REPLACE FUNCTION app_founder_feedback(p_limit integer)
RETURNS TABLE (
  source text,
  family_slug text,
  family_name text,
  name text,
  email text,
  visit_id uuid,
  screen text,
  features text[],
  pmf_disappointment text,
  recommend_score integer,
  solves_problem integer,
  ease_of_use integer,
  keep_using integer,
  pain_point text,
  feature_request text,
  other_feedback text,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT * FROM (
    SELECT CASE WHEN bf.screen IS NULL THEN 'in_app' ELSE 'screen' END,
           t.slug, t.name, NULL::text, bf.submitted_by_email,
           bf.visit_id, bf.screen, bf.features,
           bf.pmf_disappointment, bf.recommend_score, bf.solves_problem,
           bf.ease_of_use, bf.keep_using, bf.pain_point, bf.feature_request,
           bf.other_feedback, bf.created_at
      FROM public.beta_feedback bf
      LEFT JOIN public.tenants t ON t.id = bf.tenant_id
    UNION ALL
    SELECT 'public', NULL, NULL, pf.name, pf.email,
           NULL, NULL, NULL,
           pf.pmf_disappointment, pf.recommend_score, pf.solves_problem,
           pf.ease_of_use, pf.keep_using, pf.pain_point, pf.feature_request,
           pf.other_feedback, pf.created_at
      FROM public.public_feedback pf
  ) AS answers
  ORDER BY answers.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 5000)
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_founder_feedback(integer) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_founder_feedback(integer) TO app_runtime;
  END IF;
END
$$;
