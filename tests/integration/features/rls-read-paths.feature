Feature: RLS read-path functions (FHS-354)

  SECURITY DEFINER readers let the limited app_runtime role do the few
  legitimately cross-tenant lookups (a user's memberships, invites by email)
  that plain RLS would otherwise block.

  Background:
    Given a user belongs to two families and has a pending invite in each

  Scenario: app_runtime reads a user memberships across families
    When app_runtime calls app_user_memberships for that user
    Then it returns both families
    And a plain members read as app_runtime returns nothing

  Scenario: app_runtime reads claimable invitations by email across families
    When app_runtime calls app_claimable_invitations for that email
    Then it returns both invites
