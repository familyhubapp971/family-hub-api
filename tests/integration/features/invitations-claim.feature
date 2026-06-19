Feature: POST /api/invitations/claim (FHS-354)

  Claiming finds pending invites by email across families via the SECURITY
  DEFINER function (app_claimable_invitations), then creates/links the member
  seat and accepts the invite.

  Background:
    Given a user with a seatless pending invite to a family

  Scenario: claiming creates the seat and accepts the invite
    When the user POSTs to claim their invites
    Then the claim status is 200
    And the claimed list includes their family
    And a member seat now exists for the user
    And the invitation is accepted
