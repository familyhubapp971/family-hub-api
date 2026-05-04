Feature: GET / POST / DELETE /api/notices (FHS-232)
  Real Postgres on :5433 — verifies the noticeboard list ordering
  (pinned first, then newest), POST role gate, DELETE role gate +
  not-found, and tenant isolation.

  Background:
    Given the test Postgres has clean tenants, members, notices, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: GET orders pinned notices first, then by newest createdAt
    Given the "khan" tenant has a notice "Old chat" posted at "2026-05-01T10:00:00.000Z"
    And separately the "khan" tenant has a pinned notice "Pizza Friday" posted at "2026-04-30T10:00:00.000Z"
    And separately the "khan" tenant has a notice "Newer chat" posted at "2026-05-02T10:00:00.000Z"
    When the caller GETs /api/notices for tenant "khan"
    Then the GET response status is 200
    And the response includes 3 notices
    And the first notice body is "Pizza Friday"
    And the second notice body is "Newer chat"

  Scenario: POST creates a notice; GET returns it
    When the caller POSTs a notice "Hello" pinned "false" in tenant "khan"
    Then the POST response status is 201
    And re-fetching /api/notices for tenant "khan" lists 1 notices

  Scenario: A child member cannot post a notice
    Given the caller's role in "khan" is "child"
    When the caller POSTs a notice "Sneaky" pinned "false" in tenant "khan"
    Then the POST response status is 403

  Scenario: DELETE removes the notice idempotently
    Given the "khan" tenant has a notice "Pizza Friday" posted at "2026-05-01T10:00:00.000Z"
    When the caller deletes that notice in tenant "khan"
    Then the DELETE response status is 204
    And re-fetching /api/notices for tenant "khan" lists 0 notices

  Scenario: Tenant isolation — another tenant's notices never appear
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has a notice "Pasta party" posted at "2026-05-01T10:00:00.000Z"
    And separately the "khan" tenant has a notice "Family meeting" posted at "2026-05-02T10:00:00.000Z"
    When the caller GETs /api/notices for tenant "khan"
    Then the GET response status is 200
    And the response includes 1 notices
    And the first notice body is "Family meeting"
