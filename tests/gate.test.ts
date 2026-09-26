import { expect, test } from "bun:test";
import { consequential } from "../src/gate.ts";

test("a label that commits something is asked about in every form it takes", () => {
  const commits = [
    "Send", "Sending", "Sent", "Buy now", "Bought", "Pay", "Paying", "Paid", "Place order", "Ordered", "Book", "Booking",
    "Delete", "Deletes", "Deleted", "Deleting", "Remove", "Removed", "Removing", "Post", "Posted", "Submit", "Submitted",
    "Submitting", "Confirm", "Confirmed", "Publish", "Published", "Purchase", "Purchased", "Checkout", "Check out", "Check-out",
    "Transfer", "Transferred",
  ]; // prettier-ignore
  expect(commits.filter((label) => !consequential(label))).toEqual([]);
});

test("a label that only reads alike is not: an ordinary step stays one request", () => {
  const plain = ["Sentence case", "Payment history", "Bookmarks", "Remote", "Postcode", "Submarine", "Deletion policy", "Pricing", "Open", "Search"];
  expect(plain.filter(consequential)).toEqual([]);
});
