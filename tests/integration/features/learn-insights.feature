Feature: Learn Insights API (FHS-384)
  Real Postgres on :5433, verifies the parent-facing GET /api/learn/insights
  endpoint. Checks: data aggregation from real maths/logic/science rows,
  tenant isolation (parent in tenant A cannot read a child in tenant B),
  and the empty-state shape for a child with no Learn activity.

  Background:
    Given the test Postgres has clean learn insights tables
    And a users mirror row exists for the learn insights caller
    And a tenant "insight-family" exists with the caller as an admin member
    And the "insight-family" tenant has a child member "Layla"
    And a second tenant "other-family" exists with a child member "Omar"

  Scenario: a parent reads a child's insights with seeded Maths progress
    Given "Layla" has 6 maths certificates in "insight-family"
    When the caller GETs learn insights for "Layla" in "insight-family"
    Then the learn insights response status is 200
    And the learn insights memberId matches "Layla"
    And the learn insights Maths subject has certificatesEarned 6
    And the learn insights Maths progressPct is 12
    And the learn insights hasActivity is true

  Scenario: empty state: a child with no Learn activity
    When the caller GETs learn insights for "Layla" in "insight-family"
    Then the learn insights response status is 200
    And the learn insights hasActivity is false
    And the learn insights weakest is null
    And every subject has progressPct 0

  Scenario: tenant isolation: a parent cannot read a child in another tenant
    When the caller GETs learn insights for "Omar" in "insight-family"
    Then the learn insights response status is 404

  Scenario: kid-role caller is rejected (403 ADULT_REQUIRED)
    Given a kid caller "kidcaller" in "insight-family"
    When the kid caller GETs learn insights for "Layla" in "insight-family"
    Then the learn insights response status is 403
    And the learn insights error code is "ADULT_REQUIRED"
