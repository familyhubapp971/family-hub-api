Feature: GET + POST /api/events (FHS-230)
  Real Postgres on :5433 — verifies the calendar week-view filter +
  POST creation, role gate (only admin/adult writes), member-belongs-
  to-tenant guard, and tenant isolation.

  Background:
    Given the test Postgres has clean tenants, members, events, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: GET returns events whose date sits in the requested week
    Given the "khan" tenant has an event "Swim" on "2026-05-04"
    And the "khan" tenant has an event "Out of window" on "2026-04-30"
    When the caller GETs /api/events for week "2026-05-04" in tenant "khan"
    Then the GET response status is 200
    And the response includes 1 events
    And the response includes a "Swim" event

  Scenario: POST creates an event and GET returns it within the week
    When the caller POSTs an event "Dentist" on "2026-05-05" in tenant "khan"
    Then the POST response status is 201
    And re-fetching events for week "2026-05-04" in tenant "khan" lists 1 events

  Scenario: A child member cannot create events
    Given the caller's role in "khan" is "child"
    When the caller POSTs an event "Sneaky" on "2026-05-05" in tenant "khan"
    Then the POST response status is 403

  Scenario: Tenant isolation — another tenant's events never appear
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has an event "Pasta night" on "2026-05-04"
    And separately the "khan" tenant has an event "Family dinner" on "2026-05-06"
    When the caller GETs /api/events for week "2026-05-04" in tenant "khan"
    Then the GET response status is 200
    And the response includes 1 events
    And the response includes a "Family dinner" event
    And the response excludes a "Pasta night" event
