import type { CheckResult } from "../core/report.js";

/**
 * Standard KYC field names from SEP-9
 * (https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0009.md,
 * v1.18.0). SEP-9 permits anchors to define custom fields outside this set, so an
 * unrecognized key is only ever a warning, never a fail.
 */
export const SEP9_STANDARD_FIELDS = new Set<string>([
  // Natural Person Fields
  "family_name",
  "last_name",
  "given_name",
  "first_name",
  "additional_name",
  "address_country_code",
  "state_or_province",
  "city",
  "postal_code",
  "address",
  "mobile_number",
  "mobile_number_format",
  "email_address",
  "birth_date",
  "birth_place",
  "birth_country_code",
  "tax_id",
  "tax_id_name",
  "occupation",
  "employer_name",
  "employer_address",
  "language_code",
  "id_type",
  "id_country_code",
  "id_issue_date",
  "id_expiration_date",
  "id_number",
  "photo_id_front",
  "photo_id_back",
  "notary_approval_of_photo_id",
  "ip_address",
  "photo_proof_residence",
  "sex",
  "proof_of_income",
  "proof_of_liveness",
  "referral_id",
  // Financial Account Fields
  "bank_name",
  "bank_account_type",
  "bank_account_number",
  "bank_number",
  "bank_phone_number",
  "bank_branch_number",
  "external_transfer_memo",
  "clabe_number",
  "cbu_number",
  "cbu_alias",
  "mobile_money_number",
  "mobile_money_provider",
  "crypto_address",
  "crypto_memo",
  // Organization Fields
  "organization.name",
  "organization.VAT_number",
  "organization.registration_number",
  "organization.registration_date",
  "organization.registered_address",
  "organization.number_of_shareholders",
  "organization.shareholder_name",
  "organization.photo_incorporation_doc",
  "organization.photo_proof_address",
  "organization.address_country_code",
  "organization.state_or_province",
  "organization.city",
  "organization.postal_code",
  "organization.director_name",
  "organization.website",
  "organization.email",
  "organization.phone",
  // Card Fields
  "card.number",
  "card.expiration_date",
  "card.cvc",
  "card.holder_name",
  "card.network",
  "card.postal_code",
  "card.country_code",
  "card.state_or_province",
  "card.city",
  "card.address",
  "card.token",
]);

const VALID_FIELD_TYPES = new Set(["string", "binary", "number", "date"]);

const VALID_PROVIDED_FIELD_STATUSES = new Set([
  "ACCEPTED",
  "PROCESSING",
  "NEEDS_INFO",
  "REJECTED",
  "VERIFICATION_REQUIRED",
]);

type FieldsObjectKind = "fields" | "provided_fields";

function describe(value: unknown): string {
  return value === undefined ? "missing" : JSON.stringify(value);
}

function validateFieldEntry(
  key: string,
  entry: unknown,
  kind: FieldsObjectKind,
  results: CheckResult[],
): void {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    results.push({
      id: `sep12.${kind}.entry_shape`,
      description: `${kind} entry must be an object`,
      status: "fail",
      severity: "error",
      message: `${kind}.${key} must be an object, got ${Array.isArray(entry) ? "array" : typeof entry}`,
    });
    return;
  }

  const e = entry as Record<string, unknown>;

  if (!SEP9_STANDARD_FIELDS.has(key)) {
    results.push({
      id: `sep12.${kind}.unknown_name`,
      description: `${kind} key should be a recognized SEP-9 field name`,
      status: "warn",
      severity: "warning",
      message: `${kind}.${key}: "${key}" is not a standard SEP-9 field name (SEP-9 permits custom fields, but this may also be a typo of a standard name)`,
    });
  }

  if (typeof e.type !== "string" || !VALID_FIELD_TYPES.has(e.type)) {
    results.push({
      id: `sep12.${kind}.type`,
      description: `${kind} entry must declare a valid type`,
      status: "fail",
      severity: "error",
      message: `${kind}.${key}: type must be one of string, binary, number, date (got ${describe(e.type)})`,
    });
  }

  if (typeof e.description !== "string" || e.description.trim().length === 0) {
    results.push({
      id: `sep12.${kind}.description`,
      description: `${kind} entry must declare a description`,
      status: "fail",
      severity: "error",
      message: `${kind}.${key}: description is required and must be a non-empty string (got ${describe(e.description)})`,
    });
  }

  if (e.choices !== undefined && !Array.isArray(e.choices)) {
    results.push({
      id: `sep12.${kind}.choices`,
      description: `${kind} entry choices must be an array`,
      status: "fail",
      severity: "error",
      message: `${kind}.${key}: choices must be an array, got ${typeof e.choices}`,
    });
  }

  if (e.optional !== undefined && typeof e.optional !== "boolean") {
    results.push({
      id: `sep12.${kind}.optional`,
      description: `${kind} entry optional must be a boolean`,
      status: "fail",
      severity: "error",
      message: `${kind}.${key}: optional must be a boolean, got ${typeof e.optional}`,
    });
  }

  if (kind === "provided_fields" && e.status !== undefined) {
    if (typeof e.status !== "string" || !VALID_PROVIDED_FIELD_STATUSES.has(e.status)) {
      results.push({
        id: "sep12.provided_fields.status",
        description: "provided_fields entry status must be a valid enum value",
        status: "fail",
        severity: "error",
        message: `provided_fields.${key}: status must be one of ${[...VALID_PROVIDED_FIELD_STATUSES].join(", ")} (got ${describe(e.status)})`,
      });
    } else if (e.status === "REJECTED" && (typeof e.error !== "string" || e.error.trim().length === 0)) {
      results.push({
        id: "sep12.provided_fields.rejected_no_error",
        description: "REJECTED provided_fields entry should include an error message",
        status: "warn",
        severity: "warning",
        message: `provided_fields.${key}: status is REJECTED but no 'error' message was given explaining why`,
      });
    }
  }
}

function validateFieldsObject(
  value: unknown,
  kind: FieldsObjectKind,
  results: CheckResult[],
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    results.push({
      id: `sep12.${kind}.shape`,
      description: `${kind} must be an object keyed by SEP-9 field name`,
      status: "fail",
      severity: "error",
      message: `${kind} must be an object, got ${Array.isArray(value) ? "array" : typeof value}`,
    });
    return undefined;
  }

  const obj = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(obj)) {
    validateFieldEntry(key, entry, kind, results);
  }
  return obj;
}

/**
 * Validates the `fields` and `provided_fields` objects returned by GET /customer,
 * per SEP-12. Both are optional on the wire; `customerStatus` is the sibling
 * `status` field, used to cross-check the NEEDS_INFO/fields relationship.
 */
export function validateSep12Fields(
  fields: unknown,
  providedFields: unknown,
  customerStatus: string | undefined,
  results: CheckResult[],
): void {
  const fieldsObj = validateFieldsObject(fields, "fields", results);
  validateFieldsObject(providedFields, "provided_fields", results);

  if (customerStatus === "NEEDS_INFO" && (!fieldsObj || Object.keys(fieldsObj).length === 0)) {
    results.push({
      id: "sep12.fields.needs_info_empty",
      description: "NEEDS_INFO customer status must be paired with a non-empty fields object",
      status: "fail",
      severity: "error",
      message: `Customer status is NEEDS_INFO but 'fields' is ${fieldsObj ? "empty" : "absent"}; the wallet has no way to know what information to collect`,
    });
  }
}
