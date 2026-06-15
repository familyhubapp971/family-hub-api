Feature: Reading Log (Learn Phase 1)
  Real Postgres on :5433 — verifies the member-scoped reading log:
  add a book, list it, mark finished, and confirm tenant isolation.

  Background:
    Given the reading-log test DB is clean
    And a users mirror row exists for the reading-log test caller
    And a tenant "readalot" exists with the reading-log caller as admin
    And the "readalot" tenant has a child "Aisha"
    And a second child "Omar" also exists in "readalot"

  Scenario: Add a book and read it back
    When the caller adds a book "Matilda" by "Roald Dahl" for "Aisha" in "readalot"
    Then the add-book response status is 201
    And the response book title is "Matilda"
    When the caller lists books for "Aisha" in "readalot"
    Then the list response has 1 book
    And book 0 title is "Matilda"
    And book 0 finished is false

  Scenario: Mark a book as finished
    Given the caller adds a book "The BFG" by "Roald Dahl" for "Aisha" in "readalot"
    When the caller marks book "The BFG" as finished for "Aisha" in "readalot"
    Then the patch-book response status is 200
    And the patched book finished is true
    When the caller lists books for "Aisha" in "readalot"
    Then book 0 finished is true

  Scenario: Delete a book
    Given the caller adds a book "James and the Giant Peach" by "Roald Dahl" for "Aisha" in "readalot"
    When the caller deletes book "James and the Giant Peach" for "Aisha" in "readalot"
    Then the delete response status is 204
    When the caller lists books for "Aisha" in "readalot"
    Then the list response has 0 books

  Scenario: Tenant isolation — another member sees no books
    Given the caller adds a book "Secret Book" by "Author" for "Aisha" in "readalot"
    When the caller lists books for "Omar" in "readalot"
    Then the list response has 0 books
