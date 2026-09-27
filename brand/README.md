# המותג של עולמה / Allma

כל עבודת המותג, בתיקייה אחת. זה לא קוד של המוצר ולא עולה לשרת. `olma2/` לא נוגע בזה, וה־CI של הדיפלוי לא מסתכל כאן.

## מה הוחלט (27.9.2026)

| | החלטה |
|---|---|
| **פונט** | IBM Plex Sans Hebrew לעברית, IBM Plex Sans לאנגלית. המשקל המקסימלי בעברית הוא 700. |
| **סימן** | **חצי־חצי**: ריבוע שחצי שלו חושך וחצי אור. כל עיגול בצבע ההפוך לצד שלו, והמפגש ביניהם בצבע שלישי, על הקו. יש גרסה בעיגול לתמונת פרופיל ולאייקונים, וגרסה עם תנועה לפתיח של סרטון. |
| **צבעים** | מערכת אחת שמשתנה לפי השעה: **יום** אלמוג על דיו (`#221C3A` / `#F7F1E6` / `#FF8A6B`, ורקע פוסטר `#F2553A`), **לילה** סגול חשמלי (`#16122E` / `#EDEAFB` / `#7C6CF2`), **שבת** נר (`#1D1530` / `#F3E9D8` / `#F2C46D`). |
| **שפה גרפית** | **חפיפה**: אותיות ענקיות, ובמקום שהן חופפות רואים את הרקע. **חצי־חצי כסדרה**: ע · ול · מה. |
| **בלי ירוק** | ירוק הוא הצבע של וואטסאפ. |

## מה עוד פתוח
- **טקסטורה.** ההמלצה: גרעין נייר עדין על האיורים, ו"דיו שחוק" רק באותיות ענקיות. לא על ממשק, לא על אייקונים, ולא בתוך וואטסאפ.
- **חקירה של צבעים נועזים יותר**, שנפתחה אחרי ההחלטות למעלה. היא יכולה להחליף את הפלטה.
- **באיזה כלי עורכים סרטונים ופוסטים.** התבניות תלויות בזה.
- **הכנסת המותג למוצר:** תמונת הפרופיל, כרטיס הבוקר (`olma2/src/domain/schedule-card.js`, עדיין בפלטה הישנה), allma.world והדאשבורד.

## מה יש כאן
- `pages/` — מקורות העמודים, לפי הסדר שבו נבנו:
  1. `olma-brand-board.html` — לוח הכיוונים הראשון.
  2. `allma-brand-guide.html` — ערכת המותג 1.0.
  3. `olma-brand-platform.html` — הרעיון: "עולמה סוגרת מעגלים".
  4. `olma-brand-book.html` — ספר המותג v2, עם העדשה.
  5. `olma-mark-round2.html` — סבב 2. נפסל: סימנים של אותיות בקו דק.
  6. `olma-mark-round3.html` — סבב 3. מכאן הגיעו חצי־חצי והחפיפה.
  7. `olma-lab.html` — המעבדה: בחירה בזוגות.
  8. `olma-in-use.html` — המותג שנבחר, בשימוש.
  9. `olma-intro-videos-new-brand.html` — סרטוני ההיכרות במותג החדש. האווטאר בהם עדיין זמני.
- `tools/` — מחוללים:
  - `build_kit.py`: קבצי צבע (ASE, JSON, CSS), רקעים וגרעין. מריצים עם `uv run --with numpy --with pillow python build_kit.py`.
  - `marks2.js`, `sheet2.js`, `gen_page.js`: הסבב השני.
- `pages/bold-colors/` — מחקר הצבעים הנועזים (27.9): שבע פלטות על הדאשבורד האמיתי, עם צילומים ב־`img/`. עדיין פתוח.
- `pages/moodboards/` — לוח השראה לכל אחת מחמש הפלטות, עם צהוב כצבע ה־10 (28.9).
- `tools/dashboard-preview/` — צובע את `/me` האמיתי בפלטה חדשה ומצלם אותו. מריצים את `olma2/scripts/demo-dashboard.js` על פורט 8791, ואז `node proxy.js` על 8792, ואז `node shoot.js http://localhost:8792/d/<קישור> <תיקייה>`. זה מקומי בלבד ולא נוגע בקוד של olma2.
- `tokens/` — הצבעים של ערכה 1.0 (לפני ההחלטה על שלוש השעות).

## קישורים (פרטיים לבעלים)
- ערכה 1.0: https://claude.ai/artifact/NpUMcWFpqoNXixjKVFVvk6
- פלטפורמה: https://claude.ai/artifact/HJoU5H6NqRuTK2CdhpwBa8
- ספר מותג v2: https://claude.ai/artifact/Jz5UsGsCyq6X2MRaNRNjws
- סבב 2: https://claude.ai/artifact/KLu8cUzKx5bgJnUkPWRdyN
- סבב 3: https://claude.ai/artifact/5oKBBkWKD31VSdTDUYSVQu
- מעבדה: https://claude.ai/artifact/LH1pr4k84UDjuPARPv7bGi
- בשימוש: https://claude.ai/artifact/3REiPXE9qhYVX9z6HKQNfE
- סרטונים במותג החדש: https://claude.ai/artifact/SAaigPfT7QnxLFutyA93aC
- צבעים נועזים: https://claude.ai/artifact/8L5VVHmpcqgKgKrx2wnZ8w
- לוחות השראה: https://claude.ai/artifact/TiZ3xLLUCn4rKAP4Jbkh7c
