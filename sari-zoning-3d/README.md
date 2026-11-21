# نمایشگر سه‌بعدی ضوابط ساختمانی — طرح تفصیلی شهر ساری (آلترناتیو A)

**Live:** https://omid-mansourihanis.github.io/sari-zoning-3d/

> **English summary.** An interactive 3D viewer of the building rules I designed, compiled and proposed in 2019 for the
> detailed plan of Sari, Mazandaran (Alternative A), while working at Sari Municipality as urban-planning expert and head
> of the spatial database. Pick a zone, sub-zone, lot-size class (minimum subdivision), street width and the lot's
> position relative to the street to see, schematically in 3D, the allowed coverage, floors, floor-area ratio, setbacks,
> buildable envelope and total floor area. All 50 rows (48 R and M rows plus the two M6 rows) were checked against the original table.
> The rules are **proposed, not adopted**. — *Omid Mansourihanis*


ابزار وب تعاملی که کاربر با انتخاب **پهنه ← خرده‌پهنه ← مساحت قطعه (رده نصاب تفکیک) ← عرض معبر ← موقعیت قطعه نسبت به معبر**، ضوابط حاکم بر قطعه خود را به‌صورت **سه‌بعدی و شماتیک** می‌بیند: سطح اشغال، تعداد طبقات، تراکم، عقب‌نشینی‌ها، پاکت حجمی مجاز و زیربنای کل.

> ⚠️ داده‌ها از جدول «پیشنهاد ضوابط استفاده از اراضی و چگونگی ساخت‌وساز در پهنه‌ها، خرده‌پهنه‌ها و قطعات در طرح تفصیلی شهر ساری — آلترناتیو A» (۲۰۱۹) گرفته شده و **پیشنهادی** است، نه ضابطهٔ مصوب.

## ویژگی‌ها
- انتخاب مرحله‌ای (آبشاری) با پنج گام؛ هر گام فقط گزینه‌های معتبر گام قبل را نشان می‌دهد.
- نمایش سه‌بعدی با Three.js: قطعه، معبر با عرض واقعی، قطعات همجوار، نوارهای عقب‌نشینی، پاکت حجمی مجاز، توده با تفکیک طبقات، کسر طبقه (مثلاً ۲٫۵ طبقه)، پودیوم و برج در M6.
- عقب‌نشینی‌ها بر اساس ستون‌های «قطعه شمالی/جنوبی/شرقی/غربی» جدول اعمال می‌شود.
- محاسبه برای **مساحت دقیق** قطعه (اسلایدر)، بَر و عمق دلخواه، ارتفاع طبقه قابل تنظیم.
- هشدار وقتی عقب‌نشینی‌ها اجازهٔ استفاده از کل سطح اشغال را نمی‌دهند.
- نمایش «تفاضل با رده معبر قبلی» (همان ستون‌های تفاضل جدول).
- لینک قابل‌اشتراک برای هر حالت (`#z=R&s=R2&...`) و دانلود تصویر.
- راست‌به‌چپ، فونت وزیرمتن، سازگار با موبایل.
- **بدون مرحلهٔ build و بدون وابستگی به CDN**: three.js و فونت داخل مخزن قرار دارند.

## ساختار پوشه‌ها
```
├── index.html                      صفحهٔ اصلی (RTL)
├── css/style.css
├── js/
│   ├── main.js                     رابط کاربری، وضعیت، لینک اشتراک
│   ├── scene.js                    صحنهٔ سه‌بعدی (Three.js)
│   └── geometry.js                 محاسبات هندسی خالص (قابل تست با Node)
├── data/zoning-sari-alt-A.json     ★ تمام ضوابط جدول — منبع اصلی داده
├── vendor/                         three.js r170 + OrbitControls + CSS2DRenderer
├── fonts/                          وزیرمتن (OFL)
```

## نسخهٔ آنلاین
https://omid-mansourihanis.github.io/sari-zoning-3d/

این ابزار در پوشهٔ `sari-zoning-3d/` مخزن سایت قرار دارد و با GitHub Pages منتشر می‌شود.

## اجرای محلی
مرورگرها فایل JSON را با `file://` بارگذاری نمی‌کنند؛ یک وب‌سرور ساده لازم است:
```bash
python -m http.server 8000
# سپس: http://localhost:8000
```

## ساختار داده (`data/zoning-sari-alt-A.json`)
```jsonc
{
  "zones": [{
    "id": "R", "name": "سکونت (R)", "color": "#f4c542",
    "subzones": [{
      "id": "R2", "name": "مسکونی با تراکم متوسط",
      "codes": ["R2"],                 // کدهای خرده‌پهنه که این ضوابط را دارند
      "minNewSubdivision": 300,         // حداقل نصاب تفکیک جدید (اختیاری)
      "areaClasses": [{
        "label": "۳۰۰ تا کمتر از ۵۰۰", "min": 300, "max": 500,   // max=null یعنی «و بیشتر»
        "roads": [{
          "label": "۱۲ تا کمتر از ۱۶ متر", "min": 12, "max": 16,
          "parts": [{                    // یک بخش؛ در M6 دو بخش: پودیوم و برج
            "name": "بنا", "far": 316, "floors": 5.5, "coverage": 57.5,
            "setbacks": {                // دقیقاً مطابق ۱۶ ستون جدول؛ null یعنی «ندارد»
              "north": {"N": 4, "S": 3, "E": 0, "W": 0},
              "south": {"N": 3, "S": 4, "E": 0, "W": 0},
              "east":  {"N": 0, "S": 0, "E": 4, "W": 3},
              "west":  {"N": 0, "S": 0, "E": 3, "W": 4}
            }
          }]
        }]
      }]
    }]
  }]
}
```
- **قطعه شمالی** یعنی معبر در ضلع جنوبی قطعه است (و به همین ترتیب).
- برای افزودن **آلترناتیو B** یا ضوابط مصوب، یک فایل JSON دیگر با همین ساختار بسازید و `DATA_URL` را در `js/main.js` عوض کنید (یا یک انتخاب‌گر آلترناتیو اضافه کنید).

## فرض‌های ترسیم (قابل تغییر در کد)
| موضوع | فرض فعلی | محل تغییر |
|---|---|---|
| شکل قطعه | مستطیل؛ عمق پیش‌فرض = ۲ × بَر | `geometry.js → defaultFrontage` |
| ارتفاع طبقه | ۳٫۲ متر (قابل تغییر در رابط) | `index.html#floorH` |
| محل توده | شمالی‌سازی در قطعات شمالی/جنوبی؛ پشت قطعه در قطعات شرقی/غربی | `geometry.js → anchorSide` |
| عرض توده | کل عرض مجاز بین عقب‌نشینی‌های جانبی | `geometry.js → computeLayout` |
| طبقات اعشاری | کسر طبقه به‌صورت بخشی از تراز آخر | `geometry.js` (`frac`) |
| زیربنای کل | طبقات × سطح اشغال × مساحت (مثل ستون‌های زیربنای جدول؛ مثلاً ۳۱۶٫۲۵٪ نه ۳۱۶٪) | `geometry.js → gfaTable` |
| M6 | طبقات «بنای اصلی» روی پودیوم قرار می‌گیرد | `scene.js` / `geometry.js` (`baseY`) |

## مجوزها
- three.js: MIT (`vendor/THREE-LICENSE.txt`)
- وزیرمتن: SIL OFL 1.1 (`fonts/OFL.txt`)

## طراح جدول
طراحی، تدوین و پیشنهاد جدول ضوابط: **Omid Mansourihanis**، کارشناس شهرسازی و مسئول پایگاه داده‌های مکانی شهرداری ساری (۲۰۱۹).
