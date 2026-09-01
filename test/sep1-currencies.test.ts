import { describe, expect, it } from "vitest";
import { parseStellarToml } from "../src/checks/sep1.js";

describe("SEP-1 [[CURRENCIES]] validation", () => {
  const validIssuer = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const validContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  it("extracts and passes a fully conformant multi-asset block", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USD"
issuer = "${validIssuer}"
status = "live"
display_decimals = 2
name = "US Dollar"
anchor_asset_type = "fiat"
fixed_number = 1000000
is_asset_anchored = true
regulated = false

[[CURRENCIES]]
code = "BOND"
contract = "${validContract}"
status = "test"
display_decimals = 7
anchor_asset_type = "bond"
max_number = 50000
regulated = true
approval_server = "https://approval.example.com"
attestation_of_reserve = "https://example.com/reserves.pdf"
image = "https://example.com/bond.png"
toml = "https://example.com/asset.toml"
collateral_addresses = ["addr1", "addr2"]
collateral_address_signatures = ["sig1", "sig2"]

[[CURRENCIES]]
code_template = "USD?"
issuer = "${validIssuer}"
status = "private"
is_unlimited = true
`;

    const { toml, results } = parseStellarToml(rawToml);
    expect(toml.currencies).toBeDefined();
    expect(toml.currencies?.length).toBe(3);

    const currencyChecks = results.filter((r) => r.id.startsWith("sep1.currencies"));
    expect(currencyChecks.length).toBe(3);
    expect(currencyChecks.every((r) => r.status === "pass")).toBe(true);
  });

  it("remains silent when [[CURRENCIES]] is absent", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"
`;
    const { toml, results } = parseStellarToml(rawToml);
    expect(toml.currencies).toBeUndefined();
    expect(results.some((r) => r.id.startsWith("sep1.currencies"))).toBe(false);
  });

  it("fails when CURRENCIES is not an array of tables", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"
CURRENCIES = "not-an-array"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("must be an array");
  });

  it("fails when neither code nor code_template is declared", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
status = "live"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.code");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0]");
    expect(check?.message).toContain("must declare either 'code' or 'code_template'");
  });

  it("fails when code exceeds 12 characters", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "TOOLONGCODE123"
issuer = "${validIssuer}"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.code");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (TOOLONGCODE123)");
    expect(check?.message).toContain("code must be a string up to 12 characters");
  });

  it("fails when code_template exceeds 12 characters", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code_template = "TOOLONGTEMPLATE123"
issuer = "${validIssuer}"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.code_template");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (TOOLONGTEMPLATE123)");
    expect(check?.message).toContain("code_template must be a string up to 12 characters");
  });

  it("fails when code_template lacks '?' wildcard", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code_template = "INVALIDNOQ"
issuer = "${validIssuer}"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.code_template");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (INVALIDNOQ)");
    expect(check?.message).toContain("must include '?' pattern");
  });

  it("fails when issuer is not a valid ed25519 public key", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USDC"
issuer = "INVALID_KEY"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.issuer");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (USDC)");
    expect(check?.message).toContain("is not a valid Stellar ed25519 public key");
  });

  it("fails when contract is not a valid contract ID", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "SOROBAN"
contract = "INVALID_CONTRACT"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.contract");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (SOROBAN)");
    expect(check?.message).toContain("is not a valid Stellar contract ID");
  });

  it("fails when neither issuer nor contract is provided for Stellar asset", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USDC"
status = "live"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.issuer_or_contract");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (USDC)");
    expect(check?.message).toContain("must declare 'issuer' for Stellar assets");
  });

  it("fails on invalid status enum", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USDC"
issuer = "${validIssuer}"
status = "invalid-status"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.status");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (USDC)");
    expect(check?.message).toContain("status must be one of live, dead, test, private");
  });

  it("fails on invalid display_decimals", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USDC"
issuer = "${validIssuer}"
display_decimals = 9
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.display_decimals");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (USDC)");
    expect(check?.message).toContain("display_decimals must be an integer between 0 and 7");
  });

  it("warns when name exceeds 20 characters", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USDC"
issuer = "${validIssuer}"
name = "This name is way too long for SEP-1 recommendation"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.name");
    expect(check?.status).toBe("warn");
    expect(check?.severity).toBe("warning");
    expect(check?.message).toContain("CURRENCIES[0] (USDC)");
    expect(check?.message).toContain("name exceeds recommended maximum of 20 characters");
  });

  it("fails on invalid anchor_asset_type enum", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USDC"
issuer = "${validIssuer}"
anchor_asset_type = "unsupported_type"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.anchor_asset_type");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (USDC)");
    expect(check?.message).toContain("anchor_asset_type must be one of fiat, crypto");
  });

  it("fails when supply fields breach mutual exclusivity", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USDC"
issuer = "${validIssuer}"
fixed_number = 1000
max_number = 5000
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.supply_mutual_exclusivity");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (USDC)");
    expect(check?.message).toContain("fixed_number, max_number, and is_unlimited are mutually exclusive");
  });

  it("fails when is_asset_anchored or regulated are not booleans", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USDC"
issuer = "${validIssuer}"
is_asset_anchored = "true"
regulated = 1
`;
    const { results } = parseStellarToml(rawToml);
    const anchoredCheck = results.find((r) => r.id === "sep1.currencies.is_asset_anchored");
    const regulatedCheck = results.find((r) => r.id === "sep1.currencies.regulated");
    expect(anchoredCheck?.status).toBe("fail");
    expect(regulatedCheck?.status).toBe("fail");
  });

  it("fails when regulated is true but approval_server is missing or not HTTPS", () => {
    const tomlMissing = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "REG"
issuer = "${validIssuer}"
regulated = true
`;
    const { results: resMissing } = parseStellarToml(tomlMissing);
    const checkMissing = resMissing.find((r) => r.id === "sep1.currencies.approval_server");
    expect(checkMissing?.status).toBe("fail");
    expect(checkMissing?.message).toContain("approval_server is required when regulated is true");

    const tomlInsecure = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "REG"
issuer = "${validIssuer}"
regulated = true
approval_server = "http://insecure.example.com/approval"
`;
    const { results: resInsecure } = parseStellarToml(tomlInsecure);
    const checkInsecure = resInsecure.find((r) => r.id === "sep1.currencies.approval_server");
    expect(checkInsecure?.status).toBe("fail");
    expect(checkInsecure?.message).toContain("must use the https: scheme");
  });

  it("fails when URL fields are invalid", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USDC"
issuer = "${validIssuer}"
image = "not-a-valid-url"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.image");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (USDC)");
    expect(check?.message).toContain('image "not-a-valid-url" is not a valid absolute URL');
  });

  it("fails when collateral_address_signatures count does not match collateral_addresses", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validIssuer}"

[[CURRENCIES]]
code = "USDC"
issuer = "${validIssuer}"
collateral_addresses = ["addr1", "addr2"]
collateral_address_signatures = ["sig1"]
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.currencies.collateral_signatures");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CURRENCIES[0] (USDC)");
    expect(check?.message).toContain("collateral_address_signatures length (1) must match collateral_addresses length (2)");
  });
});
