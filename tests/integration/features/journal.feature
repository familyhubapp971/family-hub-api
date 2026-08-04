Feature: Per-day journal (FHS-270)
  Real Postgres on :5433, verifies the per-day journal upsert model.
  One entry per (member, date); PUT twice on the same day updates the row.
  All fields round-trip correctly. Tenant isolation holds.

  Background:
    Given the journal test DB is clean
    And a users mirror row exists for the journal test caller
    And a journal tenant "jonesj" exists with the caller as an admin member
    And the "jonesj" tenant has a child "Zara"

  Scenario: PUT creates a new entry for a day
    When the caller PUTs a journal entry for "Zara" in "jonesj" on "2026-06-15" with mood "excited" and body "Great day"
    Then the journal PUT status is 200
    And the journal entry for "Zara" in "jonesj" on "2026-06-15" has mood "excited" and body "Great day"

  Scenario: PUT same day twice updates the existing row (one row only)
    When the caller PUTs a journal entry for "Zara" in "jonesj" on "2026-06-15" with mood "happy" and body "First save"
    And the caller PUTs a journal entry for "Zara" in "jonesj" on "2026-06-15" with mood "sad" and body "Updated"
    Then the journal entry for "Zara" in "jonesj" on "2026-06-15" has mood "sad" and body "Updated"
    And "Zara" in "jonesj" has exactly 1 journal entry total

  Scenario: GET by date round-trips mood, gratitude, body, creativity, and quoteIndex
    When the caller PUTs a full journal entry for "Zara" in "jonesj" on "2026-06-14"
    Then the GET by date for "Zara" in "jonesj" on "2026-06-14" returns all fields correctly
    And the GET by date response includes a quoteIndex number

  Scenario: Tenant isolation: another tenant's entries never appear
    Given a second journal tenant "brownsj" exists with the caller as an admin member
    And the "brownsj" tenant has a child "Leo"
    And the caller PUTs a journal entry for "Leo" in "brownsj" on "2026-06-15" with mood "happy" and body "Private"
    When the caller GETs journal entries for "Zara" in "jonesj"
    Then the journal entries list for "Zara" has 0 entries
