// The answer bank's code-only matching must never hand a saved answer to a different question
// (Phase 3 review): negations, countries, company names and numbers keep questions apart.
import { describe, expect, it } from "vitest";
import { exactMatch, looksSensitive, normalize, type SavedAnswer } from "../../src/memory/answers.js";

const saved = (question: string, answer: string): SavedAnswer => ({ id: question, question, normalized: normalize(question), answer, askedAt: [1], updatedAt: 1 });

describe("answer bank: exact matching in code", () => {
  const bank = [
    saved("Are you legally authorized to work in the United States without employer sponsorship today?", "No"),
    saved("Will you now or in the future require sponsorship for employment visa status?", "Yes"),
    saved("Do you have relatives or close friends currently employed by Stripe in any capacity?", "No"),
    saved("Have you previously worked for this company as a contractor or full-time employee?", "No"),
    saved("What year did you graduate from high school?", "2022")
  ];
  it("matches the same question with different punctuation, case and filler words", () => {
    expect(exactMatch(bank, "what year did you graduate from high school")?.answer).toBe("2022");
    expect(exactMatch(bank, "What year did you graduate from HIGH SCHOOL? (required)")?.answer).toBe("2022");
  });
  it("never matches a question that differs in a negation, country, company or number", () => {
    expect(exactMatch(bank, "Are you legally authorized to work in the United Kingdom without employer sponsorship today?")).toBeNull();
    expect(exactMatch(bank, "Will you now or in the future not require sponsorship for employment visa status?")).toBeNull();
    expect(exactMatch(bank, "Do you have relatives or close friends currently employed by Plaid in any capacity?")).toBeNull();
    expect(exactMatch(bank, "Have you previously worked for this company as a contractor or part-time employee?")).toBeNull();
    expect(exactMatch(bank, "What year did you graduate from college?")).toBeNull();
  });
  it("refuses to store secrets: card or account numbers, SSN/passport/password questions", () => {
    expect(looksSensitive("Card number", "4111 1111 1111 1111")).toBe(true);
    expect(looksSensitive("Bank account", "000123456789")).toBe(true);
    expect(looksSensitive("Social Security Number", "123456789")).toBe(true);
    expect(looksSensitive("Passport number", "N1234567")).toBe(true);
    expect(looksSensitive("What is your password?", "hunter2")).toBe(true);
    expect(looksSensitive("ZIP code", "17325-1400")).toBe(false);
    expect(looksSensitive("Phone", "+1 717 555 0100")).toBe(false);
    expect(looksSensitive("High school graduation year", "2022")).toBe(false);
  });
});
