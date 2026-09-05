'use strict';
// media generation — one slice of the tool registry (see ../registry.js).
const {
  media, S, tool,
} = require('./_shared');

module.exports = [
  // Access-limited (admins + an allowlisted phone) — the server refuses
  // everyone else, so the doctrine for most users is simply: never offer it.
  // The prompt travels to OpenRouter as-is; the file lands in the caller's
  // own workspace, inside the same MEDIA: boundary as schedule cards. Both
  // tools only START the job — an image model spends a variable, sometimes
  // large amount of time per prompt (observed 11-30s+ live), well past what
  // a single tool call can safely wait on, so images are delivered later by
  // the sweep exactly like videos.
  tool('generate_image',
    'Create an AI image. LIMITED ACCESS: most users are refused — never offer or mention it; use it only when they explicitly ask, and if refused say plainly it is not available for them. Prompt: one rich, specific English description (subject, style, lighting, composition). This only STARTS the job: the image arrives as a separate message within about a minute — say it is on its way, never call again for the same request.',
    { prompt: S('string', 'English description of the image to generate (max 2000 chars)') }, ['prompt'],
    (client, user, a) => media.startImage(client, user, { prompt: a.prompt })),
  tool('generate_video',
    'Create a short AI video (4-15 s). LIMITED ACCESS: most users are refused — never offer or mention it; use it only when they explicitly ask, and if refused say plainly it is not available for them. Prompt: one rich, specific English description of scene and motion; leave resolution unset unless they asked for higher quality. This only STARTS the job: the video arrives as a separate message in 1-2 minutes — say it is on its way, never call again.',
    {
      prompt: S('string', 'English description of the video scene and motion (max 2000 chars)'),
      duration_seconds: S('number', 'Length in seconds, integer 4-15. Default 5.'),
      resolution: S('string', 'One of: ' + media.VIDEO_RESOLUTIONS.join(', ') + '. Default 480p (cheapest) — set 720p ONLY if the user explicitly asked for better quality.'),
      aspect_ratio: S('string', 'One of: ' + media.VIDEO_ASPECTS.join(', ') + '. Default 16:9 (9:16 suits phones).'),
    }, ['prompt'],
    (client, user, a) => media.startVideo(client, user, {
      prompt: a.prompt, duration_seconds: a.duration_seconds, resolution: a.resolution, aspect_ratio: a.aspect_ratio,
    })),
];
