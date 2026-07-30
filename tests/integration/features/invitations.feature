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

  Scenario: A failed invite rolls back the seat — no ghost member (FHS-352)
    When the Supabase invite fails and the inviter POSTs a named invitation for "Ghost Seat" at "ghost@example.com"
    Then the response status is 502
    And no member seat remains named "Ghost Seat"
    And no pending invitation remains for "ghost@example.com"

  Scenario: Inviting an already-registered email returns a clear 409 (FHS-352)
    When Supabase rejects the invite as already-registered and the inviter POSTs a named invitation for "Existing Person" at "exists@example.com"
    Then the response status is 409
    And the error detail mentions "already has a Family Hub account"
    And no member seat remains named "Existing Person"

  Scenario: A normal user (adult, non-admin) cannot invite someone as admin (FHS-486)
    Given the inviter is a normal user (adult), not an admin, in tenant "khan"
    When the inviter POSTs an invitation for "wannabe-admin@example.com" as "admin"
    Then the response status is 403
    And exactly 0 rows exist in pending_invitations with email "wannabe-admin@example.com" and status "pending"

  Scenario: An admin can invite a co-admin (FHS-486)
    When the inviter POSTs an invitation for "partner@example.com" as "admin"
    Then the response status is 201
    And exactly 1 row exists in pending_invitations with email "partner@example.com" and status "pending"
    And that invitation was persisted with role "admin"
