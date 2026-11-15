import { describe, expect, it } from "vitest";
import fixtureData from "../../contract/fixtures/rule_parity_snapshots.json";
import { runOfflineDeterministicQc } from "../../../extension/src/content/offlineQcEngine";
import type { QCAnalyzeRequest, RuleProfile } from "../../../extension/src/shared/types";

describe("Cross-engine rule-logic parity (TS offlineQcEngine vs shared fixtures)", () => {
  const profile = fixtureData.profile as unknown as RuleProfile;

  for (const testCase of fixtureData.cases) {
    it(`matches shared parity fixture: ${testCase.name}`, async () => {
      const req = testCase.request as unknown as QCAnalyzeRequest;
      const resp = await runOfflineDeterministicQc(req, profile);

      const actual = resp.findings
        .map((f) => `${f.ruleId}:${f.severity}`)
        .sort();
      const expected = testCase.expected
        .map((e) => `${e.ruleId}:${e.severity}`)
        .sort();

      expect(actual).toEqual(expected);
    });
  }
});
