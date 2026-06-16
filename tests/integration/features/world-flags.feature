Feature: World Flags Progress (Learn Phase 2a + 2b)
  Real Postgres on :5433 — verifies the member-scoped world flags endpoints:
  explore (mark/list/idempotency/isolation) and the structured learn path
  (complete a set, read progress, idempotency, member isolation).

  Background:
    Given the world-flags test DB is clean
    And a users mirror row exists for the world-flags test caller
    And a tenant "flagfamily" exists with the world-flags caller as admin
    And the "flagfamily" tenant has a child "Zara"
    And a second child "Leo" also exists in "flagfamily"

  Scenario: Explore a flag and read it back
    When the caller explores country "GB" for "Zara" in "flagfamily"
    Then the explore response status is 200
    And the explore body has explored true
    When the caller gets explored flags for "Zara" in "flagfamily"
    Then the explored list contains "GB"
    And the explored list has 1 code

  Scenario: Exploring the same flag twice is idempotent — one row in DB
    When the caller explores country "US" for "Zara" in "flagfamily"
    And the caller explores country "US" for "Zara" in "flagfamily"
    When the caller gets explored flags for "Zara" in "flagfamily"
    Then the explored list contains "US"
    And the explored list has 1 code

  Scenario: Tenant isolation — another member sees no explored flags
    When the caller explores country "JP" for "Zara" in "flagfamily"
    When the caller gets explored flags for "Leo" in "flagfamily"
    Then the explored list has 0 codes

  Scenario: Complete a learn-path set and read progress back
    When the caller completes set 0 of "Africa" for "Zara" in "flagfamily"
    Then the learn-complete response status is 200
    And the learn-complete body has completed true
    When the caller gets learn progress for "Zara" in "flagfamily"
    Then the learn progress for "Africa" contains set 0

  Scenario: Completing the same set twice is idempotent — one entry
    When the caller completes set 1 of "Europe" for "Zara" in "flagfamily"
    When the caller gets learn progress for "Zara" in "flagfamily"
    Then the learn progress for "Europe" has 1 completed set

  Scenario: Member isolation — another child sees no completed sets
    When the caller completes set 0 of "Asia" for "Zara" in "flagfamily"
    When the caller gets learn progress for "Leo" in "flagfamily"
    Then the learn progress is empty
