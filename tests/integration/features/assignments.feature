Feature: GET / POST / PATCH /api/assignments (FHS-231)
  Real Postgres on :5433 — verifies the assignments list, create,
  done-toggle, role gate, and tenant isolation.

  Background:
    Given the test Postgres has clean tenants, members, assignments, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: GET returns all assignments ordered by due-date
    Given the "khan" tenant has an assignment "Spelling" due "2026-05-10"
    And separately the "khan" tenant has an assignment "Maths" due "2026-05-05"
    When the caller GETs /api/assignments for tenant "khan"
    Then the GET response status is 200
    And the response includes 2 assignments
    And the first assignment is "Maths"

  Scenario: POST creates an assignment and GET returns it
    When the caller POSTs an assignment "Reading" due "2026-05-08" in tenant "khan"
    Then the POST response status is 201
    And re-fetching /api/assignments for tenant "khan" lists 1 assignments

  Scenario: PATCH toggles done flag idempotently
    Given the "khan" tenant has an assignment "Spelling" due "2026-05-10"
    When the caller marks that assignment done in tenant "khan"
    Then the response says it is done
    When the caller marks that assignment not done in tenant "khan"
    Then the response says it is not done

  Scenario: A child member cannot create assignments
    Given the caller's role in "khan" is "child"
    When the caller POSTs an assignment "Reading" due "2026-05-08" in tenant "khan"
    Then the POST response status is 403

  Scenario: Tenant isolation — another tenant's assignments never appear
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has an assignment "Pasta night" due "2026-05-08"
    And separately the "khan" tenant has an assignment "Family dinner" due "2026-05-08"
    When the caller GETs /api/assignments for tenant "khan"
    Then the GET response status is 200
    And the response includes 1 assignments
    And the first assignment is "Family dinner"
