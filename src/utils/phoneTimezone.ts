import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Best-guess inference of a brand's timezone from the WhatsApp phone
 * number we already have on `brand_channels.external_id`. Used during
 * onboarding so Duffy can ask "you in Israel, right?" instead of
 * making the user type "Asia/Jerusalem".
 *
 * The mapping intentionally picks ONE primary IANA zone per country.
 * For multi-zone countries (US, CA, RU, AU, BR) we pick the most-likely
 * default; the user can always correct it during the confirm or later
 * via Duffy's `updateBrandContext` tool.
 */

type CountryEntry = {
  /** Primary IANA timezone for the country. */
  timezone: string;
  /** Friendly label for user-facing copy. */
  label: string;
};

const COUNTRY_TO_TIMEZONE: Partial<Record<CountryCode, CountryEntry>> = {
  // Middle East
  IL: { timezone: 'Asia/Jerusalem', label: 'Israel' },
  AE: { timezone: 'Asia/Dubai', label: 'the UAE' },
  SA: { timezone: 'Asia/Riyadh', label: 'Saudi Arabia' },
  TR: { timezone: 'Europe/Istanbul', label: 'Turkey' },

  // North America (best-guess default; user can correct)
  US: { timezone: 'America/New_York', label: 'the US' },
  CA: { timezone: 'America/Toronto', label: 'Canada' },
  MX: { timezone: 'America/Mexico_City', label: 'Mexico' },

  // Europe
  GB: { timezone: 'Europe/London', label: 'the UK' },
  IE: { timezone: 'Europe/Dublin', label: 'Ireland' },
  ES: { timezone: 'Europe/Madrid', label: 'Spain' },
  PT: { timezone: 'Europe/Lisbon', label: 'Portugal' },
  FR: { timezone: 'Europe/Paris', label: 'France' },
  DE: { timezone: 'Europe/Berlin', label: 'Germany' },
  NL: { timezone: 'Europe/Amsterdam', label: 'the Netherlands' },
  BE: { timezone: 'Europe/Brussels', label: 'Belgium' },
  IT: { timezone: 'Europe/Rome', label: 'Italy' },
  CH: { timezone: 'Europe/Zurich', label: 'Switzerland' },
  AT: { timezone: 'Europe/Vienna', label: 'Austria' },
  SE: { timezone: 'Europe/Stockholm', label: 'Sweden' },
  NO: { timezone: 'Europe/Oslo', label: 'Norway' },
  DK: { timezone: 'Europe/Copenhagen', label: 'Denmark' },
  FI: { timezone: 'Europe/Helsinki', label: 'Finland' },
  PL: { timezone: 'Europe/Warsaw', label: 'Poland' },
  CZ: { timezone: 'Europe/Prague', label: 'Czechia' },
  GR: { timezone: 'Europe/Athens', label: 'Greece' },
  RO: { timezone: 'Europe/Bucharest', label: 'Romania' },
  HU: { timezone: 'Europe/Budapest', label: 'Hungary' },
  UA: { timezone: 'Europe/Kyiv', label: 'Ukraine' },
  RU: { timezone: 'Europe/Moscow', label: 'Russia' },

  // South America
  BR: { timezone: 'America/Sao_Paulo', label: 'Brazil' },
  AR: { timezone: 'America/Argentina/Buenos_Aires', label: 'Argentina' },
  CL: { timezone: 'America/Santiago', label: 'Chile' },
  CO: { timezone: 'America/Bogota', label: 'Colombia' },
  PE: { timezone: 'America/Lima', label: 'Peru' },
  UY: { timezone: 'America/Montevideo', label: 'Uruguay' },

  // Asia / Pacific
  IN: { timezone: 'Asia/Kolkata', label: 'India' },
  JP: { timezone: 'Asia/Tokyo', label: 'Japan' },
  KR: { timezone: 'Asia/Seoul', label: 'South Korea' },
  CN: { timezone: 'Asia/Shanghai', label: 'China' },
  HK: { timezone: 'Asia/Hong_Kong', label: 'Hong Kong' },
  SG: { timezone: 'Asia/Singapore', label: 'Singapore' },
  TH: { timezone: 'Asia/Bangkok', label: 'Thailand' },
  ID: { timezone: 'Asia/Jakarta', label: 'Indonesia' },
  MY: { timezone: 'Asia/Kuala_Lumpur', label: 'Malaysia' },
  PH: { timezone: 'Asia/Manila', label: 'the Philippines' },
  VN: { timezone: 'Asia/Ho_Chi_Minh', label: 'Vietnam' },
  AU: { timezone: 'Australia/Sydney', label: 'Australia' },
  NZ: { timezone: 'Pacific/Auckland', label: 'New Zealand' },

  // Africa
  ZA: { timezone: 'Africa/Johannesburg', label: 'South Africa' },
  EG: { timezone: 'Africa/Cairo', label: 'Egypt' },
  MA: { timezone: 'Africa/Casablanca', label: 'Morocco' },
  NG: { timezone: 'Africa/Lagos', label: 'Nigeria' },
  KE: { timezone: 'Africa/Nairobi', label: 'Kenya' },
};

export type PhoneTimezoneInference = {
  timezone: string;
  label: string;
};

/**
 * Infer a likely IANA timezone from a WhatsApp phone identifier.
 *
 * `externalId` may be E.164 with or without a leading `+` (Kapso webhooks
 * usually deliver it without). Returns `null` when:
 *   - the input can't be parsed as a phone number,
 *   - the country isn't in our map (treat as "we don't know — ask").
 */
export function inferTimezoneFromPhone(
  externalId: string | null | undefined,
): PhoneTimezoneInference | null {
  if (!externalId) return null;
  const trimmed = String(externalId).trim();
  if (!trimmed) return null;

  const candidate = trimmed.startsWith('+') ? trimmed : `+${trimmed.replace(/^\+/, '')}`;
  const parsed = parsePhoneNumberFromString(candidate);
  if (!parsed?.country) return null;

  const entry = COUNTRY_TO_TIMEZONE[parsed.country];
  if (!entry) return null;
  return { timezone: entry.timezone, label: entry.label };
}
