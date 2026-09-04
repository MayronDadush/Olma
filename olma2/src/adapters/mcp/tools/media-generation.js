'use strict';
// media generation — one slice of the tool registry (see ../registry.js).
const {
  users, media, S, tool,
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
    'Create an image with an AI image model. LIMITED ACCESS: most users are refused by the server — '
    + 'NEVER offer, mention or suggest this feature on your own; use it only when the user themselves '
    + 'explicitly asks for an image to be created, and if refused, say plainly it is not available for them. '
    + 'Write the prompt as one rich, specific English description of the desired image (subject, style, '
    + 'lighting, composition) — translate the user\'s request, do not pass their raw words. This tool only '
    + 'STARTS the generation: it is usually ready well under a minute and the finished image is sent to '
    + 'the user automatically as a separate message — tell them it is on its way, and never call this '
    + 'again for the same request.',
    { prompt: S('string', 'English description of the image to generate (max 2000 chars)') }, ['prompt'],
    (client, user, a) => media.startImage(client, user, { prompt: a.prompt })),
  tool('generate_video',
    'Create a short video (4-15 seconds) with an AI video model. LIMITED ACCESS: most users are refused '
    + 'by the server — NEVER offer, mention or suggest this feature on your own; use it only when the user '
    + 'themselves explicitly asks for a video, and if refused, say plainly it is not available for them. '
    + 'Write the prompt as one rich, specific English description of the scene and motion. Leave resolution '
    + 'unset — it defaults to the cheapest tier (480p) — and only pass 720p when the user explicitly asked '
    + 'for higher quality. This tool only STARTS the generation: it takes 1-2 minutes and the finished video '
    + 'is sent to the user automatically as a separate message — tell them it is on its way, and never call '
    + 'this again for the same request.',
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
