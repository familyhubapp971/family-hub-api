Feature: GET + POST /api/events (FHS-230)
  Real Postgres on :5433, verifies the calendar week-view filter +
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

  Scenario: An event can be edited then deleted (FHS-305)
    Given the caller creates an event "Dentist" on "2026-05-05" in tenant "khan"
    When the caller edits that event's title to "Doctor" in tenant "khan"
    Then the edit response status is 200
    And re-fetching events for week "2026-05-04" in tenant "khan" lists a "Doctor" event
    When the caller deletes that event in tenant "khan"
    Then the delete response status is 204
    And re-fetching events for week "2026-05-04" in tenant "khan" lists 0 events

  Scenario: A child member cannot create events
    Given the caller's role in "khan" is "child"
    When the caller POSTs an event "Sneaky" on "2026-05-05" in tenant "khan"
    Then the POST response status is 403

  Scenario: Tenant isolation: another tenant's events never appear
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has an event "Pasta night" on "2026-05-04"
    And separately the "khan" tenant has an event "Family dinner" on "2026-05-06"
    When the caller GETs /api/events for week "2026-05-04" in tenant "khan"
    Then the GET response status is 200
    And the response includes 1 events
    And the response includes a "Family dinner" event
    And the response excludes a "Pasta night" event

  Scenario: type, location and wear round-trip (FHS-265)
    When the caller POSTs a school event "PE Day" on "2026-05-05" at "School gym" wearing "PE kit" in tenant "khan"
    Then the POST response status is 201
    And re-fetching events for week "2026-05-04" in tenant "khan" lists 1 events
    And the "PE Day" event has type "school", location "School gym" and wear "PE kit"

  Scenario: type defaults to home when omitted (FHS-265)
    When the caller POSTs an event "Dentist" on "2026-05-05" in tenant "khan"
    Then the POST response status is 201
    And re-fetching events for week "2026-05-04" in tenant "khan" lists 1 events
    And the "Dentist" event has type "home"

  Scenario: A recurring activity appears on both chosen weekdays in its first week (FHS-476)
    Given the caller creates a recurring event "Tennis" starting "2026-06-01" repeating on "tue,thu" ending "2026-06-09" in tenant "khan"
    When the caller GETs /api/events for week "2026-06-01" in tenant "khan"
    Then the GET response status is 200
    And the response includes "Tennis" occurrences on "2026-06-02,2026-06-04"

  Scenario: A recurring activity stops appearing after its end date, mid-week (FHS-476)
    Given the caller creates a recurring event "Tennis" starting "2026-06-01" repeating on "tue,thu" ending "2026-06-09" in tenant "khan"
    When the caller GETs /api/events for week "2026-06-08" in tenant "khan"
    Then the response includes "Tennis" occurrences on "2026-06-09"
    And the response excludes a "Tennis" event on "2026-06-11"

  Scenario: A recurring activity produces no occurrences once its end date has fully passed (FHS-476)
    Given the caller creates a recurring event "Tennis" starting "2026-06-01" repeating on "tue,thu" ending "2026-06-09" in tenant "khan"
    When the caller GETs /api/events for week "2026-06-15" in tenant "khan"
    Then the response includes 0 events

  Scenario: A recurring series never leaks across tenants (FHS-476)
    Given a second tenant "smith" exists with the caller as an admin member
    And the caller creates a recurring event "Piano" starting "2026-06-01" repeating on "tue,thu" ending "2026-06-30" in tenant "smith"
    When the caller GETs /api/events for week "2026-06-01" in tenant "khan"
    Then the response excludes a "Piano" event on "2026-06-02"
