Feature: Calendar sync feed (FHS-445)
  Real Postgres on :5433. GET /api/calendar/feed returns a signed subscribe
  URL for the family (any member may fetch it); POST /api/calendar/feed/rotate
  regenerates it (admin-only, and invalidates every old URL). The public ICS
  feed the URL points at needs no auth — the signed token in the URL path is
  the credential, verified before any event row is read.

  Background:
    Given the test Postgres has clean calendar-feed tables
    And a users mirror row exists for the calendar-feed test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: A member fetches the subscribe url and the public feed lists their events
    Given the "khan" tenant has an event "Swim class" on "2026-07-05"
    And the "khan" tenant has an event "Dentist" on "2026-07-06"
    When the caller GETs /api/calendar/feed for tenant "khan"
    Then the feed response status is 200
    When an anonymous request fetches that subscribe url
    Then the public feed response status is 200
    And the public feed content type is "text/calendar"
    And the public feed body includes a "Swim class" SUMMARY line
    And the public feed body also includes a "Dentist" SUMMARY line

  Scenario: Tenant isolation — a family's feed never includes another family's events
    Given a second tenant "smith" exists with the caller as an admin member
    And the "khan" tenant has an event "Swim class" on "2026-07-05"
    And separately the "smith" tenant has an event "Piano recital" on "2026-07-05"
    When the caller GETs /api/calendar/feed for tenant "khan"
    Then the feed response status is 200
    When an anonymous request fetches that subscribe url
    Then the public feed response status is 200
    And the public feed body includes a "Swim class" SUMMARY line
    And the public feed body excludes a "Piano recital" SUMMARY line

  Scenario: A forged signature on a real tenant id returns 404
    Given the "khan" tenant has an event "Swim class" on "2026-07-05"
    When the caller GETs /api/calendar/feed for tenant "khan"
    Then the feed response status is 200
    When an anonymous request fetches that subscribe url with the signature replaced by "deadbeefdeadbeef"
    Then the public feed response status is 404

  Scenario: A malformed token returns 404
    When an anonymous request fetches the public calendar feed at token "not-a-real-token"
    Then the public feed response status is 404

  Scenario: Rotating the feed key invalidates the old url and issues a working new one
    Given the "khan" tenant has an event "Swim class" on "2026-07-05"
    When the caller GETs /api/calendar/feed for tenant "khan"
    Then the feed response status is 200
    When the caller POSTs /api/calendar/feed/rotate for tenant "khan"
    Then the rotate response status is 200
    When an anonymous request fetches the pre-rotation subscribe url
    Then the pre-rotation public feed response status is 404
    When an anonymous request fetches that subscribe url
    Then the public feed response status is 200

  Scenario: Rotating the feed key is admin-only
    Given the "khan" tenant has a guest member "GuestUser"
    When a guest caller POSTs /api/calendar/feed/rotate for tenant "khan"
    Then the rotate response status is 403
