import { describe, expect, test } from "vitest";
import { refParamFrom } from "../src/commands/init";

describe("init writes ref_param from the server", () => {
  test("via from the init response", () => {
    expect(refParamFrom({ link_param: "via" })).toBe("via");
  });
  test("aff from the init response", () => {
    expect(refParamFrom({ link_param: "aff" })).toBe("aff");
  });
  test("an older server without the field: aff", () => {
    expect(refParamFrom({})).toBe("aff");
  });
  test("an unknown value: aff", () => {
    expect(refParamFrom({ link_param: "ref" })).toBe("aff");
  });
});
