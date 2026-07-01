/**
 * Maps an ISO country code (from proxy IP geo) to a BCP-47 locale, used when a
 * profile opts into language: 'base-on-ip'. Camoufox itself drives the actual
 * fingerprint at the engine level — this only feeds the locale it should claim.
 */
export function languageForCountry(country?: string): string | undefined {
  if (!country) return undefined;
  const map: Record<string, string> = {
    VN: 'vi-VN',
    US: 'en-US',
    GB: 'en-GB',
    JP: 'ja-JP',
    KR: 'ko-KR',
    CN: 'zh-CN',
    TH: 'th-TH',
    FR: 'fr-FR',
    DE: 'de-DE',
  };
  return map[country.toUpperCase()];
}
