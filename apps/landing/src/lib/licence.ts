import { FREE_TEAM_SIZE } from './site';

// THE COMMERCIAL LICENCE: who sells it, what it costs, where to buy it. ONE place, read by
// the pricing page, the home page's tiers, the contact page and the licence docs page —
// never type a price anywhere else.
//
// A licence is per ORGANISATION (affiliates counted together), priced by how many people in
// it use Ensemble, the count the buyer declares. Free stays at FREE_TEAM_SIZE or fewer.
// Prices are per year, in GBP, before VAT.

/** The company that sells the commercial licence. */
export const VENDOR_NAME = 'Corevo Systems Limited';
/** Companies House details. A UK company must show its name, number, place of registration
 *  and registered office on its website: VENDOR_LEGAL_LINE carries all four, and the footer,
 *  pricing, trust and legal pages show it. */
export const VENDOR_COMPANY_NUMBER = '16638768';
export const VENDOR_REGISTERED_IN = 'England and Wales';
export const VENDOR_REGISTERED_OFFICE = 'Mansion House, Manchester Road, Altrincham, Cheshire, WA14 4RW';
export const VENDOR_LEGAL_LINE = `${VENDOR_NAME}, registered in ${VENDOR_REGISTERED_IN}, company number ${VENDOR_COMPANY_NUMBER}. Registered office: ${VENDOR_REGISTERED_OFFICE}.`;

export interface LicenceBand {
  /** The largest number of people using Ensemble that this band covers. */
  upTo: number;
  /** GBP per year, before VAT. */
  priceGbp: number;
  /** The Polar checkout link for this band. Empty until the product exists in Polar: the
   *  button then asks for the licence through the contact form instead. */
  checkoutUrl: string;
}

export const LICENCE_BANDS: readonly LicenceBand[] = [
  { upTo: 10, priceGbp: 600, checkoutUrl: '' },
  { upTo: 25, priceGbp: 1200, checkoutUrl: '' },
  { upTo: 50, priceGbp: 2400, checkoutUrl: '' },
];

/** Above the largest band, the licence is agreed by message. */
export const LARGEST_BAND = LICENCE_BANDS[LICENCE_BANDS.length - 1]!.upTo;

export const LOWEST_PRICE_GBP = LICENCE_BANDS[0]!.priceGbp;

export const formatGbp = (n: number): string => `£${n.toLocaleString('en-GB')}`;

/** "4 to 10 people", "11 to 25 people", … */
export function bandLabel(i: number): string {
  const from = i === 0 ? FREE_TEAM_SIZE + 1 : LICENCE_BANDS[i - 1]!.upTo + 1;
  return `${from} to ${LICENCE_BANDS[i]!.upTo} people`;
}

/** Where a band's button goes: the checkout when it exists, else the contact form. */
export function bandHref(i: number): string {
  const band = LICENCE_BANDS[i]!;
  return band.checkoutUrl !== '' ? band.checkoutUrl : `/contact?topic=licence`;
}
