Feature: Kid World Flags (FHS-373)
  Real Postgres on :5433 — verifies the kid-scoped world flags endpoints.
  A kid's identity comes from the kid token, not a memberId parameter.
  These tests verify explore, learn-complete, and member isolation.

  Background:
    Given a family with kid "Amira" and sibling "Zayd"

  Scenario: a kid explores a flag and sees it back
    When "Amira" POSTs /api/kid/world-flags/explore with countryCode "GB"
    Then the kid explore response status is 200
    And the kid explore body has explored true
    When "Amira" GETs /api/kid/world-flags
    Then the kid world-flags response status is 200
    And the kid explored list contains "GB"

  Scenario: exploring the same flag twice is idempotent
    When "Amira" POSTs /api/kid/world-flags/explore with countryCode "US"
    And "Amira" POSTs /api/kid/world-flags/explore with countryCode "US"
    When "Amira" GETs /api/kid/world-flags
    Then the kid explored list has 1 code

  Scenario: a kid only sees their own flags — not their sibling's
    When "Amira" POSTs /api/kid/world-flags/explore with countryCode "JP"
    When "Zayd" GETs /api/kid/world-flags
    Then the kid explored list has 0 codes

  Scenario: a kid completes a learn-path set and sees it back
    When "Amira" POSTs /api/kid/world-flags/learn-complete with continent "Africa" chunkIndex 0
    Then the kid learn-complete response status is 200
    And the kid learn-complete body has completed true
    When "Amira" GETs /api/kid/world-flags/learn
    Then the kid learn response status is 200
    And the kid learn progress for "Africa" contains set 0

  Scenario: completing the same set twice is idempotent
    When "Amira" POSTs /api/kid/world-flags/learn-complete with continent "Europe" chunkIndex 1
    And "Amira" POSTs /api/kid/world-flags/learn-complete with continent "Europe" chunkIndex 1
    When "Amira" GETs /api/kid/world-flags/learn
    Then the kid learn progress for "Europe" has 1 completed set

  Scenario: a kid only sees their own learn progress — not their sibling's
    When "Amira" POSTs /api/kid/world-flags/learn-complete with continent "Asia" chunkIndex 0
    When "Zayd" GETs /api/kid/world-flags/learn
    Then the kid learn progress is empty
