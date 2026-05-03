Feature: POST /api/invitations (FHS-91)
  Real Postgres on :5433 — verifies the route inserts a pending
  invitation row, the partial unique index blocks double-invites
  within a tenant, and a different tenant can still invite the same
  email (cross-tenant isolation).

  Background:
    Given the test Postgres has clean tenants, members, and pending_invitations tables
    And a users mirror row exists for the test inviter
    And a tenant "khan" exists with the inviter as an admin member

  Scenario: Happy path — admin invites a new email, row stored as pending
    When the inviter POSTs an invitation for "invitee@example.com" as "adult"
    Then the response status is 201
    And exactly 1 row exists in pending_invitations with email "invitee@example.com" and status "pending"
    And Supabase admin invite was called once with redirect_to containing "invite="

  Scenario: Same tenant cannot double-invite the same email while one is pending
    Given the inviter has an outstanding pending invite for "invitee@example.com"
    When the inviter POSTs an invitation for "invitee@example.com" as "adult"
    Then the response status is 409
    And exactly 1 row exists in pending_invitations with email "invitee@example.com" and status "pending"

  Scenario: A different tenant CAN invite the same email
    Given a second tenant "smith" exists with the inviter as an admin member
    And the inviter has an outstanding pending invite for "invitee@example.com" in tenant "khan"
    When the inviter POSTs an invitation for "invitee@example.com" as "adult" in tenant "smith"
    Then the response status is 201
    And exactly 2 rows exist in pending_invitations with email "invitee@example.com" and status "pending"
