import { describe, it, expect } from "vitest";
import {
  DEFAULT_CODE_INTERPRETER_MAX_FILE_BYTES,
  readCodeInterpreterMaxFileBytes,
} from "./code-interpreter-constants";

describe("readCodeInterpreterMaxFileBytes: one size limit for the editor and the chat start", () => {
  it("takes MAX_PERSONA_CI_DOCUMENT_SIZE first", () => {
    expect(
      readCodeInterpreterMaxFileBytes({
        MAX_PERSONA_CI_DOCUMENT_SIZE: "1000",
        NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE: "2000",
      }),
    ).toBe(1000);
  });

  it("then NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE", () => {
    expect(readCodeInterpreterMaxFileBytes({ NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE: "2000" })).toBe(2000);
  });

  it.each([[""], ["abc"], ["0"], ["-5"], ["1.5"]])(
    "skips a MAX_PERSONA_CI_DOCUMENT_SIZE of %j and uses the next value",
    (bad) => {
      expect(
        readCodeInterpreterMaxFileBytes({
          MAX_PERSONA_CI_DOCUMENT_SIZE: bad,
          NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE: "2000",
        }),
      ).toBe(2000);
    },
  );

  it("else 512 MB", () => {
    expect(readCodeInterpreterMaxFileBytes({})).toBe(512 * 1024 * 1024);
    expect(DEFAULT_CODE_INTERPRETER_MAX_FILE_BYTES).toBe(536870912);
  });
});
