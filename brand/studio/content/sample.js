// The first content file, and the example for every one after it.
// A content file is one idea in three formats; any of the three may be left out.
//
//   layout  'statement' | 'chat' | 'closing'
//   theme   'sand' | 'cypress'        (a closing slide is cypress unless it says otherwise)
//   lines   the headline, ONE ENTRY PER LINE — the breaks are the copy, nothing wraps
//           *word*  the one word that matters (mustard on cypress, a mustard bar on sand)
//   sub     one sentence under it
//   chat    [{ from: 'me' | 'her', text, time }]   **bold** and \n inside a bubble
//   size    headline size in vw, if the default is wrong for this copy
//
// Voice (brand book, 09): she speaks in the first person, to nobody's gender,
// ends with a full stop, and uses at most one emoji, first, saying what kind of thing it is.
window.CONTENT = {
  lang: 'he',
  post: {
    layout: 'statement', theme: 'sand',
    lines: ['כותבים לי הכל.', 'אני עושה *סדר*.'],
    sub: 'ומזכירה בזמן. בוואטסאפ, בלי להתקין כלום.',
  },
  story: {
    layout: 'chat', theme: 'cypress',
    lines: ['ארבעה אנשים,', 'תאריך *אחד*.'],
    chat: [
      { from: 'me', text: 'תסגרי לנו פאדל השבוע עם דנה, רועי ונועם', time: '12:03' },
      { from: 'her', text: 'שאלתי את שלושתם. חמישי 20:00 מתאים לכולם.', time: '12:40' },
      { from: 'her', text: '🎾 סגור. חמישי 20:00, ארבעה על המגרש.', time: '12:41' },
    ],
  },
  carousel: [
    { layout: 'statement', theme: 'cypress', lines: ['שלושה דברים', 'שאני עושה', '*בשבילכם*.'] },
    { layout: 'chat', lines: ['1 · כותבים לי הכל.'],
      chat: [{ from: 'me', text: 'צריך לחדש דרכון, יום הולדת לאמא ביום שלישי, להתקשר לאינסטלטור ולשלם ארנונה עד סוף החודש' }] },
    { layout: 'chat', lines: ['2 · אני *מסדרת*.'],
      chat: [{ from: 'her', text: 'סידרתי:\n**🏠 בית**\n• להתקשר לאינסטלטור\n• לשלם ארנונה · עד סוף החודש\n**👪 משפחה**\n• יום הולדת לאמא · שלישי\n**📋 סידורים**\n• לחדש דרכון' }] },
    { layout: 'chat', lines: ['3 · ומזכירה *בזמן*.'],
      chat: [{ from: 'her', text: '⏰ להתקשר לאינסטלטור. היום 17:00.', time: '16:45' }] },
    { layout: 'closing', sub: 'כתבו לי בוואטסאפ.' },
  ],
};
