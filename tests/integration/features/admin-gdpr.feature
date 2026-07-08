Feature: Admin GDPR — export my data + delete my account (FHS-435)
  Real Postgres on :5433. GET /api/admin/export and POST /api/admin/delete-account
  are admin-only and tenant-scoped. Delete-account is IRREVERSIBLE, so every
  scenario here proves both endpoints never touch another family's data, and
  that nothing is deleted unless the confirmation matches exactly.

  Background:
    Given the test Postgres has clean admin-gdpr tables
    And a users mirror row exists for the admin-gdpr test caller
    And admin-gdpr tenants "jones" and "smith" each exist with the caller as an admin member
    And every tenant-scoped table has one fixture row for both "jones" and "smith"

  Scenario: Export returns only the caller's own tenant data
    When the caller exports data for tenant "jones"
    Then the export response status is 200
    And the export response is a downloadable JSON file
    And every exported table for "jones" contains only "jones" rows

  Scenario: Export is admin-only
    Given the "jones" tenant has a guest member "GuestUser"
    When a guest caller exports data for tenant "jones"
    Then the export response status is 403

  Scenario: Delete-account with the wrong confirmation is rejected and deletes nothing
    When the caller deletes the account for tenant "jones" confirming "Not The Right Name"
    Then the delete-account response status is 400
    And the delete-account response errorCode is "CONFIRM_MISMATCH"
    And every tenant-scoped table still has its fixture row for tenant "jones"
    And tenant "jones" still exists

  Scenario: Delete-account is admin-only
    Given the "jones" tenant has a guest member "GuestUser"
    When a guest caller deletes the account for tenant "jones" confirming "jones Family"
    Then the delete-account response status is 403
    And tenant "jones" still exists

  Scenario: Delete-account with the correct confirmation removes the tenant and everything it owns
    When the caller deletes the account for tenant "jones" confirming "jones Family"
    Then the delete-account response status is 200
    And tenant "jones" no longer exists
    And every tenant-scoped table has zero rows for tenant "jones"
    And the caller's users-mirror row still exists
    And tenant "smith" still exists
    And every tenant-scoped table still has its fixture row for tenant "smith"
