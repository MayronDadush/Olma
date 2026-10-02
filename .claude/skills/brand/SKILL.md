---
name: brand
description: "Work on עולמה / Allma's brand and marketing with the owner: videos, posts, stories, carousels, reels, copy, the brand book. Knows the Cypress + Mustard decisions, the voice rules, the studio that renders scenes to MP4/PNG, where finished files are kept, and the owner's approval process. Use for anything about the brand, marketing, a video, a post, or the logo."
---

<!-- Frontmatter is name + description only, like deploy-triage: those are the two
     keys proved to load on this machine. -->

# The brand, and how we work on it

This is the owner's working space for the brand. He is the only user. **He decides,
and you propose**: show options, wait for his pick, and never send anything to a real
person or post it anywhere.

## Read first, every time

- `brand/README.md` holds **the decisions** (palette, font, mark, texture, voice,
  motion) with their dates, plus what is live and what is still open. It is the
  source of truth. If anything below disagrees with it, the README wins, and you fix
  this file.
- `brand/pages/book-cypress/` is the brand book. Chapter 09 is humour and chapter 13
  is the voice in the product.
- Memory pages `olma-brand-*` and `olma-reel-process-*` hold the owner's latest picks
  and his process.

## The short version of the decisions (28.9–30.9.2026)

| | |
|---|---|
| Cypress `#004643` | Brand surface: video cards, header band |
| Sand `#F0EDE5` | Paper, and text on cypress |
| Mustard `#F9C23C` | The 10%: the highlighted line, the main action, the mark's lens |
| Ink `#0E1F1E` | Text on sand |
| Font | IBM Plex Sans Hebrew / IBM Plex Sans, 500 and 700 (700 is the maximum in Hebrew) |
| Mark | Split in half (cypress and sand) with a mustard lens. Motion: "the meeting", 1.1s (`studio/motion.js`) |
| Grain | Only on posters, stories and video cards. **Under the letters, never on them** |
| Voice | First person in marketing, gender-neutral, one emoji per line, at most one "!", times written as "חמישי 20:00" |
| WhatsApp mock | Keeps **WhatsApp's own** colours and system font, no grain. Ours is only the avatar and the frame around it |

## The studio: everything is rendered from HTML

```
node brand/studio/render.js <scene.html[?query]> <out.mp4|.png> [--fps 30] [--size 1080x1080] [--at ms] [--crf 16]
```

- A scene defines `window.__seek(ms)` and `window.__ms`. Each frame is a Chrome
  screenshot, and ffmpeg assembles them. **One render at a time**: they share port 9334.
- `--crf 28` is the size that goes out on WhatsApp/Instagram, and `--crf 16` is the
  master.
- `--at <ms> --size 540x540` renders a single still. Check stills at the key moments
  before rendering a full video, then make a contact sheet of the result:
  `ffmpeg -i x.mp4 -vf "fps=1,scale=270:-1,tile=6x3" -frames:v 1 sheet.png`.
  (`drawtext` does not exist in this Mac's ffmpeg.)
- `make.js <content>` renders every format of a content file (post, story,
  carousel). See `studio/content/sample.js`.

**Scenes** (`brand/studio/scenes/`):

| scene | what | query |
|---|---|---|
| `intro.html` | The intro video: "הראש מלא בדברים?", a full message, then she sorts it | `?lang=he\|en` |
| `group.html` | Groups: tagged in the group, asks privately, closes in the group | `?tr=carousel\|cube\|finger\|push\|sheet\|zoom` |
| `ads.html` | The short ads: reminders ("שוב שכחת?"), coffee with Dana (1:1 coordination), the morning picture | `?ad=reminder\|coffee\|morning&lang=he\|en` |
| `closing.html` | The closing card of every video | |
| `template.html` | Post / story / carousel from a content file | `?c=<content>&fmt=…` |

**For a new scene, copy the nearest existing one.** The pattern: a cypress opener with
the byline "עולמה · בוואטסאפ שלך", a WhatsApp mock, and a closer with the "meet" motion
in which the lines rise in and the second line is mustard.

## Where the finished files go

- **Scene sources** stay in the repo (`brand/studio/scenes/`), so every video can be
  rebuilt.
- **Finished videos and images** go in `~/Olma-brand/` (not in git: they are binary and
  can be rebuilt):
  `~/Olma-brand/videos/<topic>/<name>-<variant>-<lang>.mp4`, with older versions in
  `old-design/` next to it.
- **Sending "as a gif" on WhatsApp = the mp4 with `--gif-playback`** (owner's pick 2.10, of 4 options tried on his phone). It autoplays and loops, and it is half the size of a real .gif. The real .gif below is only for places other than WhatsApp.
- A **GIF** of a video (for anywhere but WhatsApp): `ffmpeg -i x.mp4 -vf "fps=15,scale=540:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" x.gif`
  (540px, 15fps — the 26.9 library's size).
- `brand/studio/out/` is a temporary output folder and is gitignored.
- Send a finished file to the owner with SendUserFile, and say where it is stored.

## The owner's process

- **A reel / an ad:** script → storyboard (a frame per beat) → **his approval** →
  3 variations of each image → he picks → only then the animation and the final video.
  Never render a final cut, or run a paid generation, before he says yes.
- **Every reel's end card** shows that you can save her as a WhatsApp contact, and the
  number (`WA_NUMBER` in `olma2/src/adapters/http/public-pages.js`).
- **AI generation** (images and video) goes through the bot's OpenRouter key on the
  box. Check the credit first. See memory `olma-brand-ai-generation`.
- **A remake** of an existing video keeps its story, words and timing, and changes
  only the look.
- **Nothing goes out to people**: no intro video or post is sent until he says so in
  so many words.

## When something is decided

Write the decision to `brand/README.md` with its date, in the same session. A decision
that lives only in a transcript gets lost (it has happened: memory
`olma-design-work-lives-only-in-transcripts`). `brand/` is not watched by CI, so a PR
merges with no checks, and that is fine: it never reaches the server.
