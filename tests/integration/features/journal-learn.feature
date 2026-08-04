Feature: ChildWorld Journal (FHS-270)
  Real Postgres on :5433, verifies the kid-private journal (scoped per
  member), tenant-scoped.

  Background:
    Given the test Postgres has clean tenants, members, journal, and learn tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member
    And the "khan" tenant has children "Ali" and "Bilal"

  Scenario: Posting a journal entry and reading it back
    When the caller posts a journal entry "Today was fun" for "Ali" in tenant "khan"
    Then the journal post status is 201
    And in tenant "khan", "Ali" has 1 journal entries and "Bilal" has 0

  Scenario: Tenant isolation: another tenant's journal never appears
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has a child member "Sam"
    And the caller posts a journal entry "Secret" for "Sam" in tenant "smith"
    When the caller GETs journal for "Ali" in tenant "khan"
    Then the journal response status is 200
    And the journal response has 0 entries
