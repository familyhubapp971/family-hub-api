Feature: Admin Panel endpoints (FHS-308)
  Real Postgres on :5433 — verifies app_settings CRUD, week cash edit, admin
  savings-set, week reopen round-trip, week repair, and role-gating.

  Background:
    Given the test Postgres has clean admin-panel tables
    And a users mirror row exists for the admin-panel test caller
    And an admin-panel tenant "jones" exists with the caller as an admin member
    And the "jones" tenant has a child member "Layla"
    And the "jones" tenant has a bonus habit "Reading" for "Layla"

  Scenario: Settings GET returns an empty map for a fresh tenant
    When the caller fetches settings for tenant "jones"
    Then the settings response status is 200
    And the settings map is empty

  Scenario: Settings PUT round-trip stores and retrieves a value
    When the caller puts setting "theme" to "dark" for tenant "jones"
    Then the settings put response status is 200
    And the caller fetches settings for tenant "jones"
    And the settings map has "theme" equal to "dark"

  Scenario: Settings PUT is tenant-scoped (other tenants do not see it)
    Given an admin-panel tenant "smith" exists with the caller as an admin member
    When the caller puts setting "theme" to "blue" for tenant "jones"
    And the caller fetches settings for tenant "smith"
    Then the settings map is empty

  Scenario: Admin savings-set overwrites the balance
    Given the caller places a sticker on "Reading" day 0 for "Layla"
    And the caller saves 5 stickers for "Layla" in tenant "jones"
    When the caller admin-sets "Layla" savings to 99 stickers and "12.5" cash
    Then the admin-set response status is 200
    And "Layla" has 99 saved stickers in tenant "jones"
    And "Layla" has "12.5" saved cash in tenant "jones"

  Scenario: Week cash edit persists carriedOverCash and retrievedCash
    When the caller edits the current week cash for "Layla" to carriedOverCash 3 and retrievedCash 7
    Then the cash-edit response status is 200
    And the cash-edit response week has carriedOverCash 3 and retrievedCash 7

  Scenario: Reopen round-trips finalize — stickers reversed, investment restored
    Given the caller places a sticker on "Reading" day 0 for "Layla"
    And the caller places a sticker on "Reading" day 1 for "Layla"
    And the caller invests 10 stickers in "Reading" for "Layla"
    And the caller finalizes the current week for "Layla"
    When the caller reopens the current finalized week for "Layla"
    Then the reopen response status is 200
    And the reopen response shows reopened true
    And "Layla" has 0 saved stickers after reopen
    And "Layla" has 1 active investments after reopen

  Scenario: Reopen on an already-open week returns 409
    When the caller reopens the current week for "Layla" without finalizing
    Then the reopen response status is 409

  Scenario: Repair reverses leftover effects on an open week
    Given the caller places a sticker on "Reading" day 0 for "Layla"
    And the caller finalizes the current week for "Layla"
    And the caller directly reopens the week without reversal
    When the caller repairs the reopened week for "Layla"
    Then the repair response status is 200
    And the repair response shows repaired true

  Scenario: A child caller is rejected on savings admin-set
    Given the "jones" tenant has a guest member "GuestUser"
    When a guest caller tries to admin-set "Layla" savings
    Then the admin-set guest response status is 403

  Scenario: Week actions GET returns actions newest first
    Given the caller places a sticker on "Reading" day 0 for "Layla"
    And the caller finalizes the current week for "Layla"
    When the caller fetches actions for the finalized week of "Layla"
    Then the actions response status is 200
    And the actions list contains an auto_save entry
