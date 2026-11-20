import { describe, it, expect } from "vitest";
import { isValidId, odataEq, odataSearchIn, odataString } from "./odata-filter";

describe("odata-filter", () => {
  it("accepts ids the app writes", () => {
    expect(isValidId("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe(true);
    expect(isValidId("aZ09")).toBe(true);
    expect(isValidId("3f2c1a7e-0b7d-4c5e-9a4f-6f1d2e3c4b5a")).toBe(true);
    expect(isValidId("a".repeat(64))).toBe(true);
  });

  it("refuses values outside the id charset", () => {
    for (const value of ["", "a,b", "a'b", "a b", "a/b", "a)", "a".repeat(129)]) {
      expect(isValidId(value)).toBe(false);
    }
    expect(isValidId(undefined)).toBe(false);
    expect(isValidId(42)).toBe(false);
  });

  it("doubles single quotes in a string literal", () => {
    expect(odataString("it's")).toBe("'it''s'");
    expect(odataEq("user", "x' or true or user eq '")).toBe(
      "user eq 'x'' or true or user eq '''"
    );
  });

  it("keeps only valid ids in search.in", () => {
    expect(odataSearchIn("personaDocumentId", ["a", "b,c", "d'e", "f", "a"])).toBe(
      "search.in(personaDocumentId, 'a,f', ',')"
    );
    expect(odataSearchIn("personaDocumentId", ["b,c"])).toBeUndefined();
    expect(odataSearchIn("personaDocumentId", [])).toBeUndefined();
  });
});
