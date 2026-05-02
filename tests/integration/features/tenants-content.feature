Feature: tenants-content schema (FHS-4)
  Verifies app_settings (composite PK) and activity_logs created by
  migration 0003_tenants_content. Per Sprint 1 vertical-slice scope:
  feature tables (announcements, school work, meals, stickers) deferred
  to their own feature PRs.

  Background:
    Given the test Postgres has clean tenants and content tables
    And tenants "alpha" and "beta" exist

  # ─── app_settings (composite PK) ──────────────────────────────────────────

  Scenario: Insert a setting with a jsonb value persists round-trip
    When I upsert app_setting "theme" with value "\"dark\"" in "alpha"
    Then the setting is persisted with value "\"dark\""

  Scenario: Composite PK rejects same (tenant_id, key) twice
    Given app_setting "theme" exists in "alpha" with value "\"dark\""
    When I insert app_setting "theme" in "alpha" with value "\"light\""
    Then the call rejects with a unique-constraint error

  Scenario: Same key across different tenants is allowed
    Given app_setting "theme" exists in "alpha" with value "\"dark\""
    When I insert app_setting "theme" in "beta" with value "\"light\""
    Then both rows exist, one per tenant

  Scenario: Setting cascade-deletes when its tenant is deleted
    Given app_setting "theme" exists in "alpha" with value "\"dark\""
    When I delete tenant "alpha"
    Then no app_settings rows exist for "alpha"

  # ─── activity_logs (append-only audit trail) ──────────────────────────────

  Scenario: Insert an activity log with all actor fields populated
    Given a member exists in "alpha"
    When I log action "habit.completed" attributed to that member
    Then exactly 1 activity_logs row exists for "alpha"
    And the row has the actor_member_id set

  Scenario: System action (no actor) is allowed
    When I log action "system.nightly.recompute" with no actor in "alpha"
    Then exactly 1 activity_logs row exists for "alpha"
    And the row has both actor_member_id and actor_user_id null

  Scenario: Actor member deletion preserves the audit trail (SET NULL)
    Given a member exists in "alpha"
    And an activity log records that member doing "habit.completed"
    When I delete that member
    Then the activity_logs row still exists
    And the row's actor_member_id is null

  Scenario: Activity logs cascade-delete with tenant
    Given an activity log exists in "alpha"
    When I delete tenant "alpha"
    Then no activity_logs rows exist for "alpha"
