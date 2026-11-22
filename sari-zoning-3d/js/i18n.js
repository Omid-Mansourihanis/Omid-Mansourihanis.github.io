// Language support: the Persian page (index.html) and the English page (en/index.html)
// share the same data and code. The language comes from <html lang="...">.
export const LANG = document.documentElement.lang === 'en' ? 'en' : 'fa';
const EN = LANG === 'en';

/** Number in the page language (Persian digits on the Persian page). */
export const fmt = (n, d = 1) => Number(n).toLocaleString(EN ? 'en-US' : 'fa-IR', { maximumFractionDigits: d });

/** Pick the English field of a data object when the page is English (name -> name_en, ...). */
export const tx = (obj, key) => (EN && obj && obj[key + '_en'] != null ? obj[key + '_en'] : obj ? obj[key] : '');

const STR = {
  fa: {
    pct: '٪', m: 'م', m2: 'م²', area: (v) => `${v} م²`,
    none: 'ندارد', sbVal: (v) => `${v} م`,
    sides: { N: 'شمال', S: 'جنوب', E: 'شرق', W: 'غرب' },
    north: 'شمال',
    kCoverage: 'حداکثر سطح اشغال', kFloors: 'حداکثر طبقات', kFar: 'حداکثر تراکم',
    rArea: 'رده مساحت (نصاب تفکیک)', rAreaVal: (l) => `${l} مترمربع`,
    rRoad: 'رده عرض معبر', rOrient: 'موقعیت قطعه',
    rLot: 'مساحت و ابعاد قطعه', rLotVal: (a, f, d) => `${a} م² (بَر ${f} × عمق ${d})`,
    rCovArea: 'سطح اشغال مجاز در این قطعه', rGfa: 'زیربنای کل مجاز (تراکم × مساحت)',
    rGfaRange: 'زیربنای کل در ابتدای / انتهای بازه', rCovRange: 'سطح اشغال در ابتدای / انتهای بازه',
    rSbNS: 'عقب‌نشینی از شمال / جنوب', rSbEW: 'عقب‌نشینی از شرق / غرب',
    rHeight: 'ارتفاع تقریبی', rHeightVal: (h, l, fh) => `${h} م (${l} تراز × ${fh} م)`,
    rTotalH: 'ارتفاع کل تقریبی', rTotalHVal: (h) => `${h} م`,
    rAnchor: 'محل استقرار توده', rAnchorVal: (s) => `چسبیده به ضلع ${s}`,
    rDelta: 'تفاضل با رده معبر قبلی',
    rDeltaVal: (far, fl, cov) => `تراکم ${far} · طبقات ${fl} · سطح اشغال ${cov}`,
    nLimited: (part, eff) => `با این ابعاد، عقب‌نشینی‌ها اجازه نمی‌دهند کل سطح اشغال مجاز${part ? ` (${part})` : ''} استفاده شود؛ سطح اشغال قابل‌ساخت ≈ ${eff}٪ است. بَر یا عمق قطعه را تغییر دهید.`,
    nFrac: 'تعداد طبقات اعشاری در جدول برابر «تراکم ÷ سطح اشغال» است. کسر طبقه به‌صورت بخشی از تراز آخر (کم‌رنگ‌تر) نمایش داده شده است.',
    nM6: 'در M6 فرض شده است که طبقات «بنای اصلی» روی پودیوم قرار می‌گیرند و عقب‌نشینی‌های بنای اصلی جداگانه اعمال می‌شود. اگر منظور جدول این است که طبقات بنای اصلی شامل پودیوم است، این فرض را در کد اصلاح کنید.',
    nSmall: (min) => `مساحت این قطعه از حداقل نصاب تفکیک جدید (${min} م²) کمتر است؛ این حالت فقط برای قطعات تفکیک‌شدهٔ موجود معنا دارد.`,
    loadFail: 'فایل داده بارگذاری نشد. صفحه را از طریق یک وب‌سرور (مثلاً GitHub Pages) باز کنید، نه با دوبار کلیک روی فایل.',
    copied: 'لینک کپی شد', copyPrompt: 'این لینک را کپی کنید:',
    // 3D labels
    lRoad: (w) => `معبر ${w} متری`, lSetback: (v) => `عقب‌نشینی ${v} م`, lNoSetback: 'بدون عقب‌نشینی از بَر معبر',
    lFront: (v) => `بَر: ${v} م`, lDepth: (v) => `عمق: ${v} م`, lFrac: (v) => `${v} طبقه`,
    lFloors: (name, fl, h) => `${name}${fl} طبقه — ارتفاع ≈ ${h} م`,
  },
  en: {
    pct: '%', m: 'm', m2: 'm²', area: (v) => `${v} m²`,
    none: 'none', sbVal: (v) => `${v} m`,
    sides: { N: 'north', S: 'south', E: 'east', W: 'west' },
    north: 'North',
    kCoverage: 'Max. lot coverage', kFloors: 'Max. floors', kFar: 'Max. FAR',
    rArea: 'Lot-size class', rAreaVal: (l) => l,
    rRoad: 'Street-width class', rOrient: 'Lot position',
    rLot: 'Lot area and size', rLotVal: (a, f, d) => `${a} m² (frontage ${f} × depth ${d} m)`,
    rCovArea: 'Allowed footprint on this lot', rGfa: 'Allowed total floor area (FAR × lot area)',
    rGfaRange: 'Total floor area at the start / end of the class', rCovRange: 'Footprint at the start / end of the class',
    rSbNS: 'Setback from north / south edge', rSbEW: 'Setback from east / west edge',
    rHeight: 'Approximate height', rHeightVal: (h, l, fh) => `${h} m (${l} levels × ${fh} m)`,
    rTotalH: 'Approximate total height', rTotalHVal: (h) => `${h} m`,
    rAnchor: 'Building placed against', rAnchorVal: (s) => `the ${s} edge`,
    rDelta: 'Change from the previous street class',
    rDeltaVal: (far, fl, cov) => `FAR ${far} · floors ${fl} · coverage ${cov}`,
    nLimited: (part, eff) => `With these lot dimensions the setbacks leave too little room for the full allowed coverage${part ? ` (${part})` : ''}: about ${eff}% can be built. Try a different frontage or depth.`,
    nFrac: 'Fractional floor counts in the table equal FAR ÷ coverage. The fraction is drawn as part of the top level, in a lighter colour (for example, 2.5 floors = two full floors plus half of a third).',
    nM6: 'For M6 the tool assumes the main building (tower) stands on top of the podium, with its own setbacks. If the table means the tower floors include the podium, this assumption would change.',
    nSmall: (min) => `This lot is smaller than the minimum lot size for new subdivisions (${min} m²), so the rules apply only to lots that already exist.`,
    loadFail: 'The data file could not be loaded. Open the page from a web server (for example GitHub Pages), not by double-clicking the file.',
    copied: 'Link copied', copyPrompt: 'Copy this link:',
    lRoad: (w) => `${w} m street`, lSetback: (v) => `setback ${v} m`, lNoSetback: 'no setback on the street side',
    lFront: (v) => `frontage ${v} m`, lDepth: (v) => `depth ${v} m`, lFrac: (v) => `${v} floor`,
    lFloors: (name, fl, h) => `${name}${fl} floors · height ≈ ${h} m`,
  },
};
export const T = STR[LANG];
